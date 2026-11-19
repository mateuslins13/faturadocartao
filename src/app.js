/* Análise e controle de fatura de cartão de crédito — UI, gráficos e ingestão. */
(function () {
  'use strict';

  const MESES_NOME = FaturaParser.MESES_NOME;
  const LS_THEME = 'fatura-cartao-tema';
  const LS_PASS = 'fatura-cartao-senha';

  const fmt = v => (v == null || isNaN(v) ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const fmtCompact = v => 'R$ ' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : v.toFixed(0));
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- Paleta de categorias ---------------- */
  const CORES = {
    'Supermercado': '#4a9eff', 'Restaurante': '#ff8f4a', 'Padaria': '#ffd24a',
    'Vestuário/Compras': '#c77dff', 'Saúde': '#3fd97f', 'Educação': '#ff5d8f',
    'Viagem': '#22d3ee', 'Combustível': '#fb7185', 'Eletrônicos': '#818cf8',
    'Lazer': '#a3e635', 'Serviços': '#94a3b8', 'Assinaturas': '#2dd4bf',
    'Pets': '#f0abfc', 'Transporte': '#60a5fa', 'Tarifas/Anuidade': '#78716c',
    'Outros': '#64748b',
  };
  const corDe = c => CORES[c] || '#64748b';

  /* ---------------- Estado ---------------- */
  let faturas = [];              // faturas extraídas com sucesso, em ordem de competência
  let arquivos = [];             // { nome, tamanho, origem, estado, msg, fatura, file }
  let sortParc = { k: 'quitacaoOrd', dir: 1 };
  let sortLanc = { k: 'valor', dir: -1 };
  let filtroCat = null;
  let pastaLabel = 'faturas/';
  let temServidor = false;
  let processando = false;
  const charts = {};

  /* ---------------- Senha (só a senha fica no navegador) ---------------- */
  function senhaSalva() {
    try { return sessionStorage.getItem(LS_PASS) || ''; } catch { return ''; }
  }
  function salvarSenha(v) {
    try { v ? sessionStorage.setItem(LS_PASS, v) : sessionStorage.removeItem(LS_PASS); } catch {}
  }

  /** Reordena as faturas válidas e deduplica pela competência (ano-mês). */
  function montarFaturas() {
    const porChave = new Map();
    for (const a of arquivos) {
      if (a.fatura) porChave.set(a.fatura.chave, a.fatura);
    }
    faturas = [...porChave.values()].sort((a, b) =>
      (a.ano - b.ano) || (a.mes - b.mes) || String(a.chave).localeCompare(String(b.chave)));
  }

  /* ---------------- Projeção de parcelas ---------------- */
  /**
   * A seção "Compras parceladas - próximas faturas" da última fatura lista
   * exatamente as parcelas que caem na PRÓXIMA fatura. Cada linha traz
   * parcelaAtual/parcelaTotal, então replicamos essa parcela mês a mês até
   * a última, gerando o cronograma completo dos meses seguintes.
   */
  function projetar(fatura) {
    if (!fatura) return { meses: [], itens: [] };
    const baseMes = fatura.mes, baseAno = fatura.ano;
    const meses = [];
    const itens = [];

    for (const p of fatura.parceladasFuturas) {
      if (!p.parcelaAtual || !p.parcelaTotal) continue;
      const restantes = p.parcelaTotal - p.parcelaAtual + 1;
      const total = +(p.valor * restantes).toFixed(2);
      // Mês/ano em que a compra é quitada (offset a partir da próxima fatura).
      const offQuit = restantes - 1;
      const dq = new Date(baseAno, (baseMes - 1) + 1 + offQuit, 1);
      itens.push({
        ...p,
        restantes,
        restante: total,
        quitacao: `${MESES_NOME[dq.getMonth()].slice(0, 3)}/${String(dq.getFullYear()).slice(2)}`,
        quitacaoOrd: dq.getFullYear() * 12 + dq.getMonth(),
      });
      for (let k = 0; k < restantes; k++) {
        const d = new Date(baseAno, (baseMes - 1) + 1 + k, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        let m = meses.find(x => x.key === key);
        if (!m) {
          m = {
            key, ord: d.getFullYear() * 12 + d.getMonth(),
            rotulo: `${MESES_NOME[d.getMonth()].slice(0, 3)}/${String(d.getFullYear()).slice(2)}`,
            total: 0, porCat: {}, itens: [],
          };
          meses.push(m);
        }
        m.total = +(m.total + p.valor).toFixed(2);
        m.porCat[p.categoria] = +((m.porCat[p.categoria] || 0) + p.valor).toFixed(2);
        m.itens.push(`${p.estabelecimento} ${p.parcelaAtual + k}/${p.parcelaTotal}`);
      }
    }
    meses.sort((a, b) => a.ord - b.ord);
    return { meses, itens };
  }

  /* ---------------- KPIs ---------------- */
  function renderKpis() {
    const ult = faturas[faturas.length - 1];
    const ant = faturas[faturas.length - 2];
    const proj = projetar(ult);
    const totais = faturas.map(f => f.total).filter(v => v != null);
    const media = totais.length ? totais.reduce((a, b) => a + b, 0) / totais.length : null;

    let deltaHtml = '';
    if (ult && ant && ult.total != null && ant.total != null && ant.total !== 0) {
      const d = ((ult.total - ant.total) / ant.total) * 100;
      const cls = d >= 0 ? 'up' : 'down';
      deltaHtml = `<div class="sub ${cls}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}% vs ${ant.nomeMes}</div>`;
    }

    const usoPct = ult && ult.limiteTotal ? (ult.limiteUtilizado / ult.limiteTotal) * 100 : null;
    const totalParc = proj.meses.reduce((a, m) => a + m.total, 0);

    const kpis = [
      {
        lbl: 'Última fatura' + (ult ? ` · ${ult.rotulo}` : ''),
        val: fmt(ult && ult.total), sub: ult ? `vence ${ult.vencimento}` : '', extra: deltaHtml, hl: true,
      },
      { lbl: 'Média das faturas', val: fmt(media), sub: `${totais.length} fatura(s) carregada(s)` },
      {
        lbl: 'Próxima fatura (parcelas)',
        val: fmt(proj.meses.length ? proj.meses[0].total : 0),
        sub: proj.meses.length ? `${proj.meses[0].rotulo} · já comprometido` : 'sem parcelas em aberto',
      },
      {
        lbl: 'Total a pagar parcelado',
        val: fmt(totalParc),
        sub: proj.meses.length ? `em ${proj.meses.length} fatura(s), até ${proj.meses[proj.meses.length - 1].rotulo}` : '—',
      },
      {
        lbl: 'Limite utilizado',
        val: usoPct == null ? '—' : usoPct.toFixed(1) + '%',
        sub: ult ? `${fmt(ult.limiteUtilizado)} de ${fmt(ult.limiteTotal)}` : '',
      },
      {
        lbl: 'Limite disponível', val: fmt(ult && ult.limiteDisponivel),
        sub: ult && ult.pagamentoMinimo != null ? `mínimo desta fatura ${fmt(ult.pagamentoMinimo)}` : '',
      },
    ];

    $('#kpis').innerHTML = kpis.map(k => `
      <div class="kpi${k.hl ? ' hl' : ''}">
        <div class="lbl">${esc(k.lbl)}</div>
        <div class="val">${k.val}</div>
        ${k.sub ? `<div class="sub">${esc(k.sub)}</div>` : ''}
        ${k.extra || ''}
      </div>`).join('');

    $('#periodo-info').textContent = faturas.length
      ? `${faturas.length} faturas · ${faturas[0].rotulo} a ${ult.rotulo}`
      : 'Nenhuma fatura carregada';
    $('#foot-info').textContent = ult
      ? `Última fatura processada: ${ult.arquivo} · emissão ${ult.emissao || '—'}`
      : '';
  }

  /* ---------------- Tema dos gráficos ---------------- */
  function chartTheme() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      txt: light ? '#41506b' : '#8b949e',
      grid: light ? 'rgba(16,24,40,.09)' : 'rgba(255,255,255,.07)',
      tipBg: light ? '#ffffff' : '#0d1117',
      tipTxt: light ? '#1a202c' : '#e6edf3',
      border: light ? '#dfe4ec' : '#30363d',
    };
  }

  /* ---------------- Gráfico 1: fatura por mês ---------------- */
  function renderMeses() {
    const t = chartTheme();
    const labels = faturas.map(f => f.rotulo);
    const dados = faturas.map(f => f.total || 0);
    const media = dados.length ? dados.reduce((a, b) => a + b, 0) / dados.length : 0;

    charts.meses?.destroy();
    charts.meses = new Chart($('#ch-meses'), {
      data: {
        labels,
        datasets: [
          {
            type: 'bar', label: 'Total da fatura', data: dados,
            backgroundColor: dados.map(v => v >= media ? 'rgba(74,158,255,.9)' : 'rgba(74,158,255,.5)'),
            borderColor: '#4a9eff', borderWidth: 1, borderRadius: 6, maxBarThickness: 62, order: 2,
          },
          {
            type: 'line', label: 'Média do período',
            data: dados.map(() => media), borderColor: '#ff8f4a', borderWidth: 1.5,
            borderDash: [5, 4], pointRadius: 0, fill: false, order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: t.txt, boxWidth: 12, font: { size: 11.5 } } },
          tooltip: {
            backgroundColor: t.tipBg, titleColor: t.tipTxt, bodyColor: t.tipTxt,
            borderColor: t.border, borderWidth: 1, padding: 11,
            callbacks: {
              label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}`,
              afterBody: items => {
                const f = faturas[items[0].dataIndex];
                if (!f) return '';
                const l = [];
                if (f.lancamentos) l.push(`${f.lancamentos.length} lançamentos`);
                if (f.pagamentoMinimo != null) l.push(`mínimo ${fmt(f.pagamentoMinimo)}`);
                if (f.vencimento) l.push(`vence ${f.vencimento}`);
                return '\n' + l.join('\n');
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: t.txt, font: { size: 11.5 } }, grid: { display: false } },
          y: {
            beginAtZero: true, ticks: { color: t.txt, font: { size: 11.5 }, callback: v => fmtCompact(v) },
            grid: { color: t.grid },
          },
        },
      },
    });
  }

  /* ---------------- Gráfico 2: categorias (pizza) ---------------- */
  function agregarCategorias(chave) {
    const alvo = chave === '__all__' ? faturas : faturas.filter(f => f.chave === chave);
    const acc = {};
    for (const f of alvo) {
      for (const l of (f.lancamentos || [])) {
        if (l.valor <= 0) continue;
        acc[l.categoria] = +((acc[l.categoria] || 0) + l.valor).toFixed(2);
      }
    }
    return Object.entries(acc).sort((a, b) => b[1] - a[1]);
  }

  function renderCategorias() {
    const t = chartTheme();
    const chave = $('#sel-mes').value;
    const pares = agregarCategorias(chave);
    const total = pares.reduce((a, b) => a + b[1], 0);

    charts.cat?.destroy();
    charts.cat = new Chart($('#ch-cat'), {
      type: 'doughnut',
      data: {
        labels: pares.map(p => p[0]),
        datasets: [{
          data: pares.map(p => p[1]),
          backgroundColor: pares.map(p => corDe(p[0])),
          borderColor: getComputedStyle(document.body).getPropertyValue('--bg-card').trim() || '#161b22',
          borderWidth: 2, hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '54%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: t.txt, boxWidth: 11, padding: 9, font: { size: 11.5 },
              generateLabels: ch => ch.data.labels.map((l, i) => {
                const v = ch.data.datasets[0].data[i];
                const pct = total ? (v / total * 100).toFixed(0) : 0;
                return {
                  text: `${l} · ${pct}%`, fillStyle: ch.data.datasets[0].backgroundColor[i],
                  strokeStyle: 'transparent', fontColor: t.txt, index: i,
                };
              }),
            },
          },
          tooltip: {
            backgroundColor: t.tipBg, titleColor: t.tipTxt, bodyColor: t.tipTxt,
            borderColor: t.border, borderWidth: 1, padding: 11,
            callbacks: {
              label: c => {
                const pct = total ? (c.parsed / total * 100).toFixed(1) : 0;
                return ` ${fmt(c.parsed)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  /* ---------------- Gráfico 3: parcelas futuras ---------------- */
  function renderParcelas() {
    const t = chartTheme();
    const ult = faturas[faturas.length - 1];
    const { meses } = projetar(ult);

    const cats = [...new Set(meses.flatMap(m => Object.keys(m.porCat)))]
      .sort((a, b) => {
        const sa = meses.reduce((s, m) => s + (m.porCat[a] || 0), 0);
        const sb = meses.reduce((s, m) => s + (m.porCat[b] || 0), 0);
        return sb - sa;
      });

    const totalGeral = meses.reduce((a, m) => a + m.total, 0);
    $('#hint-proj').textContent = meses.length
      ? `base: fatura de ${ult.rotulo} · ${fmt(totalGeral)} em ${meses.length} fatura(s)`
      : 'nenhuma parcela em aberto';

    charts.parc?.destroy();
    charts.parc = new Chart($('#ch-parc'), {
      type: 'bar',
      data: {
        labels: meses.map(m => m.rotulo),
        datasets: cats.map(c => ({
          label: c, data: meses.map(m => m.porCat[c] || 0),
          backgroundColor: corDe(c), borderWidth: 0, borderRadius: 3,
          maxBarThickness: 58, stack: 'p',
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: t.txt, boxWidth: 11, padding: 9, font: { size: 11.5 } } },
          tooltip: {
            backgroundColor: t.tipBg, titleColor: t.tipTxt, bodyColor: t.tipTxt,
            borderColor: t.border, borderWidth: 1, padding: 11,
            itemSort: (a, b) => b.parsed.y - a.parsed.y,
            filter: c => c.parsed.y > 0,
            callbacks: {
              label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`,
              footer: items => {
                const m = meses[items[0].dataIndex];
                return `\nTotal: ${fmt(m.total)}\n${m.itens.length} parcela(s)`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, ticks: { color: t.txt, font: { size: 11.5 } }, grid: { display: false } },
          y: {
            stacked: true, beginAtZero: true,
            ticks: { color: t.txt, font: { size: 11.5 }, callback: v => fmtCompact(v) },
            grid: { color: t.grid },
          },
        },
      },
    });
  }

  /* ---------------- Tabela de parcelados ---------------- */
  function renderTabelaParc() {
    const ult = faturas[faturas.length - 1];
    const { itens } = projetar(ult);
    const termo = $('#busca').value.trim().toLowerCase();

    let rows = itens.filter(i =>
      (!termo || i.estabelecimento.toLowerCase().includes(termo)) &&
      (!filtroCat || i.categoria === filtroCat));

    const { k, dir } = sortParc;
    rows.sort((a, b) => {
      let va = a[k], vb = b[k];
      if (k === 'data') {
        const p = s => s.split('/').reverse().join('');
        va = p(a.data); vb = p(b.data);
      }
      if (typeof va === 'string') return va.localeCompare(vb, 'pt-BR') * dir;
      return ((va ?? 0) - (vb ?? 0)) * dir;
    });

    const maxRest = Math.max(1, ...rows.map(r => r.restante));
    const tbody = $('#tbl-parc tbody');

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">Nenhuma compra parcelada encontrada${termo || filtroCat ? ' com esse filtro' : ''}.</div></td></tr>`;
      $('#tbl-parc tfoot').innerHTML = '';
    } else {
      tbody.innerHTML = rows.map(r => {
        const ultima = r.parcelaAtual === r.parcelaTotal;
        const pctPago = ((r.parcelaAtual - 1) / r.parcelaTotal) * 100;
        return `<tr>
          <td>${esc(r.data)}</td>
          <td class="estab">${esc(r.estabelecimento)}</td>
          <td><span class="tag" style="background:${corDe(r.categoria)}22;border-color:${corDe(r.categoria)}66;color:${corDe(r.categoria)}">${esc(r.categoria)}</span></td>
          <td><span class="pill${ultima ? ' last' : ''}">${r.parcelaAtual}/${r.parcelaTotal}</span></td>
          <td><div class="bar-mini" title="${pctPago.toFixed(0)}% já pago"><i style="width:${pctPago.toFixed(1)}%"></i></div></td>
          <td class="num">${fmt(r.valor)}</td>
          <td class="num"><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <span>${fmt(r.restante)}</span>
            <span class="bar-mini" style="width:44px"><i style="width:${(r.restante / maxRest * 100).toFixed(1)}%"></i></span>
          </div></td>
          <td>${esc(r.quitacao)}</td>
        </tr>`;
      }).join('');

      const somaMes = rows.reduce((a, r) => a + r.valor, 0);
      const somaRest = rows.reduce((a, r) => a + r.restante, 0);
      $('#tbl-parc tfoot').innerHTML = `<tr>
        <td colspan="5">${rows.length} compra(s) parcelada(s) em aberto</td>
        <td class="num">${fmt(somaMes)}</td>
        <td class="num">${fmt(somaRest)}</td>
        <td></td>
      </tr>`;
    }

    $('#hint-tbl').textContent = ult ? `posição da fatura de ${ult.rotulo}` : '';

    // chips de categoria
    const cats = [...new Set(itens.map(i => i.categoria))].sort();
    $('#chips-cat').innerHTML = cats.map(c =>
      `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${filtroCat === c}">${esc(c)}</button>`).join('');
  }

  /* ---------------- Tabela de lançamentos ---------------- */
  function renderTabelaLanc() {
    const chave = $('#sel-mes-l').value;
    const cat = $('#sel-cat-l').value;
    const termo = $('#busca-l').value.trim().toLowerCase();

    const alvo = chave === '__all__' ? faturas : faturas.filter(f => f.chave === chave);
    let rows = [];
    for (const f of alvo) {
      for (const l of (f.lancamentos || [])) {
        rows.push({ ...l, fatura: f.rotulo, _ord: (f.ano * 12 + f.mes) });
      }
    }
    rows = rows.filter(r =>
      (!termo || r.estabelecimento.toLowerCase().includes(termo)) &&
      (cat === '__all__' || r.categoria === cat));

    const { k, dir } = sortLanc;
    rows.sort((a, b) => {
      let va = a[k], vb = b[k];
      if (k === 'fatura') { va = a._ord; vb = b._ord; }
      if (k === 'data') {
        const p = s => s.split('/').reverse().join('');
        va = p(a.data); vb = p(b.data);
      }
      if (typeof va === 'string') return va.localeCompare(vb, 'pt-BR') * dir;
      return ((va ?? 0) - (vb ?? 0)) * dir;
    });

    const MAX = 400;
    const view = rows.slice(0, MAX);
    const tbody = $('#tbl-lanc tbody');

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty">Nenhum lançamento encontrado com esse filtro.</div></td></tr>`;
      $('#tbl-lanc tfoot').innerHTML = '';
    } else {
      tbody.innerHTML = view.map(r => `<tr>
        <td>${esc(r.fatura)}</td>
        <td>${esc(r.data)}</td>
        <td class="estab">${esc(r.estabelecimento)}</td>
        <td><span class="tag" style="background:${corDe(r.categoria)}22;border-color:${corDe(r.categoria)}66;color:${corDe(r.categoria)}">${esc(r.categoria)}</span></td>
        <td>${r.parcelaAtual ? `<span class="pill">${r.parcelaAtual}/${r.parcelaTotal}</span>` : '<span style="color:var(--txt-dim)">à vista</span>'}</td>
        <td class="num">${fmt(r.valor)}</td>
      </tr>`).join('');

      const soma = rows.reduce((a, r) => a + r.valor, 0);
      $('#tbl-lanc tfoot').innerHTML = `<tr>
        <td colspan="5">${rows.length} lançamento(s)${rows.length > MAX ? ` · exibindo os ${MAX} primeiros` : ''}</td>
        <td class="num">${fmt(soma)}</td>
      </tr>`;
    }
    $('#hint-lanc').textContent = `${rows.length} lançamento(s) no filtro atual`;
  }

  /* ---------------- Selects ---------------- */
  function preencherSelects() {
    const opts = ['<option value="__all__">Todas as faturas</option>']
      .concat(faturas.slice().reverse().map(f => `<option value="${esc(f.chave)}">${esc(f.rotulo)}</option>`));

    const s1 = $('#sel-mes'), s2 = $('#sel-mes-l'), s3 = $('#sel-cat-l');
    const v1 = s1.value, v2 = s2.value, v3 = s3.value;
    s1.innerHTML = opts.join('');
    s2.innerHTML = opts.join('');

    const ult = faturas[faturas.length - 1];
    s1.value = (v1 && [...s1.options].some(o => o.value === v1)) ? v1 : (ult ? ult.chave : '__all__');
    s2.value = (v2 && [...s2.options].some(o => o.value === v2)) ? v2 : (ult ? ult.chave : '__all__');

    const cats = [...new Set(faturas.flatMap(f => (f.lancamentos || []).map(l => l.categoria)))].sort();
    s3.innerHTML = ['<option value="__all__">Todas as categorias</option>']
      .concat(cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`)).join('');
    if (v3 && [...s3.options].some(o => o.value === v3)) s3.value = v3;
  }

  /* ---------------- Render geral ---------------- */
  function renderTudo() {
    montarFaturas();
    renderFontes();
    atualizarBotoes();

    // Sem nenhuma fatura válida, mostra as instruções em vez de gráficos vazios.
    const vazio = faturas.length === 0;
    $('#vazio').hidden = !vazio;
    $('#conteudo').hidden = vazio;

    if (vazio) {
      const pedindoSenha = arquivos.some(a => a.estado === 'senha');
      $('#periodo-info').textContent = pedindoSenha
        ? 'Faturas protegidas por senha'
        : 'Nenhuma fatura carregada';
      $('#vazio h2').textContent = pedindoSenha
        ? 'Os PDFs estão protegidos por senha'
        : 'Comece adicionando suas faturas';
      $('#foot-info').textContent = '';
      for (const c of Object.values(charts)) c?.destroy();
      return;
    }

    preencherSelects();
    renderKpis();
    renderMeses();
    renderCategorias();
    renderParcelas();
    renderTabelaParc();
    renderTabelaLanc();
  }

  function status(msg, tipo) {
    const el = $('#status');
    el.textContent = msg;
    el.className = 'show ' + (tipo || 'info');
    if (tipo === 'ok') setTimeout(() => { el.className = ''; }, 6000);
  }

  /* ---------------- Lista de arquivos (fontes) ---------------- */
  const ESTADOS = {
    pendente: { cls: 'wait', txt: 'na fila' },
    lendo:    { cls: 'load', txt: 'lendo…' },
    ok:       { cls: 'ok',   txt: 'processada' },
    senha:    { cls: 'err',  txt: 'senha necessária' },
    erro:     { cls: 'err',  txt: 'falhou' },
  };

  const kb = n => n == null ? '' : (n / 1024 < 900 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function renderFontes() {
    $('#pasta-info').textContent = temServidor ? pastaLabel : 'modo arquivo local — sem acesso à pasta';
    $('#fontes-titulo').textContent = arquivos.length
      ? `Faturas em PDF (${arquivos.length})`
      : 'Faturas em PDF';

    const okN = arquivos.filter(a => a.estado === 'ok').length;
    const falhaN = arquivos.filter(a => a.estado === 'senha' || a.estado === 'erro').length;
    $('#ctrl-hint').textContent = arquivos.length
      ? `${okN} processada(s)${falhaN ? ` · ${falhaN} com problema` : ''}`
      : (temServidor ? 'a pasta está vazia' : '');

    if (!arquivos.length) { $('#arq-list').innerHTML = ''; return; }

    $('#arq-list').innerHTML = arquivos.map((a, i) => {
      const e = ESTADOS[a.estado] || ESTADOS.pendente;
      const rot = a.fatura ? a.fatura.rotulo : '';
      return `<div class="arq">
        <span class="st ${e.cls}">${esc(e.txt)}</span>
        <span class="nm">${esc(a.nome)}</span>
        ${rot ? `<span class="sz">${esc(rot)}</span>` : ''}
        <span class="sz">${esc(kb(a.tamanho))}</span>
        ${a.msg ? `<span class="msg">${esc(a.msg)}</span>` : ''}
        <span class="push"></span>
        ${a.origem === 'pasta'
          ? `<button type="button" class="btn-x" data-rm="${i}" title="Mover para a lixeira da pasta">remover</button>`
          : `<button type="button" class="btn-x" data-rm="${i}" title="Tirar da análise">tirar</button>`}
      </div>`;
    }).join('');
  }

  /* ---------------- Extração de um PDF ---------------- */
  /**
   * Abre o PDF com o pdf.js e extrai a fatura. Toda a leitura acontece
   * no navegador; os bytes não saem da máquina.
   */
  async function extrair(bytes, nome, senha) {
    const doc = await pdfjsLib.getDocument({ data: bytes, password: senha }).promise;
    const fat = await FaturaParser.parseDoc(doc, nome);

    if (fat.total == null || !fat.vencimento) {
      throw Object.assign(new Error('não reconheci o formato desta fatura'), { leve: true });
    }
    // Conferência: a soma dos lançamentos precisa fechar com o total do cartão.
    if (fat.lancamentosNoCartao != null) {
      const soma = fat.lancamentos.reduce((a, b) => a + b.valor, 0);
      const dif = Math.abs(soma - fat.lancamentosNoCartao);
      if (dif > 0.05) fat.aviso = `conferência divergiu ${fmt(dif)}`;
    }
    return fat;
  }

  function ehErroSenha(e) {
    return !!e && (e.name === 'PasswordException'
      || e.code === 1 || e.code === 2
      || /password/i.test(e.message || ''));
  }

  /** Processa em sequência tudo que ainda não foi lido. */
  async function processarPendentes() {
    if (processando) return;
    const fila = arquivos.filter(a => a.estado === 'pendente');
    if (!fila.length) {
      renderTudo();
      status(arquivos.length ? 'Nada novo para processar.' : 'Nenhum PDF na pasta.', 'info');
      return;
    }

    processando = true;
    atualizarBotoes();
    const senha = $('#pdf-pass').value;
    salvarSenha(senha);

    let okN = 0, senhaN = 0, erroN = 0;
    for (const a of fila) {
      a.estado = 'lendo';
      a.msg = '';
      renderFontes();
      await new Promise(r => setTimeout(r, 0));   // deixa a UI pintar antes de travar no parse

      try {
        const bytes = await carregarBytes(a);
        const fat = await extrair(bytes, a.nome, senha);
        a.fatura = fat;
        a.estado = 'ok';
        a.msg = fat.aviso || '';
        okN++;
      } catch (e) {
        a.fatura = null;
        if (ehErroSenha(e)) {
          a.estado = 'senha';
          a.msg = senha ? 'a senha informada não abriu este PDF' : 'este PDF pede senha';
          senhaN++;
        } else {
          a.estado = 'erro';
          a.msg = e.message || 'falha ao ler o arquivo';
          erroN++;
        }
      }
      renderFontes();
    }

    processando = false;
    atualizarBotoes();
    renderTudo();

    const partes = [];
    if (okN) partes.push(`${okN} fatura(s) processada(s)`);
    if (senhaN) {
      partes.push($('#pdf-pass').value
        ? `${senhaN} não abriu com a senha informada — confira a senha e clique em Reprocessar`
        : `${senhaN} protegida(s) por senha — digite a senha acima e clique em Reprocessar`);
    }
    if (erroN) partes.push(`${erroN} com erro de leitura`);
    status(partes.join(' · '), (senhaN || erroN) ? (okN ? 'info' : 'err') : 'ok');
  }

  /** Bytes do PDF: do servidor (pasta) ou do File escolhido na hora. */
  async function carregarBytes(a) {
    if (a.origem === 'pasta') {
      const r = await fetch(`api/pdf?nome=${encodeURIComponent(a.nome)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`não consegui ler da pasta (HTTP ${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    }
    return new Uint8Array(await a.file.arrayBuffer());
  }

  /* ---------------- Sincronização com a pasta ---------------- */
  /**
   * Lê a lista de PDFs da pasta faturas/ via servidor local.
   * Sem servidor (abrindo o index.html direto), cai no modo manual.
   */
  async function sincronizarPasta() {
    try {
      const r = await fetch('api/faturas', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      temServidor = true;
      pastaLabel = data.pasta || 'faturas/';
      $('#vazio-pasta').textContent = pastaLabel;

      const daPasta = arquivos.filter(a => a.origem === 'pasta');
      const manuais = arquivos.filter(a => a.origem !== 'pasta');
      const novos = data.arquivos.map(f => {
        // Reaproveita o que já foi lido, se o arquivo não mudou em disco.
        const ant = daPasta.find(a => a.nome === f.nome && a.mtime === f.mtime && a.tamanho === f.tamanho);
        if (ant) return ant;
        return { nome: f.nome, tamanho: f.tamanho, mtime: f.mtime, origem: 'pasta', estado: 'pendente', msg: '', fatura: null };
      });
      arquivos = novos.concat(manuais);
      return true;
    } catch {
      temServidor = false;
      return false;
    }
  }

  /* ---------------- Ações do usuário ---------------- */
  /** PDFs escolhidos no seletor: grava na pasta se houver servidor. */
  async function adicionarArquivos(files) {
    const lista = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!lista.length) { status('Selecione arquivos PDF.', 'err'); return; }

    if (temServidor) {
      status(`Salvando ${lista.length} arquivo(s) na pasta…`, 'info');
      const falhas = [];
      for (const f of lista) {
        try {
          const r = await fetch(`api/upload?nome=${encodeURIComponent(f.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: await f.arrayBuffer(),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            falhas.push(`${f.name}: ${j.erro || `HTTP ${r.status}`}`);
          }
        } catch (e) {
          falhas.push(`${f.name}: ${e.message}`);
        }
      }
      if (falhas.length) status('Não salvei: ' + falhas.join(' · '), 'err');
      await sincronizarPasta();
    } else {
      // Sem servidor: os arquivos valem só para esta sessão da página.
      for (const f of lista) {
        const i = arquivos.findIndex(a => a.origem === 'manual' && a.nome === f.name);
        const item = { nome: f.name, tamanho: f.size, origem: 'manual', estado: 'pendente', msg: '', fatura: null, file: f };
        if (i >= 0) arquivos[i] = item; else arquivos.push(item);
      }
    }
    renderFontes();
    await processarPendentes();
  }

  /** Remove da análise; com servidor, move o PDF para faturas/.lixeira. */
  async function removerArquivo(i) {
    const a = arquivos[i];
    if (!a) return;

    if (a.origem === 'pasta') {
      if (!confirm(`Mover "${a.nome}" para a lixeira da pasta?\n\nO arquivo não é apagado: ele vai para faturas/.lixeira e pode ser restaurado à mão.`)) return;
      try {
        const r = await fetch(`api/pdf?nome=${encodeURIComponent(a.nome)}`, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          status(`Não removi: ${j.erro || `HTTP ${r.status}`}`, 'err');
          return;
        }
      } catch (e) {
        status('Não removi: ' + e.message, 'err');
        return;
      }
      await sincronizarPasta();
      status(`"${a.nome}" foi para faturas/.lixeira.`, 'ok');
    } else {
      arquivos.splice(i, 1);
      status(`"${a.nome}" saiu da análise.`, 'ok');
    }
    renderFontes();
    renderTudo();
  }

  /**
   * Relê a pasta e reprocessa tudo do zero.
   * É proposital reprocessar até o que já deu 'ok': a senha pode ter mudado,
   * e um arquivo pode ter sido substituído em disco pelo mesmo nome.
   */
  async function reprocessar() {
    if (processando) return;
    if (temServidor) {
      status('Relendo a pasta…', 'info');
      await sincronizarPasta();
    } else {
      status('Reprocessando arquivos…', 'info');
    }
    for (const a of arquivos) {
      a.estado = 'pendente';
      a.msg = '';
      a.fatura = null;
    }
    renderFontes();
    await processarPendentes();
  }

  function atualizarBotoes() {
    $('#btn-reload').disabled = processando;
    $('#btn-export').disabled = processando || !faturas.length;
  }

  /* ---------------- CSV ---------------- */
  function exportarCsv() {
    const linhas = [['fatura', 'vencimento', 'data', 'estabelecimento', 'categoria', 'parcela_atual', 'parcela_total', 'valor']];
    for (const f of faturas) {
      for (const l of (f.lancamentos || [])) {
        linhas.push([f.rotulo, f.vencimento || '', l.data, l.estabelecimento, l.categoria,
          l.parcelaAtual || '', l.parcelaTotal || '', String(l.valor).replace('.', ',')]);
      }
    }
    const csv = '﻿' + linhas.map(r =>
      r.map(c => /[";\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lancamentos-cartao.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ---------------- Eventos ---------------- */
  function ligarEventos() {
    $('#sel-mes').addEventListener('change', renderCategorias);
    $('#sel-mes-l').addEventListener('change', renderTabelaLanc);
    $('#sel-cat-l').addEventListener('change', renderTabelaLanc);

    let tb;
    $('#busca').addEventListener('input', () => { clearTimeout(tb); tb = setTimeout(renderTabelaParc, 140); });
    let tl;
    $('#busca-l').addEventListener('input', () => { clearTimeout(tl); tl = setTimeout(renderTabelaLanc, 140); });

    document.querySelectorAll('#tbl-parc thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        sortParc = { k, dir: sortParc.k === k ? -sortParc.dir : (['valor', 'restante'].includes(k) ? -1 : 1) };
        renderTabelaParc();
      });
    });
    document.querySelectorAll('#tbl-lanc thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        sortLanc = { k, dir: sortLanc.k === k ? -sortLanc.dir : (k === 'valor' ? -1 : 1) };
        renderTabelaLanc();
      });
    });

    $('#chips-cat').addEventListener('click', e => {
      const b = e.target.closest('.chip');
      if (!b) return;
      filtroCat = filtroCat === b.dataset.cat ? null : b.dataset.cat;
      renderTabelaParc();
    });

    // Arrastar PDFs para qualquer ponto do painel de fontes.
    const drop = $('#fontes');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', e => {
      if (e.dataTransfer?.files?.length) adicionarArquivos(e.dataTransfer.files);
    });
    $('#pdf-input').addEventListener('change', e => {
      if (e.target.files.length) adicionarArquivos(e.target.files);
      e.target.value = '';
    });

    $('#arq-list').addEventListener('click', e => {
      const b = e.target.closest('[data-rm]');
      if (b) removerArquivo(Number(b.dataset.rm));
    });

    // Enter no campo de senha já dispara o reprocessamento.
    $('#pdf-pass').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); reprocessar(); }
    });
    $('#pdf-pass').addEventListener('change', () => salvarSenha($('#pdf-pass').value));

    $('#btn-reload').addEventListener('click', reprocessar);
    $('#btn-export').addEventListener('click', exportarCsv);

    $('#btn-theme').addEventListener('click', () => {
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      const novo = light ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', novo);
      try { localStorage.setItem(LS_THEME, novo); } catch {}
      if (faturas.length) { renderMeses(); renderCategorias(); renderParcelas(); }
    });
  }

  /* ---------------- Boot ---------------- */
  async function boot() {
    try {
      const t = localStorage.getItem(LS_THEME);
      if (t) document.documentElement.setAttribute('data-theme', t);
    } catch {}

    // Worker do pdf.js embutido em base64 — mantém o arquivo único e offline.
    if (window.pdfjsLib && window.__PDF_WORKER_B64__) {
      try {
        const bin = atob(window.__PDF_WORKER_B64__);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
        pdfjsLib.GlobalWorkerOptions.workerSrc = url;
      } catch (e) {
        console.warn('worker pdf.js indisponível:', e);
      }
    }

    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    ligarEventos();

    $('#pdf-pass').value = senhaSalva();

    const comServidor = await sincronizarPasta();
    renderTudo();

    if (!comServidor) {
      if (location.protocol === 'file:') {
        $('#ctrl-hint').textContent = 'sem servidor local — use "+ Adicionar PDFs"';
        status('Aberto como arquivo local: não consigo ler a pasta faturas/. '
          + 'Use "+ Adicionar PDFs" (vale só nesta sessão) ou rode "npm start" para ler a pasta.', 'info');
      } else {
        $('#ctrl-hint').textContent = 'processamento 100% local no navegador — arraste ou clique em "+ Adicionar PDFs"';
      }
      return;
    }
    if (arquivos.length) await processarPendentes();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
