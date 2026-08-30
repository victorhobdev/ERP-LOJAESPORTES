# Progresso verificável da reconstrução

Atualizado em: 2026-08-30 (America/Sao_Paulo)

## Legenda

- `COMPLETO`: gate integralmente comprovado.
- `PARCIAL`: há entrega ou evidência, mas o gate ainda não foi satisfeito.
- `NAO_FEITO`: nenhuma evidência válida produzida.

## Diagnóstico inicial

- Branch de trabalho: `codex/reconstrucao-erp`, criada a partir de `098718a`.
- O repositório inicial contém o ERP Java/JavaFX legado e não contém monorepo Node, API HTTP, PostgreSQL, lockfile ou testes web.
- Mudanças preexistentes preservadas: `backups/` e `docs/` já estavam não rastreados antes da implementação.
- Node `v22.22.2`, npm `10.9.7`, pnpm `10.29.2`, Git `2.49.0` e Docker CLI `29.2.0` estão instalados.
- O daemon Docker não estava disponível no baseline; `psql` não estava no `PATH`.
- `database.sql` declara `gemini_erp`; o backup local `backups/gemini_teste_2026-08-27_19-02-05.sql` declara `gemini_teste`.
- O backup local foi inspecionado somente em metadados/schema: 8 tabelas, enum de compra sem `Cancelado` e tipos `Masculina`, `Feminina`, `Infantil`. Ele não foi tratado como produção e nenhum dado foi alterado.
- Arquivos locais de credenciais/tokens existem em caminhos ignorados pelo Git e não tiveram o conteúdo lido ou exposto.
- O legado continua intacto.

## Decisões confirmadas pelas fontes

- Produto lógico: clube + modelo; variante vendável: produto + tipo + tamanho, conforme os documentos 00–11. A referência legada permanece rastreável por ID de origem.
- Dinheiro será armazenado em `numeric` no PostgreSQL e transportado por string decimal/centavos, nunca por ponto flutuante.
- Datas de evento usam `timestamptz`; datas civis usam `date`; apresentação em `America/Sao_Paulo`.
- PostgreSQL será acessado somente pela API Fastify com queries parametrizadas.
- PWA é a distribuição inicial; Tauri permanece não aplicável enquanto não houver requisito nativo comprovado.
- Não serão introduzidos microserviços, Redux, GraphQL, SSR, Server Components ou Electron.

## Decisões externas ainda necessárias

1. Confirmar se a base real é `gemini_erp`, `gemini_teste` ou outra instância e fornecer uma cópia somente leitura de homologação.
2. Aprovar os fluxos reais e protótipos de PDV, Estoque, Compra e Início com o responsável da loja.
3. Definir requisitos reais de offline, impressão/dispositivos e número de usuários simultâneos.
4. Aprovar o conjunto oficial de estados de compra, incluindo o tratamento de `Cancelado`.
5. Definir o regime principal de faturamento: data da venda ou data do recebimento. O legado é divergente: a tela financeira soma vendas por data; o dashboard filtra vendas pagas.
6. Definir tratamento de clientes duplicados, “Consumidor Final”, vendas parcialmente pagas e trocas legadas sem histórico.
7. Aprovar política de retenção de backup e janela de corte/operação paralela.

Essas decisões impedem o gate final e a migração real, mas não impedem implementação e validação local com dados sintéticos claramente identificados.

## Blocos 0–6

| Bloco | Status | Evidência atual | Gate pendente |
| --- | --- | --- | --- |
| 0 — descoberta | `PARCIAL` | `AGENTS.md` fornecido na tarefa, documentos `00`–`11`, `ERP_REAL_CONTEXT.md`, `database.sql`, schema do backup local e regras críticas do legado foram lidos/confirmados. | Banco de produção, decisões operacionais/financeiras e aprovação do responsável. |
| 1 — experiência e fundação | `PARCIAL` | Monorepo pnpm, React/Vite/TanStack, Fastify, contratos Zod, tokens visuais, shell/protótipo de Início, health API, hash de senha, lint/tipos/testes/build e lockfile. | Protótipos de PDV/Estoque/Compra, teste de usabilidade/aprovação, sessão/RBAC e CI. |
| 2 — dados e estoque | `NAO_FEITO` | Nenhuma implementação nova no baseline. | Schema, estoque por movimentos, migrador e reconciliação verdes. |
| 3 — vendas | `NAO_FEITO` | Nenhuma implementação nova no baseline. | Fluxos, concorrência e idempotência verdes. |
| 4 — compras e encomendas | `NAO_FEITO` | Nenhuma implementação nova no baseline. | Recebimentos e timelines conciliados. |
| 5 — financeiro, catálogo e operação | `NAO_FEITO` | Nenhuma implementação nova no baseline. | Indicadores, catálogo, auditoria, backup/restauração e operação verdes. |
| 6 — migração e corte | `NAO_FEITO` | Nenhuma migração real executada. | Homologação determinística, treinamento, paralelo e aprovações de corte. |

## Evidência antes/depois — baseline

| Verificação | Antes | Depois esperado |
| --- | --- | --- |
| Instalação limpa | inexistente | lockfile e comando reproduzível |
| Lint/tipos/testes/build | inexistentes | todos verdes sem skips |
| Banco PostgreSQL isolado | indisponível | ambiente local reproduzível |
| API/web | inexistentes | inicialização documentada e health checks |
| Legado | presente e utilizável | preservado durante toda a reconstrução |

## Histórico de execução

### 2026-08-30 — início do Bloco 0

- Leitura integral concluída na ordem: instruções aplicáveis, `00-plano-mestre.md`, documentos `01`–`11`, `ERP_REAL_CONTEXT.md` e `database.sql`.
- Confirmações pontuais no legado: transações JDBC de venda/compra/recebimento, guarda de estoque, pagamento posterior, troca que sobrescreve item, fórmulas financeiras divergentes e uso de `Cancelado` ausente no enum do dump.
- Nenhuma credencial foi usada e nenhum banco foi alterado.
- Próximo passo seguro: iniciar o ciclo TDD da fundação do Bloco 1.

### 2026-08-30 — Bloco 1, checkpoint RED da fundação

- `pnpm install --frozen-lockfile=false`: concluído; lockfile criado. TypeScript foi ajustado de `7.0.2` para `6.0.3` antes do RED porque o parser do ESLint declara suporte `<6.1.0`.
- `pnpm test`: RED em `packages/contracts/src/contracts.test.ts` por implementação `src/index.ts` ausente.
- `pnpm --filter @erp/api test`: RED em `app.test.ts` e `password.test.ts` por implementações ausentes.
- `pnpm --filter @erp/web test`: RED em `App.test.tsx` por implementação ausente.
- Os runners iniciaram e resolveram as dependências; as falhas são compile-time RED causadas exclusivamente pelos comportamentos ainda não implementados.
- Próximo passo seguro: implementar apenas o necessário para tornar esses mesmos testes verdes.

### 2026-08-30 — Bloco 1, checkpoint GREEN da fundação

- `pnpm check`: PASS para ESLint, TypeScript estrito, 13 testes e builds de produção dos três workspaces.
- `pnpm test:coverage`: contratos 100%; web 100% do ciclo; API 88% statements, 80% branches, 85,71% functions e 91,3% lines.
- Build web: 147 módulos; JS 296,17 kB (94,51 kB gzip); CSS 10,86 kB (3,32 kB gzip).
- Falhas intermediárias corrigidas e revalidadas: deadlock do hook Fastify, limpeza de DOM de teste, emissão indevida do TypeScript e `rootDir` do build de contratos.
- Estado final comparado ao baseline: monorepo e runners agora existem e são reproduzíveis pelo lockfile; ainda não há banco, sessão, RBAC nem fluxos de domínio.
- Próximo passo seguro: novo ciclo RED para PostgreSQL, migrações, sessão e autorização inicial.

### 2026-08-30 — Bloco 1, checkpoint RED de autenticação e banco

- Docker Desktop iniciou processos locais, mas o daemon não respondeu. O serviço `com.docker.service` exige privilégio indisponível nesta sessão; nenhum container foi criado.
- `pnpm --filter @erp/api test`: RED válido para schema ausente, rejeição de saldo negativo, autorização e segredos de sessão/CSRF.
- PGlite foi adicionado apenas como pré-validação PostgreSQL em memória. O gate de integração com servidor real continua pendente e não será inferido deste teste.
- Próximo passo seguro: implementar o schema inicial e as primitivas mínimas de autenticação/RBAC, repetir os mesmos testes e manter o teste de servidor real em aberto.
