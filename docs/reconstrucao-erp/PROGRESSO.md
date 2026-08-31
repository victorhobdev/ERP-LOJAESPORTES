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
| 1 — experiência e fundação | `PARCIAL` | Monorepo pnpm, React/Vite/TanStack, Fastify, contratos Zod, tokens visuais, shell/protótipo de Início, health API, sessão PostgreSQL, RBAC, CSRF/CORS/CSP/rate limit, lint/tipos/testes/build e lockfile. | Protótipos de PDV/Estoque/Compra, teste de usabilidade/aprovação e CI. |
| 2 — dados e estoque | `PARCIAL` | Schema inicial com 25 tabelas; produtos/variantes; leitura e ajuste de estoque; primeira versão do migrador de produtos com checksum, rejeições, rastreabilidade e reconciliação de `opening_balance`, validada em PostgreSQL 16 real. | Entrada por compra, demais origens de movimento e homologação contra fonte oficial. |
| 3 — vendas | `PARCIAL` | Criação paga/pendente, detalhe/lista, totais autoritativos, baixa, pagamentos posteriores e troca imutável; auditoria, idempotência por usuário e concorrência real verdes. | PDV, aprovação de diferença financeira da troca e E2E. |
| 4 — compras e encomendas | `PARCIAL` | Pedido realizado e detalhe; rateio de custo; recebimentos parciais idempotentes; custo médio, estoque, movimentos e concorrência conciliados. | Cancelamento após decisão oficial; encomendas e timeline. |
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

### 2026-08-30 — Bloco 1/2, checkpoint GREEN de autenticação e schema

- `pnpm --filter @erp/api test`: 5 arquivos e 9 testes PASS.
- `pnpm check`: PASS para lint, tipos, 19 testes totais e builds dos três workspaces.
- `pnpm test:coverage`: API 91,42% statements/85,71% branches; contratos e web 100% no escopo atual.
- `001_initial.sql` foi aplicado duas vezes no pré-validador e criou as 25 tabelas operacionais exigidas; tentativa de saldo negativo foi rejeitada pelo banco.
- Sessão/CSRF geram segredos independentes, persistem somente hashes; RBAC nega permissões ausentes e aceita wildcard administrativo.
- Estado final comparado ao RED: todos os quatro alvos ausentes agora estão implementados e verdes.
- Risco residual: PGlite não substitui PostgreSQL servidor; integração, transações e concorrência continuam sem evidência real enquanto o daemon Docker não responder.
- Próximo passo seguro: runner de migração/health do banco, endpoints de sessão e proteções HTTP, com teste de integração preparado para `TEST_DATABASE_URL`.

### 2026-08-30 — Bloco 2, checkpoint GREEN do servidor PostgreSQL

- Cluster PostgreSQL 16.14 descartável criado em WSL2, sem dados/credenciais reais; banco dedicado `erp2_test`, porta 55432.
- Runner aplica migrations em transação, grava SHA-256 em `schema_migrations`, rejeita alteração posterior do arquivo e não reaplica migration já registrada.
- Integração real: 2 testes PASS; primeira aplicação/segunda vazia e rollback comprovado por consulta posterior.
- Isolamento: cada execução usa schema aleatório `erp2_test_<uuid>` e o remove no teardown somente após confirmar o banco dedicado.
- Incidente corrigido: timeout padrão de 5 s durante a primeira inicialização/migração; inspeção objetiva confirmou conclusão, teste foi isolado e reexecutado com limite de 30 s, passando em ~9,6 s.
- `pnpm check`: permaneceu integralmente verde em paralelo ao teste PostgreSQL.
- Próximo passo seguro: endpoints de login/sessão/logout, cookies, CSRF, CORS, CSP, rate limit e health de prontidão com banco.

### 2026-08-30 — Bloco 1, checkpoint RED de autenticação HTTP

- Unitário RED: CSP e CORS esperados não existem no `buildApp` atual; 9 testes anteriores da API permanecem verdes.
- Integração RED: `POST /auth/login` retorna 404 para credencial inválida e válida, comprovando ausência das rotas.
- O teste de integração usa usuário sintético em schema aleatório e valida hash de sessão, cookie HttpOnly, permissões, CSRF e invalidação no banco.
- Incidente de runner corrigido antes de aceitar o RED: o teste de integração foi explicitamente excluído da suíte unitária sem `TEST_DATABASE_URL`.
- Próximo passo seguro: implementar plugins HTTP e as três rotas de autenticação com PostgreSQL.

### 2026-08-30 — Bloco 1, checkpoint GREEN de autenticação HTTP

- Login, sessão e logout persistidos no PostgreSQL; senha usa scrypt; tokens de sessão/CSRF persistem somente por SHA-256.
- Cookies de produção: sessão `HttpOnly`, ambos `Secure` e `SameSite=Strict`; logout limpa e invalida a sessão em transação auditada.
- CSP sem `unsafe-eval`/`unsafe-inline`, CORS por allowlist, erros sem detalhes internos e logs com cookie/token redigidos.
- Rate limit de login validado por integração. Primeira tentativa falhou porque o plugin estava em escopo Fastify incorreto; registro movido para o escopo das rotas e teste repetido com 429.
- `pnpm --filter @erp/api test:coverage:all`: 20 testes PASS, 93,38% statements, 93,22% branches, 100% functions, 93,75% lines.
- `pnpm check`: PASS para lint, tipos, 23 testes unitários totais e builds.
- Risco residual: limite atual é por IP em memória do processo; limite por usuário/armazenamento compartilhado será necessário antes de múltiplas instâncias.
- Próximo passo seguro: CI reproduzível e ciclo de produtos/estoque com transações, autorização e idempotência.

### 2026-08-30 — Bloco 2, checkpoint RED de produtos e estoque

- 4 testes de integração adicionados para autenticação, criação/agregação, duplicidade, ajuste auditado, idempotência, saldo insuficiente e concorrência.
- RED válido: todas as chamadas novas retornam 404 porque `/products` e `/inventory` ainda não existem; 7 testes anteriores de PostgreSQL/autenticação continuam verdes.
- Fixtures usam saldo e usuários exclusivamente sintéticos em schema descartável.
- Próximo passo seguro: implementar contratos, autenticação compartilhada e rotas transacionais mínimas para os mesmos testes.

### 2026-08-30 — Bloco 2, checkpoint GREEN de produtos e estoque

- Produtos lógicos e variantes foram implementados com chave de negócio case-insensitive, SKU único, dinheiro decimal por string e saldo inicial zero; leitura de lista/detalhe retorna variantes agregadas.
- Autenticação, RBAC e CSRF foram centralizados e aplicados às novas rotas; criação de produto e ajuste de estoque geram auditoria.
- Ajuste manual usa transação única, `SELECT ... FOR UPDATE`, guarda de saldo não negativo e chave de idempotência com hash do payload e resposta persistida.
- Concorrência real: duas baixas simultâneas de 4 sobre saldo 5 produziram 201/409 e saldo final 1; repetição idempotente manteve um movimento e uma auditoria.
- Revisão encontrou uma listagem ainda não exercitada; o novo teste reproduziu HTTP 500 por ordem inválida de cláusulas SQL, a consulta foi corrigida e o teste ficou verde.
- `pnpm --filter @erp/api test:integration`: 11 testes PASS em PostgreSQL 16; `pnpm check`: lint, tipos, 23 testes unitários e builds PASS.
- Cobertura integral da API: 24 testes PASS; 89,24% statements, 82,2% branches, 100% functions e 93,1% lines.
- Próximo passo seguro: ciclo TDD de migração determinística de produtos/estoque legado e relatório de reconciliação, sem usar dados reais até a fonte oficial ser confirmada.

### 2026-08-30 — Bloco 2, checkpoint RED do migrador de produtos

- Nova suíte PostgreSQL define importação de variantes reconciliadas, `opening_balance`, rastreabilidade por `legacy_id`, rejeições classificadas e reexecução idempotente do mesmo snapshot.
- RED válido: 11 testes anteriores PASS; apenas a nova suíte falha porque `legacy-products.js` ainda não existe.
- A fonte é uma coleção de fixtures sintéticas normalizadas. Nenhum backup ou banco MySQL foi lido, escrito ou inferido como produção.
- Próximo passo seguro: implementar a biblioteca transacional mínima e repetir exatamente a mesma suíte.

### 2026-08-30 — Bloco 2, checkpoint GREEN do migrador de produtos

- Biblioteca transacional recebe linhas normalizadas, valida sem corrigir silenciosamente, calcula checksum independente da ordem e deriva IDs/SKUs estáveis da origem.
- Variantes válidas preservam `legacy_id`; saldo inicial é inserido junto de `opening_balance`. No cenário sintético, saldo total 3 conciliou exatamente com movimentos 3.
- Linhas inválidas, duplicatas na origem e colisões no destino são classificadas em `migration_rejections`; cadastro pré-existente permaneceu inalterado.
- Reexecução do mesmo snapshot em ordem invertida reutilizou 1 `migration_run`, sem duplicar as 2 variantes nem o movimento.
- `pnpm --filter @erp/api test:integration`: 14 testes PASS em PostgreSQL 16; `pnpm check`: lint, tipos, 23 testes unitários e builds PASS.
- Cobertura integral da API: 27 testes PASS; 89,48% statements, 81,93% branches, 100% functions e 92,92% lines.
- Limite explícito: esta versão não lê MySQL e não foi executada contra backup real; homologação depende da confirmação da fonte oficial.
- Próximo passo seguro: completar a entrada de estoque pelo fluxo de recebimento de compras ou iniciar o ciclo de vendas, preservando o bloqueio da migração real.

### 2026-08-30 — Bloco 3, checkpoint RED de criação de venda

- Nova suíte define venda paga e pendente, totais autoritativos, detalhe agregado, idempotência, auditoria e concorrência do último item.
- RED válido: 14 testes anteriores PASS; os 4 novos testes falham com HTTP 404 porque `/sales` ainda não existe.
- Próximo passo seguro: implementar a transação mínima de criação/leitura e repetir os mesmos testes.

### 2026-08-30 — Bloco 3, checkpoint GREEN de criação de venda

- `POST /sales` valida sessão/permissão/CSRF, recalcula preço, custo, subtotal, desconto e total em centavos inteiros e persiste decimal no PostgreSQL.
- Venda, itens, pagamento inicial, baixas de estoque e auditoria são atômicos; variantes são bloqueadas em ordem determinística.
- Replay da mesma chave retorna a mesma resposta sem duplicar; chave com payload diferente retorna 409. O escopo inclui o usuário para impedir leitura cruzada de resposta cacheada.
- Venda pendente sem cliente/vencimento retorna 400; venda identificada permanece `pending` com saldo devido integral.
- Duas vendas simultâneas do último item produziram 201/409, uma única venda/movimento e saldo final zero.
- `pnpm --filter @erp/api test:integration`: 18 testes PASS em PostgreSQL 16; `pnpm check`: lint, tipos, 23 testes unitários e builds PASS.
- Cobertura integral da API: 31 testes PASS; 88,08% statements, 80,99% branches, 100% functions e 91,45% lines.
- Próximo passo seguro: ciclo TDD de pagamento posterior e histórico/listagem de vendas.

### 2026-08-30 — Bloco 3, checkpoint RED de pagamentos e histórico

- Novos cenários definem dois pagamentos append-only, replay idempotente, transição `pending` → `partially_paid` → `paid`, lista filtrada e concorrência sobre saldo devido.
- RED válido: 18 testes anteriores PASS; os 2 novos testes falham com HTTP 404 no endpoint de pagamento ainda ausente.
- Próximo passo seguro: implementar pagamento posterior com bloqueio da venda e listagem paginada mínima.

### 2026-08-30 — Bloco 3, checkpoint GREEN de pagamentos e histórico

- `POST /sales/:id/payments` bloqueia a venda, soma somente pagamentos confirmados e cria um novo registro; histórico anterior não é sobrescrito.
- Dois pagamentos levaram saldo 150,00 → 100,00 → 0,00 e estado `pending` → `partially_paid` → `paid`; replay não duplicou e chave alterada retornou 409.
- Duas cobranças simultâneas de 100,00 sobre saldo 150,00 produziram 201/409, um único pagamento confirmado e saldo devido 50,00.
- Pagamentos não movimentam estoque novamente; cada inclusão gera auditoria `sale.payment`.
- `GET /sales` filtra status e limita paginação a 100; detalhe existente passou a refletir pagamentos e saldo atuais.
- `pnpm --filter @erp/api test:integration`: 20 testes PASS em PostgreSQL 16; cobertura integral da API: 33 testes PASS, 88,12% statements, 80,76% branches, 100% functions e 91,54% lines.
- Próximo passo seguro: ciclo TDD de troca auditável com devolução/retirada atômicas e concorrência.

### 2026-08-30 — Bloco 3, checkpoint RED de trocas

- Novos cenários definem evento imutável, movimentos de entrada/saída, limite devolvido, replay e rollback concorrente quando falta o item entregue.
- RED válido: 20 testes anteriores PASS; os 2 novos testes falham com HTTP 404 no endpoint de troca ausente.
- Diferença financeira não será inventada: o contrato inicial exige quantidades iguais e a política monetária permanece uma decisão externa.
- Próximo passo seguro: implementar troca transacional e agregá-la ao detalhe da venda.

### 2026-08-30 — Bloco 3, checkpoint GREEN de trocas

- `POST /sales/:id/exchanges` cria entidade própria, itens `returned`/`delivered`, dois movimentos e auditoria sem alterar o item histórico da venda.
- Limite devolvido considera venda original menos trocas anteriores; replay idêntico não duplica e conteúdo diferente com a mesma chave retorna 409.
- Concorrência com uma única unidade para entrega produziu 201/409; a requisição rejeitada reverteu também sua devolução, preservando atomicidade.
- Detalhe da venda agora agrega trocas e respectivos snapshots de preço/custo.
- Como a política de diferença financeira não está aprovada, valores diferentes são rejeitados por `EXCHANGE_VALUE_MISMATCH`; nenhum crédito/cobrança implícito é criado.
- `pnpm --filter @erp/api test:integration`: 22 testes PASS em PostgreSQL 16; cobertura integral da API: 35 testes PASS, 88,03% statements, 80,13% branches, 100% functions e 91,23% lines.
- Próximo passo seguro: iniciar Bloco 4 com pedidos de compra e recebimentos parciais, mantendo PDV/E2E para o ciclo de frontend.

### 2026-08-30 — Bloco 4, checkpoint RED de compras

- Nova suíte define pedido realizado, cálculo autoritativo, dois recebimentos parciais, custo médio, idempotência, detalhe conciliado e concorrência sobre a quantidade pendente.
- RED válido: 22 testes anteriores PASS; os 3 novos testes falham com HTTP 404 porque `/purchase-orders` ainda não existe.
- Cancelamento permanece fora deste ciclo até aprovação do estado oficial divergente no legado.
- Próximo passo seguro: implementar pedido/recebimento mínimos e repetir exatamente os mesmos testes.

### 2026-08-30 — Bloco 4, checkpoint GREEN de compras

- `POST /purchase-orders` calcula estimativa, taxa, total e custo unitário final proporcional; replay não duplica e referências inválidas não criam pedido.
- Dois recebimentos de 2 unidades conciliaram 4 pedidas/4 recebidas/0 pendentes, estoque 4, custo médio 55,00, dois movimentos e duas auditorias.
- Recebimento bloqueia pedido, itens e variantes; duas requisições concorrentes para a única unidade produziram 201/409 e uma única entrada.
- `GET /purchase-orders/:id` agrega itens com pendência e recebimentos. A migration `002_manager_purchase_read.sql` adiciona leitura ao gestor sem alterar checksum da migration inicial.
- Carga com taxa e base estimada zero é rejeitada; fornecedor/variante/pedido inexistentes e excesso parcial também têm respostas explícitas.
- `pnpm --filter @erp/api test:integration`: 26 testes PASS em PostgreSQL 16; cobertura integral da API: 39 testes PASS, 88,34% statements, 80,57% branches, 100% functions e 91,77% lines.
- Cancelamento continua bloqueado pela decisão externa sobre o conjunto oficial de estados.
- Próximo passo seguro: ciclo TDD de encomendas de cliente e timeline de status.
