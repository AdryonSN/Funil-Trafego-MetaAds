# Funil de Tráfego — Meta Ads

Dashboard estática de funil de tráfego (Meta Ads), publicada no **GitHub Pages**.
Roda **100% na nuvem**: o GitHub Actions lê (somente leitura) a aba **Meta Ads** de
uma planilha Google via export CSV, gera `data.json` e publica o site.

## Como atualiza
- O build é disparado a cada **2 horas** pelo **cron-job.org**, que chama a API do
  GitHub (`repository_dispatch`, evento `refresh`).
- Há também um `schedule` de backup (a cada 2h) e `workflow_dispatch` (botão manual
  em *Actions*).
- Cada run roda `node build.js`, que:
  1. baixa o CSV da planilha (nunca escreve nela);
  2. monta o funil completo (Investimento → Impressões → Cliques → Page views →
     Checkouts iniciados → Vendas) com CPM, CTR, CPC, CAC, ROAS e taxas de passagem;
  3. injeta um `BUILD_ID` novo no `index.html` (cache-bust);
  4. publica `dist/` no Pages.

A página busca `data.json?v=BUILD_ID&t=<timestamp>` com `cache:"no-store"`, então
sempre carrega a versão mais nova.

## Arquivos
- `index.html` — a dashboard (template; `__BUILD_ID__` é trocado no build).
- `build.js` — leitor da planilha + gerador do `data.json` (Node 20, sem dependências).
- `.github/workflows/deploy.yml` — build + deploy no Pages.

## Observações
- Sem imposto e sem conversão de câmbio: todos os valores em R$, direto da planilha.
- Meta de investimento padrão: R$ 20.000 (editável na própria página).
- Régua de saúde = ponto de equilíbrio (ROAS 1,0x / teto de CAC = ticket médio).
