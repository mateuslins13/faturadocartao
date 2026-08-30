/**
 * Gera o index.html do painel.
 *
 * O arquivo sai sem nenhum dado pessoal: apenas a interface, o Chart.js,
 * o pdf.js e o parser. As faturas são lidas em tempo de execução, a partir
 * da pasta faturas/ (via server.mjs) ou dos PDFs escolhidos na tela.
 *
 * Uso: node build.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'index.html');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const faltando = [
  'src/template.html',
  'src/fatura-parser.js',
  'src/app.js',
  'node_modules/chart.js/dist/chart.umd.js',
  'node_modules/pdfjs-dist-legacy/build/pdf.min.js',
  'node_modules/pdfjs-dist-legacy/build/pdf.worker.min.js',
].filter(p => !fs.existsSync(path.join(ROOT, p)));

if (faltando.length) {
  console.error('Arquivos ausentes:\n  ' + faltando.join('\n  '));
  console.error('\nRode "npm install" antes de gerar o painel.');
  process.exit(1);
}

const chartjs = read('node_modules/chart.js/dist/chart.umd.js');
const pdfjsUmd = read('node_modules/pdfjs-dist-legacy/build/pdf.min.js');
const workerB64 = fs.readFileSync(
  path.join(ROOT, 'node_modules/pdfjs-dist-legacy/build/pdf.worker.min.js')).toString('base64');

// Fecha a tag para o HTML não terminar o script no meio de uma string.
const inline = (code, label) =>
  `<script>/* ${label} */\n` + code.replace(/<\/script>/gi, '<\\/script>') + '\n</script>';

const html = read('src/template.html')
  .replace('<script src="__CHARTJS__"></script>', inline(chartjs, 'Chart.js'))
  .replace('<script src="__PDFJS__"></script>', inline(pdfjsUmd, 'pdf.js'))
  .replace('<script src="__APP__"></script>',
    inline(read('src/fatura-parser.js'), 'parser') + '\n' + inline(read('src/app.js'), 'app'))
  .replace('__WORKER_B64__', workerB64);

// Rede de segurança: nenhum marcador pode sobrar sem substituição.
const restos = ['__CHARTJS__', '__PDFJS__', '__APP__', '__WORKER_B64__', '__DATA__']
  .filter(m => html.includes(m));
if (restos.length) {
  console.error('Marcador não substituído no template: ' + restos.join(', '));
  process.exit(1);
}

fs.writeFileSync(OUT, html, 'utf8');
console.log(`index.html gerado (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, sem dados pessoais)`);
console.log('Inicie o painel com: npm start');
