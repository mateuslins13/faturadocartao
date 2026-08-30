/**
 * Servidor local do painel de faturas.
 *
 * Existe por um motivo específico: um HTML aberto direto do disco (file://)
 * não pode listar o conteúdo de uma pasta nem gravar arquivos nela — o
 * navegador bloqueia por segurança. Este servidor faz essa ponte.
 *
 * Escuta apenas em 127.0.0.1, ou seja, só a sua máquina alcança. Não há
 * autenticação: qualquer programa rodando neste computador pode chamar a API.
 * Não exponha esta porta na rede nem troque o host sem colocar autenticação.
 *
 * Uso: node server.mjs [porta]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.join(ROOT, 'faturas');
const TRASH_DIR = path.join(PDF_DIR, '.lixeira');
const INDEX = path.join(ROOT, 'index.html');
const PORT = Number(process.argv[2] || process.env.PORT || 7801);
const HOST = '127.0.0.1';
const MAX_UPLOAD = 25 * 1024 * 1024;   // 25 MB por arquivo

fs.mkdirSync(PDF_DIR, { recursive: true });

/* ---------------- utilidades ---------------- */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

/** Só o nome do arquivo, sem caminho, sem "..", só .pdf. Evita path traversal. */
function nomeSeguro(bruto) {
  if (!bruto) return null;
  const base = path.basename(String(bruto).replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return null;
  if (base.startsWith('.')) return null;
  if (!/\.pdf$/i.test(base)) return null;
  if (/[<>:"|?*\x00-\x1f]/.test(base)) return null;
  return base;
}

/**
 * Casa o nome pedido com o que existe em disco.
 * O Windows pode gravar acentos em forma de composição diferente da que o
 * navegador envia ("Março" NFC vs NFD), então a comparação é normalizada.
 */
function resolverExistente(nome) {
  const alvo = nome.normalize('NFC').toLowerCase();
  for (const f of listarPdfs()) {
    if (f.normalize('NFC').toLowerCase() === alvo) return f;
  }
  return null;
}

function listarPdfs() {
  return fs.readdirSync(PDF_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && /\.pdf$/i.test(d.name) && !d.name.startsWith('.'))
    .map(d => d.name);
}

/** Nome livre na pasta: "Fatura.pdf" -> "Fatura (2).pdf" se já existir. */
function nomeLivre(nome) {
  if (!resolverExistente(nome)) return nome;
  const ext = path.extname(nome);
  const base = nome.slice(0, -ext.length);
  for (let i = 2; i < 500; i++) {
    const tent = `${base} (${i})${ext}`;
    if (!resolverExistente(tent)) return tent;
  }
  return `${base} (${Date.now()})${ext}`;
}

function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limite) {
        reject(Object.assign(new Error('arquivo maior que o limite'), { code: 413 }));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

/* ---------------- rotas ---------------- */

/** GET /api/faturas — lista os PDFs da pasta com assinatura para cache. */
function rotaListar(res) {
  const arquivos = listarPdfs().map(nome => {
    const st = fs.statSync(path.join(PDF_DIR, nome));
    return { nome, tamanho: st.size, mtime: Math.round(st.mtimeMs) };
  }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  json(res, 200, { pasta: PDF_DIR, arquivos });
}

/** GET /api/pdf?nome=... — devolve os bytes do PDF para o navegador processar. */
function rotaBaixar(res, nomePedido) {
  const seguro = nomeSeguro(nomePedido);
  const real = seguro && resolverExistente(seguro);
  if (!real) return json(res, 404, { erro: 'arquivo não encontrado' });

  const full = path.join(PDF_DIR, real);
  const st = fs.statSync(full);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

/** POST /api/upload?nome=... — grava o PDF enviado dentro da pasta faturas/. */
async function rotaUpload(req, res, nomePedido) {
  const seguro = nomeSeguro(nomePedido);
  if (!seguro) return json(res, 400, { erro: 'nome de arquivo inválido (esperado .pdf)' });

  let buf;
  try {
    buf = await lerCorpo(req, MAX_UPLOAD);
  } catch (e) {
    return json(res, e.code === 413 ? 413 : 400, { erro: e.message });
  }
  if (!buf.length) return json(res, 400, { erro: 'corpo vazio' });
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return json(res, 415, { erro: 'o conteúdo não é um PDF' });
  }

  const destino = nomeLivre(seguro);
  fs.writeFileSync(path.join(PDF_DIR, destino), buf);
  const st = fs.statSync(path.join(PDF_DIR, destino));
  json(res, 201, { nome: destino, tamanho: st.size, mtime: Math.round(st.mtimeMs) });
}

/**
 * DELETE /api/pdf?nome=... — move para faturas/.lixeira em vez de apagar,
 * para que uma remoção acidental possa ser desfeita à mão.
 */
function rotaRemover(res, nomePedido) {
  const seguro = nomeSeguro(nomePedido);
  const real = seguro && resolverExistente(seguro);
  if (!real) return json(res, 404, { erro: 'arquivo não encontrado' });

  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destino = path.join(TRASH_DIR, `${stamp} ${real}`);
  fs.renameSync(path.join(PDF_DIR, real), destino);
  json(res, 200, { nome: real, movidoPara: path.relative(ROOT, destino) });
}

function rotaIndex(res) {
  if (!fs.existsSync(INDEX)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html não encontrado. Rode: npm run build');
    return;
  }
  const buf = fs.readFileSync(INDEX);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

/* ---------------- servidor ---------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return json(res, 400, { erro: 'URL inválida' });
  }
  const rota = url.pathname;
  const nome = url.searchParams.get('nome');

  try {
    if (rota === '/api/faturas' && req.method === 'GET') return rotaListar(res);
    if (rota === '/api/pdf' && req.method === 'GET') return rotaBaixar(res, nome);
    if (rota === '/api/upload' && req.method === 'POST') return await rotaUpload(req, res, nome);
    if (rota === '/api/pdf' && req.method === 'DELETE') return rotaRemover(res, nome);
    if ((rota === '/' || rota === '/index.html') && req.method === 'GET') return rotaIndex(res);

    json(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    console.error('erro em', req.method, rota, '->', e.message);
    if (!res.headersSent) json(res, 500, { erro: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Painel de faturas em  http://${HOST}:${PORT}`);
  console.log(`PDFs lidos da pasta:  ${PDF_DIR}`);
  console.log('Encerre com Ctrl+C.');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Rode com outra: node server.mjs 7802`);
    process.exit(1);
  }
  throw e;
});
