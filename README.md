# Análise e Controle de Fatura de Cartão de Crédito

Painel local para acompanhar faturas de cartão de crédito a partir dos PDFs.
Mostra a evolução mês a mês, a divisão por tipo de compra, a projeção dos
parcelamentos nas faturas futuras e as tabelas detalhadas.

Os PDFs são lidos e processados **dentro do seu navegador**. Nenhum dado é
enviado para a internet, e nada de pessoal fica no repositório.

## Como usar

### Pela web (GitHub Pages)

O painel é compilado e publicado automaticamente no GitHub Pages a cada push na
branch `main` (via `.github/workflows/pages.yml`), sem nenhum dado pessoal.
Basta abrir a página, clicar em **+ Adicionar PDFs** (ou arrastar os arquivos)
e informar a senha dos PDFs, se houver. Os arquivos são processados
exclusivamente na memória do seu navegador e valem para a sessão atual.

### Localmente (com pasta `faturas/`)

```bash
npm install
npm run build
npm start
```

Abra `http://127.0.0.1:7801`.

O painel começa vazio. Para carregar as faturas:

1. Coloque os PDFs na pasta `faturas/` (ou use o botão **+ Adicionar PDFs**, que
   grava os arquivos nessa mesma pasta).
2. Se os PDFs forem protegidos, digite a senha de abertura no campo **Senha dos PDFs**.
   Faturas de banco em geral são protegidas — costuma ser algum dado do titular
   (parte do CPF, data de nascimento). Os arquivos que pedem senha aparecem
   marcados na lista.
3. Clique em **↻ Reprocessar**.

A análise considera apenas os PDFs presentes em `faturas/`. Para acrescentar a
fatura do mês seguinte, basta colocar o novo PDF ali e reprocessar.

## O que aparece

- **Fatura por mês** — barras com o total fechado de cada fatura e a média do período.
- **Gastos por tipo de compra** — rosca por categoria (supermercado, padaria,
  combustível, restaurante, saúde e outras), com filtro por fatura ou período inteiro.
- **Parcelamentos nas faturas futuras** — barras empilhadas por categoria mostrando
  quanto já está comprometido em cada fatura à frente.
- **Compras parceladas em aberto** — tabela com parcela atual, progresso, valor
  mensal, saldo a pagar e mês de quitação.
- **Todos os lançamentos** — tabela completa, com busca, filtros e ordenação.
- **CSV** — exporta os lançamentos consolidados.

## Estrutura

```
server.mjs      servidor local: lista a pasta, entrega e recebe PDFs
build.mjs       gera o index.html (interface + bibliotecas, sem dados)
src/
  template.html marcação e estilos
  app.js        gráficos, tabelas e ingestão dos PDFs
  fatura-parser.js  extração e categorização (roda no Node e no navegador)
faturas/        seus PDFs (ignorada pelo Git)
```

O `index.html` é gerado e também fica fora do Git. Rode `npm run build` depois de
clonar ou de alterar qualquer arquivo em `src/`.

## Sobre a senha

A senha é usada apenas para abrir os PDFs, na memória do navegador. Ela fica no
`sessionStorage`, ou seja, é esquecida quando você fecha a aba. Não é gravada em
disco nem enviada a nenhum servidor externo.

## Notas

- O servidor escuta somente em `127.0.0.1` e não tem autenticação: qualquer
  programa rodando na sua máquina pode acessar a API. Não exponha essa porta na rede.
- Ao remover uma fatura pelo painel, o PDF vai para `faturas/.lixeira` em vez de
  ser apagado, para permitir desfazer.
- Sem o servidor (abrindo o `index.html` direto do disco), o navegador não
  consegue ler a pasta. O botão **+ Adicionar PDFs** continua funcionando, mas
  vale só para aquela sessão.
- O parser foi escrito para o layout das faturas do Itaú (Azul Visa Infinite).
  Outros emissores provavelmente exigem ajustes em `src/fatura-parser.js`.
