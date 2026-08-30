/**
 * Parser das faturas do cartão Azul Visa Infinite (Itaú).
 * Funciona no Node (build) e no navegador (adição de novos PDFs),
 * recebendo sempre um documento já aberto pelo pdf.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaturaParser = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const COL_SPLIT = 340;           // divisor das duas colunas de lançamentos
  const MESES_NOME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const toNum = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));

  const LINHA_TX = /^(\d{2}\/\d{2})\s+(.+?)\s+(-?\d{1,3}(?:\.\d{3})*,\d{2})$/;
  const PARCELA = /\s(\d{1,2})\/(\d{1,2})$/;

  const CATEGORIAS_PDF = new Set([
    'supermercado', 'restaurante', 'vestuario', 'saude', 'health', 'educacao',
    'eletronicos', 'outros', 'viagem', 'lazer', 'servicos', 'combustivel',
    'supermarket', 'retail', 'hotel', 'transporte', 'farmacia', 'automotivo',
    'joalheria', 'diversao', 'livraria', 'material', 'educacion',
  ]);
  const isCategoria = t => CATEGORIAS_PDF.has(norm(t).split(/\s+/)[0]);

  /** Traduz o rótulo bruto do PDF para a categoria exibida. */
  const MAP_PDF = {
    supermercado: 'Supermercado', supermarket: 'Supermercado', restaurante: 'Restaurante',
    vestuario: 'Vestuário/Compras', retail: 'Vestuário/Compras', saude: 'Saúde',
    health: 'Saúde', farmacia: 'Saúde', educacao: 'Educação', educacion: 'Educação',
    livraria: 'Educação', eletronicos: 'Eletrônicos', viagem: 'Viagem', hotel: 'Viagem',
    lazer: 'Lazer', diversao: 'Lazer', servicos: 'Serviços', combustivel: 'Combustível',
    automotivo: 'Combustível', transporte: 'Transporte', outros: 'Outros',
  };

  /**
   * Classifica a compra pelo nome do estabelecimento, caindo para o
   * rótulo do próprio PDF quando não há regra específica.
   */
  function classificar(estab, catPdf) {
    const e = norm(estab);
    if (/padaria|panificadora|unipao|super pao|sonho doce|empadinha|emp barnabe|barnabe|alicetortas|confeitar|bolo|doceria/.test(e)) return 'Padaria';
    if (/posto |combust|ipiranga| shell|petrobras|auto posto|texaco|ale combu|juazeirinho/.test(e)) return 'Combustível';
    if (/supermercado|pao de acucar|sup tambau|hortifruti|bem mais|casa do sertao|assai|carrefour|atacad|mateus comercio|rei das carnes|conveniencia|mercadinho|mercado|edilmalourenco|marianoso|maria jose de andrade|gk comercio|magf comercio|its comercio|andredococo|viana comercio|hiper|frios/.test(e)) return 'Supermercado';
    if (/drogasil|drogaria|farmacia|nelfarma|unimed|odonto|dentista|laborat|hospital|clinica|saude|psicol|fisioter|exame/.test(e)) return 'Saúde';
    if (/netflix|spotify|microsoft|amazon prime|prime video|icloud|google|apple|brisanet|vivo|claro |tim |oi fibra|disney|hbo|max |youtube|openai|chatgpt|adobe/.test(e)) return 'Assinaturas';
    if (/restaurante|burger|sushi|grill|churrasc|pizza|cantina|boteco|chinatown|lapada|camarao|mangai|carne de sol|sea food|salutte|jim.com|delicat|cuscuz|point com|bburgers|escala fava|rodrigo navarro|ribeirao|bona s|sbgrill|ifd\*|bar do|cafe|lanche|espeto|acai|sorvete|pastel|comida|alimenta|umi |mp\*hagar/.test(e)) return 'Restaurante';
    if (/cinepolis|cinema|teatro|show|ingresso|park|lazer|ftb |clube |uci /.test(e)) return 'Lazer';
    if (/azul linhas|azul seguros|azulssbb|latam|gol |bancorbras|hotel|booking|airbnb|decolar|123milhas|viagem|pousada|maxmilhas/.test(e)) return 'Viagem';
    if (/riachuelo|renner|constance|inditex|zara|centauro|villa vogue|villavogue|c&a|decathlon|americanas|shopee|fisia|nike|adidas|hagarrus|bazar|magalu|b&r comerc|amazon|shein|calcad|vestuar|melissa|arezzo|hering/.test(e)) return 'Vestuário/Compras';
    if (/petz|thepets|pet shop|petshop|veterin/.test(e)) return 'Pets';
    if (/fcmpb|yazigi|livraria|escola|colegio|faculdade|curso|upeventos|matricula|educac|mensalidade - plano|uninass|afya/.test(e)) return 'Educação';
    if (/microtech|intelbras|compracerta|assetel|amazonmktplc|eletron|informatica|kabum|pichau|fast shop/.test(e)) return 'Eletrônicos';
    if (/uber|99app|99 |taxi|estacion|onibus|metro |bilhete/.test(e)) return 'Transporte';
    if (/beleza|barbearia|salao|agson|antoniodonascimen|manicure|lavanderia/.test(e)) return 'Serviços';
    if (/catedral|igreja|mag adm|condec|vindi|seguro|condomin/.test(e)) return 'Outros';
    return MAP_PDF[norm(catPdf || '').split(/\s+/)[0]] || 'Outros';
  }

  /** Reconstrói as linhas de uma página separando as duas colunas. */
  async function pageRows(page, pageNum) {
    const tc = await page.getTextContent();
    const buckets = new Map();
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5] * 10) / 10;
      const col = it.transform[4] < COL_SPLIT ? 0 : 1;
      const key = y + '|' + col;
      if (!buckets.has(key)) buckets.set(key, { y, col, items: [] });
      buckets.get(key).items.push({ x: it.transform[4], s: it.str });
    }
    const rows = [];
    for (const b of buckets.values()) {
      b.items.sort((a, c) => a.x - c.x);
      let txt = '', prevEnd = null;
      for (const it of b.items) {
        if (prevEnd !== null && it.x - prevEnd > 1.2) txt += ' ';
        txt += it.s;
        prevEnd = it.x + it.s.length * 4.2;
      }
      txt = txt.replace(/\s+/g, ' ').trim();
      if (txt) rows.push({ y: b.y, col: b.col, page: pageNum, text: txt });
    }
    // A fatura é lida coluna a coluna: toda a esquerda, depois toda a direita.
    rows.sort((a, b) => (a.col - b.col) || (b.y - a.y));
    return rows;
  }

  /** Extrai a fatura completa de um documento pdf.js já aberto. */
  async function parseDoc(doc, fileName) {
    const all = [];
    for (let p = 1; p <= doc.numPages; p++) {
      all.push(...await pageRows(await doc.getPage(p), p));
    }
    const joined = all.map(r => r.text).join('\n');
    const grab = re => { const m = joined.match(re); return m ? toNum(m[1]) : null; };

    const iParc = all.findIndex(r => /Compras parceladas\s*-\s*pr.{0,3}ximas faturas/i.test(r.text));
    const iProd = all.findIndex(r => /Lan.{0,3}amentos:\s*produtos e servi/i.test(r.text));
    const iProdFim = all.findIndex(r => /Lan.{0,3}amentos produtos e servi.{0,3}os\s+-?[\d.]+,\d{2}/i.test(r.text));

    const lancamentos = [], parceladasFuturas = [], produtosServicos = [];

    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      const m = r.text.match(LINHA_TX);
      if (!m) continue;
      if (/^PAGAMENTO/i.test(m[2])) continue;
      if (/^(Total|Lan.{0,3}amentos|Saldo|Pr.{0,3}xima|Demais|Limite|Juros|Multa|IOF|Valor|Encargos|%)/i.test(r.text)) continue;

      let estab = m[2].trim();
      const valor = toNum(m[3]);
      let parcelaAtual = null, parcelaTotal = null;
      const pm = estab.match(PARCELA);
      if (pm) {
        parcelaAtual = parseInt(pm[1], 10);
        parcelaTotal = parseInt(pm[2], 10);
        estab = estab.replace(PARCELA, '').trim();
      }

      // O rótulo de categoria vem na linha imediatamente abaixo, mesma coluna.
      let catPdf = null;
      for (let j = i + 1; j < Math.min(i + 3, all.length); j++) {
        const nx = all[j];
        if (nx.col !== r.col || nx.page !== r.page) break;
        if (isCategoria(nx.text)) { catPdf = nx.text.split(/\s+/)[0]; break; }
        if (LINHA_TX.test(nx.text)) break;
      }

      const rec = { data: m[1], estabelecimento: estab, valor, parcelaAtual, parcelaTotal };

      if (iParc >= 0 && i > iParc) {
        rec.categoria = classificar(estab, catPdf);
        parceladasFuturas.push(rec);
      } else if (iProd >= 0 && i > iProd && (iProdFim < 0 || i < iProdFim)) {
        rec.categoria = 'Tarifas/Anuidade';
        produtosServicos.push(rec);
      } else {
        rec.categoria = classificar(estab, catPdf);
        lancamentos.push(rec);
      }
    }

    const mv = joined.match(/Vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})/);
    const me = joined.match(/Emiss.{0,3}o:\s*(\d{2}\/\d{2}\/\d{4})/);
    const mes = mv ? parseInt(mv[2], 10) : null;
    const ano = mv ? parseInt(mv[3], 10) : null;

    return {
      arquivo: fileName,
      chave: mv ? `${ano}-${String(mes).padStart(2, '0')}` : fileName,
      mes, ano,
      nomeMes: mes ? MESES_NOME[mes - 1] : fileName,
      rotulo: mes ? `${MESES_NOME[mes - 1]}/${ano}` : fileName,
      vencimento: mv ? `${mv[1]}/${mv[2]}/${mv[3]}` : null,
      emissao: me ? me[1] : null,
      total: grab(/Total desta fatura\s+(-?[\d.]+,\d{2})/),
      faturaAnterior: grab(/Total da fatura anterior\s+(-?[\d.]+,\d{2})/),
      pagamentoAnterior: grab(/Pagamento efetuado em \d{2}\/\d{2}\/\d{4}\s+(-?[\d.]+,\d{2})/),
      lancamentosAtuais: grab(/Lan.{0,3}amentos atuais\s+(-?[\d.]+,\d{2})/),
      lancamentosNoCartao: grab(/Lan.{0,3}amentos no cart.{0,3}o\s+(-?[\d.]+,\d{2})/),
      pagamentoMinimo: grab(/Pagamento m.{0,3}nimo:\s*\n?R\$\s*([\d.]+,\d{2})/),
      limiteTotal: grab(/Limite total de cr.{0,3}dito\s+([\d.]+,\d{2})/),
      limiteDisponivel: grab(/Limite dispon.{0,3}vel\s+([\d.]+,\d{2})/),
      limiteUtilizado: grab(/Limite total utilizado\s+([\d.]+,\d{2})/),
      proximaFatura: grab(/Pr.{0,3}xima fatura\s+([\d.]+,\d{2})/),
      demaisFaturas: grab(/Demais faturas\s+([\d.]+,\d{2})/),
      totalProximasFaturas: grab(/Total para pr.{0,3}ximas faturas\s+([\d.]+,\d{2})/),
      lancamentos, parceladasFuturas, produtosServicos,
    };
  }

  return { parseDoc, classificar, MESES_NOME, toNum };
});
