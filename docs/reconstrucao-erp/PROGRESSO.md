# Progresso verificável da reconstrução

> Escopo deste arquivo: os Blocos 0–6 do roadmap (`11-roadmap-validacao.md`) têm gates próprios, vários exigindo aprovações humanas/externas, e nenhum está marcado `COMPLETO` por esta entrega. O recorte "venda paga confiável" abaixo é trabalho dentro dos Blocos 1/3, não um gate integral.

Atualizado em: 2026-09-05 (America/Sao_Paulo)

## Catálogo legado e lista de vendas — 2026-09-05

- Antes: catálogo sem imagens associadas e vendas identificadas por UUID abreviado, sem cliente/produtos visíveis.
- Recuperadas associações exatas de clube/modelo do catálogo instalado em `%LOCALAPPDATA%/ERP 2.0/data/catalogo/imagens.properties`, com imagens copiadas para o armazenamento local da aplicação. O ERP antigo e seus arquivos não foram alterados. Quando há tipos diferentes, a capa masculina tem prioridade; não houve associação por semelhança.
- Importador: `apps/api/scripts/import-legacy-images.ts`, reutilizando validação, armazenamento, deduplicação e auditoria do catálogo. Uma imagem acima do limite foi redimensionada/comprimida somente na cópia usando sharp. Destino desta execução: `erp2_homolog_test`, mídia em `e2e-artifacts/local-media`. Exige DATABASE_URL de teste e MEDIA_STORAGE_DIR; executar `pnpm --dir apps/api exec tsx scripts/import-legacy-images.ts` com essas variáveis configuradas.
- Resultado: 68/72 produtos com associação recuperada. Replay observado: imported=0, reused=68. Sem associação exata na fonte: BRASIL GOLEIRO, FLAMENGO EVANIEL, VASCO BRANCA 2026 ALINE e VASCO PRETA 2026 WESLEY. Permanecem pendentes; não foi escolhida imagem arbitrária.
- Vendas: API entrega customerName e productSummary, sem multiplicar linhas ou alterar totais. UI em quatro colunas (cliente/produtos, data, total, pagamento); resumo discreto de clube/modelo/quantidade, status em badge e saldo somente quando devido. Arquivos: sales/routes.ts, SalesPages.tsx, SalesPages.test.tsx e app.css; catálogo exporta seu helper existente; package.json/lockfile incluem sharp.
- Evidências desta alteração: pnpm check exit 0; integração de vendas 18/18; testes de SalesPages 18/18; lint e tipos da API após ajuste do importador verdes; diff check sem erros. Navegador real confirmou nomes/resumos e imagem carregada (naturalWidth > 0). Capturas: e2e-artifacts/sales-refined.png e catalog-recovered.png. Validação antes/depois não altera os gates globais abaixo.

## Fechamento técnico executado pelo Codex — 2026-09-05

- Corrigidas as duas leituras paginadas de estoque no E2E de venda paga com filtro SKU. A seleção inicial também usa SKU; após reload o teste verifica busca e todos os botões disponíveis bloqueados, sem depender da posição do produto na página.
- Reconciliação: rejeições de produtos filtradas por `source_table`; valores monetários em centavos BigInt; total esperado calculado pelos IDs rejeitados e semântica Pago. Diferença residual recebe código UNEXPLAINED, comprovado por teste com pagamento alterado. Nenhuma diferença é declarada explicada só por existir.
- Instalação pelo lockfile exit 0; pnpm check exit 0: contratos 8, API 35 (2 skips preexistentes), web 151; tipos e builds verdes. Integração 18 arquivos/125 testes, exit 0. E2E mock 7 pass/9 gates skipped; execução fullstack separada 9/9, zero skipped, todos os verificadores passaram. Backup scripts 25/25; PWA 8/8. Audit prod: nenhuma vulnerabilidade conhecida. Busca estática por padrões de chaves privadas/tokens nas fontes sem achados (não equivale a prova absoluta de ausência de segredos). Diff check exit 0.
- Replay real no erp2_homolog_test: quatro módulos reused=true; 176 variantes/72 produtos, rejeições de produtos 0, saldo 176/176; 65 vendas/60 pagamentos, 6 compras/95 itens/5 recebimentos. Totais 9500.00/8010.00/1490.00 com residual financeiro 0.00 após classificação; 4 vendas rejeitadas preservadas no dump (8,10,50,61; R$780).
- Backup real WSL restaurado em novo banco erp2_closeout_715ee6d0_restore_test, sem apagar banco existente. Verificação: 3 migrations/176 variantes/65 vendas/60 pagamentos/6 compras. SHA256 A25F5141458A9608295ACE8D2CDAAA6F8F00BA36DC4F767F718310B7CC0CD65E. Dump preservado em e2e-artifacts/closeout-*.dump. Ensaio usa binários reais do WSL; regressões dos scripts Windows são validação separada.
- Aplicação disponível em http://127.0.0.1:5173 usando base de homologação. Novo comando scripts/start-local.ps1; login vitinho.local com senha aleatória inicial, sem alterar usuários existentes. Login real verificado até /inicio em 1366x768; screenshot e2e-artifacts/local-dashboard.png. Nenhum acesso/escrita ao MySQL produtivo.
- Plano de fechamento: tarefas 1–4 e 6 COMPLETO; tarefa 5 COMPLETO com validações consolidadas, sem repetir baselines já reproduzidos na revisão. Backup por novo banco substitui dropdb do plano. Scripts adicionais de acesso local passaram lint/tipos e smoke de login.
- Goal global 0–6 continua PARCIAL: homologação humana, Drive real, tratamento das 4 pendentes, operação paralela/corte e instalação do agendamento mensal no ambiente definitivo ainda não executados. O launcher usa desenvolvimento local e depende do PostgreSQL ligado; não é instalação produtiva autônoma.

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

## Decisões confirmadas pelo responsável (2026-09-04)

- Operação local/offline no PC da loja; um único usuário; sem impressora, leitor ou hardware externo.
- Banco MySQL autorizado para homologação: `gemini_teste`; dump autorizado: `backups/gemini_teste-mysql-20260904-090700.sql`. Nunca escrever no MySQL de produção.
- Faturamento por venda (data da venda) e caixa por recebimento (data do pagamento), separados.
- Venda pendente/parcial exige cliente identificado e data de recebimento **futura** (estritamente posterior ao dia local do PC; validada na API e na UI — `PENDING_SALE_DUE_DATE_PAST`).
- Venda sem nome de cliente usa “Consumidor Final”.
- Duplicidade de clientes pode permanecer relaxada.
- Múltiplos pagamentos por venda são permitidos.
- Somente o responsável/administrador pode estornar; estorno não exige motivo obrigatório.
- Cancelamento de compra exige motivo e é bloqueado após recebimento.
- Backup mensal local no PC.
- Sincronização Google Drive deve ser implementada quando houver credenciais, sem segredo no código (adapter isolado já previsto).

## Gates externos restantes

1. Credenciais reais do Google Drive para homologar a sincronização (código/adapter/dry-run implementados; sem credencial, o comportamento é "não configurado").
2. Aprovação humana final de corte/treinamento/operação paralela (procedimento documentado; corte real não é executado pela automação).

Esses gates não impedem implementação e validação local com dados sintéticos claramente identificados.

## Blocos 0–6

| Bloco | Status | Evidência atual | Gate pendente |
| --- | --- | --- | --- |
| 0 — descoberta | `PARCIAL` | `AGENTS.md` fornecido na tarefa, documentos `00`–`11`, `ERP_REAL_CONTEXT.md`, `database.sql`, schema do backup local e regras críticas do legado foram lidos/confirmados. | Banco de produção, decisões operacionais/financeiras e aprovação do responsável. |
| 1 — experiência e fundação | `PARCIAL` | Monorepo, segurança HTTP, shell responsivo, telas operacionais, CI PostgreSQL/Chromium e gates de lint/tipos/testes/build. | Teste de usabilidade e aprovação dos responsáveis; requisitos reais de dispositivos/offline. |
| 2 — dados e estoque | `PARCIAL` | Schema inicial; produtos/variantes; leitura/ajuste; entradas de compra; movimentos de venda/troca; migrador determinístico e concorrência em PostgreSQL 16. | Homologação contra fonte oficial e publicação de imagens. |
| 3 — vendas | `PARCIAL` | Backend completo do recorte, PDV web pago e E2E idempotente; pagamento posterior e troca preservam histórico/auditoria; UI de pagamento posterior e troca implementada e coberta por testes. | Aprovação da diferença financeira pelo responsável. |
| 4 — compras e encomendas | `PARCIAL` | Backend, listagens web, formulário de compra, timelines, E2E de renderização operacional e cancelamento de compra com motivo, bloqueio pós-recebimento e auditoria (doc 08). | Homologação de todos os formulários com o responsável. |
| 5 — financeiro, catálogo e operação | `PARCIAL` | Financeiro, relatório de produtos, dashboard, catálogo com upload de mídia e sincronização local (adapter Drive isolado, sem credenciais reais), Compose, proxy, CI, health, backup/checksum e restore drill protegido. | Regime oficial, homologação do Drive com credenciais reais, retenção e alerta externo aprovados. |
| 6 — migração e corte | `PARCIAL` | Migração real do dump autorizado executada e determinística em `erp2_homolog_test` (produtos 176/176, vendas 65/69 com 4 rejeições tipadas, compras 6/6 com 95 itens/5 recebimentos, replay idempotente, reconciliação com divergências explicadas). | Treinamento, operação paralela, checklist/aprovação de corte e migração incremental/final. |

## Evidência antes/depois — baseline

| Verificação | Antes | Depois esperado |
| --- | --- | --- |
| Instalação limpa | inexistente | lockfile e comando reproduzível |
| Lint/tipos/testes/build | inexistentes | todos verdes sem skips |
| Banco PostgreSQL isolado | indisponível | ambiente local reproduzível |
| API/web | inexistentes | inicialização documentada e health checks |
| Legado | presente e utilizável | preservado durante toda a reconstrução |

## Histórico de execução

### 2026-09-03 — revisão independente do PDV e próxima entrega de estoque

- Revisada a entrega OpenCode `msg_068f7389a001H6bjmLN4PlZcCt`, sem commit/stage/push e preservando o legado.
- Reexecução pelo orquestrador: `pnpm check` exit 0 (38 testes unitários/componentes, lint, tipos e builds); integração PostgreSQL 33/33, exit 0, em `erp2_test` sintético.
- E2E com autorização para teardown dos próprios servidores Windows: full-stack 1/1 e mock 3/3, ambos exit 0. `verify:e2e` exit 0: saldo 3, uma venda/pagamento/movimento/auditoria por operação, retentativa com o mesmo ID. Venda `8eba00fc-aee1-45af-a146-5b68cc776601`, retentativa `f2a7c479-21c1-4ab2-85f9-e97d58cd3c06`. O hang anterior não reapareceu nessa execução; não é prova de correção do sandbox.
- Resposta 201 truncada preserva a operação; falha de persistência impede POST, conforme regressões executadas. Achado residual em revisão estática: restauração valida apenas o array externo do carrinho, permitindo item inválido que pode falhar no render. Regressão e correção exigidas no início da próxima entrega.
- Revisão estrutural de estoque: API possui leitura/cadastro de produtos e ajuste transacional; frontend ainda exige UUID, repete a mesma tela nas duas rotas e não possui detalhe/histórico. Próxima entrega: listagem agrupada, filtros URL, cadastro/edição autorizados, detalhe com movimentos e seleção legível no ajuste. Acrescentar os endpoints faltantes com dados reais e E2E full-stack; imagens/sync ficam identificados no Bloco 5.
- Nenhum gate integral foi aprovado: Blocos 0–5 `PARCIAL`, Bloco 6 `NAO_FEITO`. Aprovações humanas e homologação da fonte oficial continuam pendentes; há trabalho local seguro a executar.

### 2026-09-03 — revisão independente do recorte de estoque: correções exigidas

- Reproduções independentes adicionadas em `apps/api/src/modules/inventory/inventory-catalog.integration.test.ts` e `apps/web/src/features/InventoryPages.test.tsx`.
- `pnpm --filter @erp/web test -- InventoryPages.test.tsx`: 1 falha em 8 testes — o input Busca perde foco porque `key={filters.search}` desmonta o campo a cada caractere.
- `pnpm --filter @erp/api test:integration`: 3 falhas em 42 testes — `productSelect` multiplica saldo pela junção com cada movimento (24 exibido para saldo real 16); `count(*) over()` perde o total quando a página está vazia; `currentCost` é exposto pela API a operador sem `products:write`.
- Esses achados impedem aprovar o recorte de estoque e foram enviados ao executor com causas raiz e critérios de correção. O estado dos Blocos 0–5 permanece `PARCIAL` e o Bloco 6 `NAO_FEITO`.

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

### 2026-08-30 — Bloco 4, checkpoint RED de encomendas

- Nova suíte define criação livre sem reserva/compra, replay, transições ordenadas, detalhe com timeline e cancelamento motivado.
- RED válido: 26 testes anteriores PASS; os 3 novos testes falham porque `/customer-orders` ainda não existe.
- Próximo passo seguro: implementar criação e máquina de estados mínima, sem efeitos automáticos em compra/estoque.

### 2026-08-30 — Bloco 4, checkpoint GREEN de encomendas

- Encomenda aceita descrição livre e vínculos opcionais; criação gera estado/evento `pending`, auditoria e replay idempotente.
- Máquina explícita preserva `pending` → `supplier_ordered` → `product_arrived` → `delivered`; salto inválido retorna 409.
- Cancelamento sem motivo retorna 400; motivo válido fica no registro e no evento da timeline.
- Replay de transição não duplica evento, chave com payload diferente retorna 409 e ID inexistente retorna 404.
- Cenário completo produziu quatro eventos/quatro auditorias e zero compras/movimentos automáticos.
- `pnpm --filter @erp/api test:integration`: 29 testes PASS em PostgreSQL 16; cobertura integral da API: 42 testes PASS, 87,39% statements, 80,43% branches, 100% functions e 90,85% lines.
- Próximo passo seguro: iniciar Bloco 5 por indicadores financeiros reconciliados e dashboard, antes de catálogo/backup/operação.

### 2026-08-30 — Bloco 5, checkpoint RED financeiro

- A fixture fixa separa vendas por `created_at` de pagamentos por `received_at` e define reconciliação de pendência, custo, estoque e compras abertas.
- RED válido: 29 testes anteriores PASS; os 2 novos testes retornam 404 porque `/reports/financial` ainda não existe.
- O endpoint não nomeará “faturamento” até a aprovação do regime; ambas as bases serão expostas explicitamente.

### 2026-08-30 — Bloco 5, checkpoint GREEN financeiro

- `/reports/financial` usa datas civis em `America/Sao_Paulo` e separa venda por `created_at` de caixa por `received_at`.
- Fixture conciliou vendas 300,00, recebimentos 150,00, pendência 150,00, custo 160,00, lucro 140,00, margem 46,67%, estoque 150,00/300,00 e compra aberta 60,00.
- A resposta declara as bases e não usa “faturamento” enquanto a decisão externa estiver pendente.
- 31 testes de integração e 44 testes da API PASS; cobertura 87,57% statements, 80,21% branches, 100% functions e 91,05% lines; `pnpm check` PASS.
- Próximo passo seguro: relatório de produtos e resumo do dashboard usando as mesmas fontes reconciliadas.

### 2026-08-30 — Blocos 1/3/4/5, checkpoint GREEN operacional

- Relatório por variante usa snapshots imutáveis de itens de venda; dashboard separa venda por criação, caixa por recebimento e filas pelo estado atual.
- Listagens paginadas de compras e encomendas foram adicionadas e exercitadas com/sem filtro no PostgreSQL.
- Shell deixou de usar placeholders nas rotas principais: dashboard, PDV, vendas, estoque, compras, encomendas, financeiro, produtos, catálogo e configurações possuem estados de loading/erro/vazio.
- Playwright Chromium: 3 cenários PASS em 1366×768 (teclado, venda idempotente e smoke operacional). Componentes web: 4 PASS.
- CI versionada com PostgreSQL 16, gates completos, integração, cobertura e artefatos E2E em falha.
- Compose/Nginx, `.env.example`, healthchecks e runbook foram adicionados. Backup gera dump + SHA-256; restore drill recusa qualquer banco que não termine em `_restore_test`.
- `pnpm check`: PASS. Integração: 33 PASS. API completa: 46 PASS; 87,62% statements, 80% branches, 100% functions e 91,4% lines.
- Bloqueios restantes: fonte produtiva, aprovações operacionais/financeiras, credenciais de armazenamento, retenção/janela de corte e homologação humana/dispositivos.

### 2026-09-03 — Bloco 1 da tarefa: venda paga confiável de ponta a ponta

Status: implementado e validado full-stack no banco de teste; E2E de resposta perdida no navegador agora existe (`paid-sale-fullstack.spec.ts`).

Causas encontradas:

- `idempotencyHeaders()` gerava um UUID novo a cada tentativa; repetir a finalização após resposta perdida criava outra venda.
- PDV calculava `Number(preço) * quantidade`, sem centavos inteiros nem respeito ao limite do contrato (`99_999_999_999_999` centavos).
- Rotas operacionais não tratavam 401 de forma explícita e o cache do React Query sobrevivia a login/logout.
- O E2E existente simulava a API por rota mockada; nada provava login → venda paga → persistência contra API/PostgreSQL reais.

Correções (sem framework genérico, somente este fluxo):

- `apps/web/src/lib/money.ts` (novo): `moneyToCents`, `formatCentsToMoney`, `saleTotalCents` com limite do contrato.
- `NewSalePage`: uma operação = uma chave + um payload congelado; erro de rede/5xx marca a operação como incerta, trava o carrinho e expõe `Tentar novamente` com a mesma chave/payload; erro definitivo 4xx preserva o carrinho e descarta a operação; sucesso confirmado limpa o carrinho e invalida `sales`, `products`, `inventory`, `dashboard`, `financial-report` e `product-report`.
- `PageError` agora rende `Sessão expirada` + link `/login` em 401; `LoginPage` e `SettingsPage` (novo botão `Sair`) fazem `client.clear()` antes de navegar; `main.tsx` não repete 401 e remove a query `session` obsoleta. Cookies, CSRF e RBAC da API intactos.
- Novo E2E full-stack `tests/e2e/paid-sale-fullstack.spec.ts` (pulado sem `E2E_FULLSTACK=1`; suíte mockada inalterada como categoria distinta), com fixture sintética via `apps/api/scripts/seed-paid-sale-e2e.ts` e conferência de banco via `verify-paid-sale-e2e.ts`. A perda de resposta é provocada por `route.fetch()` real seguido de `route.abort()`: o servidor conclui e o navegador recebe falha, sem mockar a execução da API.

Comandos executados (banco exclusivamente de teste `erp2_test`; PostgreSQL 16.14 descartável em WSL2):

- `pnpm check`: PASS (lint, tipos, contratos 8, web 8, API 13 unitários, builds).
- `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/erp2_test`: 8 arquivos, 33 testes PASS.
- `npx playwright test tests/e2e/operational.spec.ts`: 3 PASS (mock, categoria distinta preservada).
- Seed E2E: usuário `e2e.caixa.3d13e54b`, variante `E2E-M-3d13e54b`, preço `150.00`, estoque 5.
- `E2E_FULLSTACK=1 npx playwright test tests/e2e/paid-sale-fullstack.spec.ts`: 1 PASS — login real, venda paga `150.00`, detalhe `paid/amountDue 0.00` com 1 pagamento `pix` confirmado, estoque 5→4→3, retentativa retornou o mesmo id da resposta perdida. Ids em `e2e-artifacts/` (fora de `test-results/`, que o Playwright limpa a cada execução).
- `pnpm --filter @erp/api verify:e2e`: `sales 1`, `payments 1`, `movements 1`, `saleCreateAudits 1`, `retryMatchesFirstServerResponse true`, efeitos da retentativa `1/1/1` (venda `703e9185…`, retentativa `2d606f23…`).
- Regressão reproduzida antes da correção por `apps/web/src/features/NewSaleCheckout.test.tsx` (4 testes: import de `money.ts` inexistente, botão de retentativa ausente, trava de carrinho ausente, aviso de sessão ausente) e verde após.
- CI (`ci.yml`) ganhou etapa full-stack reproduzível com a mesma sequência seed → spec → verify.

Limitações reais e riscos:

- PostgreSQL local vive em WSL2 sem supervisão; se o cluster `/tmp/erp2_pgdata` cair, é preciso reiniciá-lo — ambiente de teste indisponível não equivale a funcionalidade validada.
- Rate limit de login continua por IP em memória; CSRF/sessão não mudaram.
- Pagamento posterior, troca, catálogo e migração real seguem fora deste bloco.
- Nenhum teste foi removido ou enfraquecido: o ajuste pontual em `OperationalPages.test.tsx` troca `toHaveBeenLastCalledWith` por filtro do POST `/api/sales` porque o sucesso agora invalida e refaz `GET /products`; a intenção (chave enviada, carrinho limpo após confirmação) está preservada.

### 2026-09-03 — Bloco 1, revisão: 3 achados corrigidos com regressão

1. Operação incerta morria com recarga/navegação (só `useState`): `NewSalePage` agora persiste `{key, body, cart, csrf}` em `sessionStorage` ao finalizar, restaura carrinho congelado + `Tentar novamente` após recarga/navegação, e descarta o registro em sucesso, erro definitivo ou CSRF divergente (troca de usuário/sessão nunca reaproveita operação alheia). Sem `beforeunload` como garantia. Regressão: `NewSaleCheckout.test.tsx` cobre recuperação pós-recarga (mesma chave/payload, 1 POST) e descarte cross-usuário; o E2E full-stack ganhou etapa de `page.reload()` entre resposta perdida e retentativa, com o mesmo id retornado.
2. Seed/execução E2E aceitavam qualquer banco pelo nome da variável: novo `apps/api/scripts/lib/assert-test-database.ts` confere `current_database()` realmente conectado e exige sufixo `_test` antes de qualquer migração/escrita, sem exibir URLs ou credenciais. Ligado em `seed-paid-sale-e2e.ts`, `verify-paid-sale-e2e.ts` e no novo `scripts/serve-e2e.ts` (usado por `serve:e2e`/Playwright); inicialização normal de produção (`dev`/`start`/`server.ts`) inalterada. Regressão: `assert-test-database.test.ts` prova aceite de `erp2_test` e rejeição de `postgres` sem efeitos e sem vazar segredos.
3. Logout mascarava falhas (`onSettled` limpava/redirecionava mesmo com revogação negada) e `api()` quebrava em 204 (`response.json()` em corpo vazio; o logout real retorna 204): `api()` retorna `undefined` em 204; `SettingsPage` só limpa o cache e navega em `onSuccess`, expõe `PageError` e oferece `Tentar novamente` em falha, preservando o cache entre tentativas. Regressão: sucesso 204 (limpa cache + `/login`), falha de rede (sem saída, com retry que conclui) e 403 CSRF.

Validação desta revisão: `pnpm check` PASS (lint, tipos, contratos 8, web 13, API 15 unitários com `TEST_DATABASE_URL`, builds); `test:integration` 33 PASS; `operational.spec.ts` 3 PASS (mock); full-stack com semente `e2e.caixa.08bfeba6` 1 PASS + `verify:e2e` (`sales/payments/movements/audits 1`, `retryMatchesFirstServerResponse true`, venda `4476d046…`, retentativa `ccac3833…`).

### 2026-09-03 — Bloco 1, revisão do orquestrador: 4 itens corrigidos/investigados

1. 201 não interpretável apagava a operação: `api()` agora lança `UncertainResultError` quando resposta `ok` não decodifica, e `NewSalePage` valida contrato mínimo (`id` não vazio) tratando ausência como incerta. `onError` preserva chave/payload/storage em `TypeError`, `UncertainResultError` e `ApiError >= 500`; mantém definitivas as rejeições `ApiError < 500` (inclui 401/403/409) e o fluxo 204/logout. Regressão RED→GREEN: 201 `truncated JSON` após commit simulado vira incerta, retry e recuperação pós-recarga usam a mesma chave (2 POSTs, mesma chave/payload), sem transformar erro em sucesso.
2. POST sem persistência garantida: `savePendingSale` retorna `boolean` com read-back (`getItem === escrito`); `startSale` recusa o envio com aviso recuperável e carrinho preservado quando a persistência falha (teste com `setItem` lançando `QuotaExceededError`: 0 POST). Registros inválidos de storage seguem descartados de forma controlada; isolamento por CSRF mantido.
3. Gate lint: `pnpm check` falhava em `eslint .` com EPERM em `config/google/tokens` (pasta de segredos jamais aberta). `eslint.config.mjs` ganhou ignores globais precisos de legado/segredos/artefatos (`src`, `config`, `data`, `images`, `import`, `infra`, `backups`, `test-results`, `e2e-artifacts`, `playwright-report`, `apps/api/uploads`, `apps/api/backups`), sem excluir código novo nem enfraquecer regras — verificado que esses diretórios não contêm `.ts/.js`. `pnpm check` (com `eslint .`) PASS com exit 0.
4. Teardown Playwright no Windows: investigado no motor 1.62 (`WebServerPlugin.teardown` → `taskkill /pid /T /F`; graceful indisponível no Windows por design). Medido nesta máquina, sem hang: mock via `node cli.js` EXIT 0 em ~3s; full-stack (2 webServers) EXIT 0 em ~6s; suite combinada EXIT 0; portas 3333/4173 livres após cada execução. O hang do sandbox não foi reproduzido aqui — registrado como limite de ambiente, sem correção inventada. Melhoria segura aplicada: script `test:e2e:node` (`node node_modules/@playwright/test/cli.js test`) como alternativa ao shim `pnpm exec playwright`. `reuseExistingServer:false` e isolamento preservados; nenhum processo alheio tocado. Nota: o E2E full-stack exige semente fresca por execução (estoque inicial 5→4→3); reuso de semente falha por saldo, não por regressão.

Validação desta entrega: `pnpm check` PASS (contratos 8, web 15, API 13 unit sem DB + 15 com `TEST_DATABASE_URL`, builds); `test:integration` 33 PASS; mock 3 PASS; full-stack semente `e2e.caixa.12f82ff1` 1 PASS + `verify:e2e` (venda `85627a94…`, retentativa `9fdb9bee…`, efeitos 1/1/1/1, `retryMatchesFirstServerResponse true`). Nenhum bloco 0–6 marcado `COMPLETO`.

### 2026-09-03 — Bloco 2, recorte: estoque operacional utilizável (não é o Bloco 2 integral)

Antes: `/estoque` e `/estoque/entrada` renderizavam a mesma tela com UUID digitado; API sem `PATCH /products/:id` e sem `GET /inventory/movements`; recuperação de venda validava só `Array.isArray(cart)` (confirmado por RED: `cart=[null]` quebrava render, preço/quantidade inválidos estouravam subtotal, payload divergente restaurava estado incerto); viewport E2E era 1280×720 (preset Desktop Chrome sobrescrevia os 1366×768).

Depois:
- `loadPendingSale` valida profundo cada item (uuid/tipo/tamanho/sku/preço em centavos/quantidade 1–10000) e coerência carrinho×payload; registro inválido é descartado de forma controlada, operação incerta válida nunca é apagada nem reescrita (regressão RED→GREEN em `NewSaleCheckout.test.tsx`).
- API: `PATCH /products/:id` (metadados + preço/mínimo por variante, schema `strict` rejeita custo/saldo, 400/404/409, auditoria `product.update` com antes/depois); `GET /products` com busca/clube/tipo/tamanho/disponibilidade/imagem, paginação e ordenação whitelist, agregados reais (`totalStock`, `lastMovementAt`, `hasImage`); `GET /inventory` com os mesmos filtros/paginação/ordenação; `GET /inventory/movements` (por variante/produto/tipo, paginado, com motivo/origem/responsável). Transações, `SELECT ... FOR UPDATE` onde havia, 409 em duplicidade e guarda de saldo preservados.
- Web (`InventoryPages.tsx`, sem refactor amplo): `/estoque` agrupado por produto com expansão, totais, filtros/paginação na URL e limpar-filtros; `/estoque/produtos/:produtoId` com variantes, histórico paginado, edição PATCH, custo visível só com `products:write`/`*`, 400/404 controlados; `/estoque/entrada` com seletor pesquisável (sem UUID), motivo obrigatório, mesma disciplina de idempotência do PDV (chave/payload persistidos com read-back, retry e recovery pós-recarga); cadastro com variantes dinâmicas (saldo sempre zero). Viewport Playwright corrigido para 1366×768 com teste de `viewportSize`.
- Cobertura por rota/API: integração `inventory-catalog` 6 testes (auth/RBAC/CSRF, UUID inválido/inexistente, duplicidade produto/SKU, PATCH auditado e campos proibidos, filtros/paginação/agregados, histórico real, ajuste sem motivo); componentes `InventoryPages.test.tsx` 7 testes (URL, estados, recovery inválido de ajuste, retry mesma chave); E2E real `inventory-fullstack` (login→cadastro→entrada→detalhe/histórico→filtros/deep-link→edição→retry pós-resposta-perdida+recarga com efeito único).

Comandos/contagens reais (banco `erp2_test` sintético, guard `*_test` antes de seed/escrita): `pnpm check` PASS (8+29+13/15 unit, builds); `test:integration` 9 arquivos 39 PASS; mock 3 PASS; venda 1 PASS + `verify:e2e` 1/1/1/1; estoque 1 PASS + `verify:inventory-e2e` (estoque 8, 2 movimentos, soma=saldo, 2 auditorias de ajuste, 2 de produto). Screenshots `e2e-artifacts/inventory-1366.png` (1366×768 confirmados) e `inventory-390.png`.
Falhas corrigidas: `WHERE` duplicado no detalhe, ORDER BY fora do GROUP BY, `total` número vs texto, seletores ambíguos, notice de sucesso desmontada, semente reutilizada (409).
Lacunas: catálogo/sync de imagens e política de imagens ficam no Bloco 5 (filtro com/sem imagem usa `media` real); sem homologação humana/banco real — migração real e corte seguem bloqueados externamente. Bloco 2 NÃO está integralmente completo.

### 2026-09-03 — Bloco 2, regressões do orquestrador: 4 defeitos confirmados e corrigidos

Antes (reproduzido RED): `/products/:id` somava variante multiplicada por movimento (`totalStock` 32/24 em vez de 16); página além dos dados devolvia `total=0`; operador com só `inventory:read` recebia `currentCost`; digitar nos filtros remontava o input (`key={...}`) e perdia o foco. Achado extra na investigação: mocks de componente reutilizavam uma única instância de `Response` (corpo legível uma vez) e ignoravam a query de sessão, mascarando os testes — harness corrigido para `Response` fresca por chamada com roteamento por URL, sem relaxar expectativas.

Depois:
- Agregação por CTEs independentes (`total_stock` por variante, `last_movement_at` separado, sem fan-out) na listagem e no detalhe; `total` via `count(*)` pré-paginação em query própria, preservado em página vazia; ordenação whitelist e parâmetros intactos.
- Custo unitário só com `products:write`/wildcard na API (listagem, detalhe, create e PATCH/auditoria mantêm custo interno); operador não recebe a propriedade; frontend já tratava custo opcional e agora também oculta cadastro/edição sem `products:write` (permissões reais, sem papel novo).
- Filtros Busca/Clube/Tamanho controlados (`value`+`onChange`), sem remount, foco preservado, `Limpar filtros` limpa valores e URL.

Validação: `pnpm check` exit 0 (contratos 8, web 32, API 13 unit sem DB e 15 com DB, builds); `test:integration` 9 arquivos 45 PASS (inclui 3 testes `review:` preservados); estoque full-stack 1/1 + `verify:inventory-e2e` (estoque 8, 2 movimentos, soma=saldo, 2+2 auditorias); venda full-stack + mock 4/4. Blocos 0–5 seguem PARCIAL, Bloco 6 NAO_FEITO.

### 2026-09-03 — Bloco 3, recorte: web operacional de vendas (não é o Bloco 3 integral)

Antes: `/vendas` era lista estática sem detalhe; pagamento posterior e troca só existiam na API. Backend de vendas preservado sem mudança de contrato (testes de integração intactos).

Depois (`SalesPages.tsx`, rota `/vendas/$vendaId`): listagem com filtro de status na URL, paginação, vazio/vazio-por-filtro e links por linha; detalhe com resumo financeiro, itens, pagamentos append-only, trocas com timeline e volta segura; pagamento posterior só com `amountDue > 0` e `sales:payment`/`*`, com validação, CSRF, chave estável, retry pós-incerteza/reload e invalidação; troca só com `sales:exchange`/`*`, com devolução restrita aos itens vendidos, busca de entrega, motivo obrigatório, política de valores iguais do backend respeitada e formulário preservado em erro. Permissões derivadas da sessão real em todos os controles.

Validação: `pnpm check` exit 0 (web 38 testes, inclui 6 novos de vendas); integração 45/45 sem alteração; E2E real `sales-fullstack` 1/1 (login→lista→detalhe→pagamento com resposta perdida e retry de mesmo id→troca) + `verify:sales-e2e` (paid, 1 pagamento, 1 troca, 2 itens, 3 movimentos, auditorias 1+1, estoque 4); mock 3/3; `git diff --check` limpo. Falhas corrigidas no ciclo: detalhe some após pagamento com retry pendente (fluxo ajustado para retry direto + reconciliação pós-reload), colisão de textos de sucesso (match exato), contagem de movimentos da troca no verify. Lacunas: venda pendente sem UI de criação, estorno e UI de pagamento parcial múltiplo seguem fora; Bloco 3 NÃO está integralmente completo.

### 2026-09-03 — Bloco 3, revisão: 4 achados corrigidos (custo, timeline, formulários)

Antes (RED reproduzido): `unitCost` vazava para operador em POST/GET de vendas; detalhe sem `timeline`/`createdAt`; Valor editável em operação incerta; sem validação local, sem loading/erro no picker e radio sem saldo habilitado.

Depois:
- API: `unitCost` só com `products:write`/`*` em POST `/sales`, detalhe e trocas (auditoria interna intacta, tipos opcionais); detalhe agrega `createdAt` + `timeline` ordenada (`sale.created`, `payment.confirmed` com `receivedAt`/`amount`, `exchange.created`), mantendo o restante compatível. Integração nova prova redaction do operador e timeline ordenada.
- Web: timeline renderizada com datas e vazios (tolerada só em mocks antigos); pagamento com todos os campos/botão travados em incerteza, validação local (formato, zero, acima do saldo em centavos) preservando valores; picker com loading/erro/retry; entrega sem saldo desabilitada com motivo visível; registros pendentes malformados descartados com segurança; mesma chave/payload no retry.
- Validação: `pnpm check` exit 0 (web 42); integração 47/47; vendas E2E 1/1 + verify (paid, 1/1/2, 3 movimentos, 1+1 auditorias, estoque 4); estoque e venda paga + mock verdes (1/1, 1/1, 3/3); `git diff --check` limpo, sem custo/segredo vazado. Bloco 3 NÃO está integralmente completo.

### 2026-09-03 — revisão independente do orquestrador (goal completo)

- O título “Bloco 1” da sessão OpenCode descreve o recorte de venda paga, não substitui os Blocos 0–6 do roadmap. Status globais permanecem 0–5 `PARCIAL`, 6 `NAO_FEITO`; aprovações humanas e fonte oficial não foram inventadas.
- Reexecução independente em PostgreSQL local `erp2_test`: tipos, 36 testes unitários/componentes (8 contratos, 15 API, 13 web), builds e 33 testes de integração passaram. Lint restrito às fontes/configurações novas passou.
- `pnpm check` **falhou** no lint global ao tentar enumerar `config/google/tokens` (EPERM). Nenhuma credencial foi lida e nenhuma permissão foi ampliada. É necessário corrigir o escopo do lint sem excluir código novo.
- Chromium exibiu 1 caso full-stack e 3 casos mock `ok`, mas os processos ficaram no encerramento dos webServers e foram interrompidos; não há alegação de exit 0 desses comandos. A conferência separada `verify:e2e` terminou em exit 0: estoque 3, efeitos 1/1/1/1, resposta perdida e retry com o mesmo ID (`f4037aa7…` / `b6d8ce94…`).
- Reprodução com o cliente `api()` real e resposta 201 malformada lançou `SyntaxError`, classificado pelo checkout como definitivo: a chave/payload são descartados sem prova de que o servidor rejeitou a venda. Outro risco confirmado por leitura: erro ao gravar `sessionStorage` é ignorado e o POST ainda ocorre. Correções e regressões foram preparadas para o executor; gate de confiabilidade segue aberto.
- Terceira tentativa do revisor CLI encerrou por timeout, sem parecer. Histórico/contador preservados; a revisão direta do orquestrador produziu as evidências acima, sem reabrir automaticamente tentativas do subprocesso.

### 2026-09-03 — revisão independente pós-correção do estoque operacional

- O diff corrigido foi relido no servidor e no cliente: agregações de saldo/data são independentes de movimentos, a contagem é calculada antes da paginação, `currentCost` só é serializado para `products:write`/`*`, e os filtros não remontam os campos nem perdem foco. O harness de componentes cria `Response` nova por chamada e roteia a sessão por URL.
- `git diff --check`: sem erro de whitespace.
- `pnpm check`: exit 0 — contratos 8, API unitária 15, web 32, builds web/API concluídos.
- `pnpm --filter @erp/api test:integration` com o banco sintético dedicado `erp2_test`: 9 arquivos, 45/45 PASS.
- Estoque full-stack real: `test:e2e:node tests/e2e/inventory-fullstack.spec.ts` 1/1 PASS; `verify:inventory-e2e` confirmou saldo 8, 2 movimentos, soma de deltas 8, 2 auditorias de ajuste e 2 auditorias de produto.
- Venda full-stack real: `test:e2e:node tests/e2e/paid-sale-fullstack.spec.ts` 1/1 PASS; conferência confirmou uma venda, pagamento, baixa e auditoria, e a resposta perdida/retry retornou a mesma venda sem duplicar efeitos. Suíte operacional mockada: 3/3 PASS.
- Guardas confirmaram que seed, migração de E2E e verificações usaram somente `erp2_test`; nenhum segredo real, banco de produção ou dado de origem foi acessado.
- A evidência aprova este recorte operacional do Bloco 2 para progressão, mas não fecha o Bloco 2 integral (migrador/reconciliação com fonte oficial e demais gates externos continuam pendentes). Status globais permanecem: Blocos 0–5 `PARCIAL`, Bloco 6 `NAO_FEITO`.
- Próximo passo seguro: completar a camada web do Bloco 3 sobre os endpoints já transacionais — histórico/listagem, detalhe, pagamento posterior e troca auditável — com estados de rota, RBAC, idempotência e E2E contra PostgreSQL.

### 2026-09-03 — revisão independente pós-correção do recorte web de vendas

- O diff do recorte de vendas foi relido: `unitCost` é redigido para operador sem `products:write` (inclusive itens de troca), o detalhe agrega `createdAt` e `timeline` ordenada de venda/pagamentos confirmados/trocas, e o gestor continua recebendo o custo interno autorizado. O frontend exibe a timeline, trava todos os controles em operação incerta, valida pagamentos em centavos, e o picker de troca tem loading/erro/retry e desabilita variantes sem saldo.
- `git diff --check`: exit 0, sem erro de whitespace.
- `pnpm check`: exit 0 — contratos 8, API unitária 15, web 42 (com 2 skips já existentes), builds de API/web concluídos.
- `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL` apontando exclusivamente para `erp2_test`: 9 arquivos, 47/47 PASS, incluindo redaction de custo e timeline ordenada.
- Vendas full-stack real, com seed sintética nova e guard `*_test`: `test:e2e:node tests/e2e/sales-fullstack.spec.ts` 1/1 PASS; `verify:sales-e2e` confirmou `paid`, 1 pagamento, 1 troca, 2 itens de troca, 3 movimentos, 1 auditoria de pagamento, 1 de troca e estoque final 4.
- Estoque full-stack real: `test:e2e:node tests/e2e/inventory-fullstack.spec.ts` 1/1 PASS; `verify:inventory-e2e` confirmou saldo 8, 2 movimentos, soma de deltas 8 e 2 auditorias de ajuste/produto. A suíte operacional mockada permaneceu 3/3 PASS.
- Nenhum segredo real, banco de produção, fonte oficial ou aprovação humana foi acessado; seeds e verificações ficaram no banco sintético guardado. Blocos 0–5 seguem `PARCIAL` e Bloco 6 `NAO_FEITO`; o recorte web de vendas foi aprovado para progressão, mas o Bloco 3 integral ainda requer UI de venda pendente/pagamento parcial múltiplo, contexto de cliente e política/endpoint aprovado de estorno.
- Próximo passo seguro: finalizar o recorte de criação de venda no Bloco 3 (venda paga, pendente e parcialmente paga) com identificação contextual de cliente, vencimento, métodos/valores permitidos, estados recuperáveis e E2E real, sem inventar política de estorno.

### 2026-09-03 — Bloco 3, recorte: criação paga/pendente/parcial + clientes (não é o Bloco 3 integral)

Antes: sem endpoints de clientes; PDV só enviava Pix pago sem cliente/vencimento.
Depois:
- API (`modules/customers`, registrado em `app.ts`): `GET /customers?search&limit` (`customers:read`) e `POST /customers` (`customers:create` + CSRF + idempotência + auditoria `customer.create`); sem dedup inventada (decisão externa pendente). Integração nova (3 testes) + parcial-na-criação/rejeições em vendas.
- PDV: modos pago/pendente/parcial, Consumidor Final, busca + cadastro inline com auto-seleção, vencimento, valor inicial validado em centavos (zero/acima-do-total rejeitados localmente), método, tudo travado em incerteza, contexto persistido com read-back e restaurado pós-recarga, invalidação das queries relacionadas. Justificativa registrada: cadastro inline cria imediatamente via endpoint próprio e auto-seleciona, sem escrita implícita na venda; duplicatas seguem permitidas até decisão oficial.
- Validação: `pnpm check` exit 0 (web 47, inclui 5 novos); integração 10 arquivos 51 PASS; criação E2E 1/1 + verify (pending 150.00/0 pag, partial 90.00/1 pag, 2 auditorias); vendas/estoque/mock/paga verdes; seeds com saída redigida (sem senha/URL); `git diff --check` limpo. Revisão estática: sem custo ao operador, sem flutuante, sem otimista, guardas intactos. Lacunas: estorno, múltiplas parcelas via UI e decisão de duplicatas; Bloco 3 e goal NÃO completos.

### 2026-09-03 — Bloco 3, revisão: 4 achados (botão, contexto, loading, cadastro)

Antes (RED): Finalizar habilitado em incerteza; contexto com `dueDate` de outro modo descartava a operação no reload; busca de cliente sem loading; cadastro com chave nova por tentativa.
Depois: Finalizar desabilitado com `locked` (retry explícito preservado); contexto normalizado ao modo no salvamento (coerência garantida sem apagar venda possivelmente gravada); `Buscando clientes…` com `role=status` + erro/retry/vazio; cadastro com chave/payload persistidos, incerta em rede/5xx/201 ilegível, retry mesma chave, 4xx definitivos sem apagar campos, reload recupera retry.
Validação: `pnpm check` exit 0 (web 51); integração 10 arquivos 51 PASS; criação E2E 1/1 + verify; vendas/estoque/paga/mock verdes; `git diff --check` limpo. Bloco 3 e goal NÃO completos.

### 2026-09-03 — Bloco 4, revisão: `draft` no filtro e `total` na lista

Antes (RED): filtro sem `Rascunho`; `GET /purchase-orders` sem `total` (UI deduzia próxima página por `items.length`).
Depois: opção `draft`/`Rascunho` com URL e `status=draft` à API; `total` pré-paginação via `count(DISTINCT)` em query própria (itens/ordenação/parâmetros intactos) e paginação por `total`.
Validação: `pnpm check` exit 0 (web 60); integração 11 arquivos 55 PASS; compras E2E 1/1 + verify (fully_received, 4/4, 2/2, auditorias 1+2); `git diff --check` limpo. Lacunas: encomendas, cancelamento, aprovações externas; Bloco 4 e goal NÃO completos.

### 2026-09-03 — Bloco 4, revisão: aviso de sucesso na transição terminal

Antes (RED): `StatusActions` retornava cedo em `delivered`/`cancelled` sem o aviso; após refetch, só a mensagem terminal aparecia e o E2E lia o aviso obsoleto da transição anterior. Tentativa com gate `updatedTo === status` quebraria a confirmação imediata e foi descartada.
Depois: aviso `Status atualizado.` renderizado nas duas ramificações (terminal ou não), limpo em novo envio/erro definitivo; loading, erro, incerteza, retry e bloqueio intactos.
Validação: `pnpm check` exit 0 (web 69); integração 11 arquivos 57 PASS; encomendas E2E 1/1 + verify (delivered 4/4, cancelled 2/2 com motivo, 0 compras/movimentos); `git diff --check` limpo. Bloco 4 e goal NÃO completos.

### 2026-09-03 — Bloco 4, revisão: RBAC negativo e contrato nulo canônico

Antes: só 401 sem sessão era testado; `variantId`/`linkedPurchaseOrderId`/`notes`/`reason` aceitavam apenas omissão na API enquanto o recovery tolerava `null` (incoerente; `notes: null` era descartado).
Depois:
- Integração prova 403 de operador autenticado sem `customer_orders:write` em GET lista/detalhe/POST/PATCH sem efeitos, e 403 CSRF ausente/inválido em POST/PATCH sem efeitos (doc 10).
- Contrato canônico: opcionais aceitam `nullish`, normalizados (nulo→omitido) antes do hash/idempotência e persistência — omitido e explícito-nulo produzem a mesma resposta em replay; resposta mantém nulos explícitos; auditoria intacta. Recovery valida `undefined`/`null` de modo coerente.
Validação: `pnpm check` exit 0 (web 70); integração 11 arquivos 60 PASS; encomendas E2E 1/1 + verify; `git diff --check` limpo. Lacunas globais: cancelamento de compra, fonte real, aprovações humanas, migração real; Bloco 4 e goal NÃO completos.

### 2026-09-03 — Bloco 3, recorte: múltiplos pagamentos append-only na UI

Antes (RED): sem prova de dois pagamentos sequenciais; na investigação, refetch duplo por invalidação de prefixo e aviso de sucesso perdido ao quitar (formulário desmonta com o detalhe pago).
Depois: regressão de componente prova parcial→quitado com 2 POSTs de chaves distintas e histórico; confirmação de pagamento elevada ao nível do detalhe (sobrevive ao desmonte do formulário); nenhuma mudança de produção além disso (comportamento já suportado).
Validação: `pnpm check` exit 0 (web 71); integração 11 arquivos 60 PASS; E2E dedicado 1/1 + verify (paid, 2 pagamentos 90+60, 2 auditorias); vendas/criação/estoque/paga/mock verdes. Sem skips intencionais (2 skips unitários preexistentes por ausência de DB). Bloco 3 e goal NÃO completos.

### 2026-09-03 — Bloco 3, revisão: aviso obsoleto, refetch único e isolamento

Antes (RED): `paymentConfirmed` persistia após o primeiro sucesso e continuava visível durante a segunda operação incerta; correção anterior alegava refetch único e isolamento de retry sem tê-los implementado.
Depois:
- `PaymentForm` recebe `onStarted` e limpa o aviso do pai antes de cada POST real (criação e retry); aviso só retorna no sucesso correspondente; validação local não limpa o aviso prévio sem necessidade. Invalidação única ampla `['sales']` (detalhe + lista, sem refetch duplo).
- E2E de pagamentos: `retries: 0` no arquivo (venda com estado não tolera repetição global); afirma chave/corpo idênticos entre tentativa e retry, estado parcial visível antes do segundo submit e 2 linhas + pago/zero depois. CI exporta `tag`/`variantId` da segunda seed (sem misturar credenciais).
Validação: `pnpm check` exit 0 (web 72); integração 11 arquivos 60 PASS; E2E dedicado 1/1 + verify (paid, 2 pagamentos 90+60, 2 auditorias, ids da execução); vendas+criação 2/2 + verifies; `git diff --check` limpo. Correção honesta: nunca houve refetch duplo nem isolamento de retry implementados antes — esta entrega os implementa de fato. Bloco 3 e goal NÃO completos.

### 2026-09-03 — revisão independente do recorte de pagamentos múltiplos

- Revisão de código encontrou e bloqueou o primeiro resultado por dois problemas: o aviso do primeiro pagamento permanecia durante a segunda operação incerta, e a spec stateful herdava dois retries do CI sobre uma venda sem seed por tentativa. Também foram apontados o `E2E_TAG` misturado entre fixtures e a ausência de comparação literal de chave/corpo no retry.
- Após a correção, `onStarted` limpa o aviso antes de cada POST/retry, o sucesso volta apenas na resposta correspondente, a invalidação `['sales']` ocorre uma vez, a spec usa `retries: 0`, compara chave/corpo tentativa×retry, verifica parcial/60 e uma linha antes do segundo pagamento e pago/zero com duas linhas depois; CI usa todos os campos da segunda seed.
- Evidência independente fresca: `SalesPages.test.tsx` 12/12; `pnpm check` exit 0 (contratos 8, API unitária 13 com 2 skips preexistentes, web 72, builds); integração PostgreSQL `erp2_test` 11 arquivos, 60/60; E2E full-stack dedicado 1/1 com exit 0 e verify (`paid`, 2 pagamentos `90.00`+`60.00`, 2 auditorias); `git diff --check` exit 0. Nenhum segredo real, produção ou banco fora de teste foi acessado.
- O recorte de pagamentos múltiplos está aprovado para progressão, mas Bloco 3 e goal continuam incompletos: estorno depende de política/autorização, duplicatas seguem sem decisão e os demais blocos ainda têm lacunas.

### 2026-09-03 — Bloco 4, pós-validação: isolamento entre suítes E2E

Achados reais na validação (não no produto): com dados sintéticos acumulados, a spec de criação não achava seu produto além do `limit=50` e a spec de vendas pegava a pendente de outra spec. Correções: busca de produto no PDV (doc 06, com foco inicial e loading/erro), seletor de link pelo `href` do próprio id e verify de estoque por equação de deltas (contrato da seed: saldo inicial 5).
Evidência final rastreada: vendas+criação em sequência 2/2, verifies com os ids da execução (venda `66aaa76f` paid 1/1/2/3 mov; pendente 150.00/0 e parcial 90.00/1), estoque/inventário, paga e mock verdes. Suites E2E que compartilham o banco devem escopar assertivas aos próprios fixtures e rodar com sementes frescas; execuções paralelas multi-arquivo não são gate exigido.

### 2026-09-03 — Bloco 3, residual: 4xx no cadastro limpa a operação

Antes (RED): `onError` do cadastro só tratava incerta; em 400 a operação/chave persistia e o reload oferecia retry indevido.
Depois: ramo definitivo limpa `customerOp`, incerteza e storage, mantendo campos e exibindo o erro; nova submissão gera nova chave. Rede/`UncertainResultError`/5xx inalterados.
Validação: `pnpm check` exit 0 (web 52); integração 10 arquivos 51 PASS; criação, vendas, estoque, paga e mock E2E verdes com verifies; `git diff --check` limpo; seeds redigidas fora do workspace. Bloco 3 e goal NÃO completos.

### 2026-09-03 — Bloco 4, recorte: compras de fornecedores (não é o Bloco 4 integral)

Antes (RED): sem leitura de fornecedores; detalhe sem nome do fornecedor; UI genérica com UUIDs e sem detalhe/recebimento.
Depois:
- API: `GET /suppliers?search&limit` (`purchases:read`, só ativos, `{id,name,contact}`, limite 100); detalhe com `supplierName` (compatível). Integração nova (3 testes: auth/RBAC, filtro/limite/mínimo, detalhe).
- Web (`PurchasePages.tsx`, rota `/compras/$pedidoId`): lista com status na URL, paginação e links; criação com seletores legíveis, itens dinâmicos, centavos, total estimado e mesma disciplina de idempotência (chave/payload persistidos, retry, sem otimista); detalhe com itens/recebimentos e recebimento parcial/integral validado localmente (≤ pendente) com retry pós-recarga; `fully_received`/`cancelled` explicados sem novo recebimento; sem cancelamento; 401/403 recuperáveis.
- Validação: `pnpm check` exit 0 (web 59); integração 11 arquivos 54 PASS; compras E2E 1/1 + verify (fully_received, 4/4, 2 recebimentos/movimentos, auditorias 1+2); vendas/estoque/paga/mock verdes. Falhas do ciclo: seletores de picker, validação nativa `max` bloqueando submit customizado (removido em favor da mensagem local), verify escopado ao pedido. Lacunas: encomendas, cancelamento, aprovações externas; Bloco 4 e goal NÃO completos.

### 2026-09-03 — revisão independente do residual 4xx e gate de progressão

- O teste RED reproduziu a persistência indevida de `erp.pendingCustomerOperation.v1` após resposta definitiva 400. A correção agora limpa operação/incerteza/storage, preserva os campos para correção e deixa rede/5xx/resultado ilegível no retry idempotente; a suíte focada ficou 28/28 PASS.
- `pnpm check`: exit 0 — contratos 8, API unitária 15 (2 skips já existentes), web 52, builds de API/web concluídos.
- `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL` exclusivamente em `erp2_test`: 10 arquivos, 51/51 PASS.
- E2E real com seeds sintéticas capturadas em memória: criação 1/1 + verify (pendente 150,00/0 pagamento; parcial 90,00/1 pagamento; 2 auditorias); vendas 1/1 + verify (paga, 1 pagamento, 1 troca, 2 itens, 3 movimentos, estoque 4, auditorias 1+1); estoque 1/1; paga + operacional 4/4. `git diff --check` exit 0.
- Revisão não acessou segredo real, banco de produção, fonte oficial ou aprovação humana. O recorte de criação está aprovado para progressão; Bloco 3 continua `PARCIAL` (parcelas múltiplas via UI, estorno e decisão de duplicatas), Blocos 0–2 e 4–5 continuam `PARCIAL` e Bloco 6 `NAO_FEITO`.
- Próximo passo seguro: recortar a camada web do Bloco 4 sobre os endpoints transacionais já existentes — compras com seleção legível, detalhe e recebimento parcial/integral idempotente; encomendas com detalhe e timeline/status — sem inventar cancelamento ou aprovações externas.

### 2026-09-03 — revisão independente do recorte de compras de fornecedores

- `PurchasePages.test.tsx`: 7/7 PASS; a revisão confirmou seleção legível de fornecedor/variante, estados de leitura e recuperação idempotente do recebimento.
- `pnpm check`: exit 0 — contratos 8, API unitária 15 (2 skips já existentes), web 59, builds de API/web concluídos; `git diff --check`: exit 0.
- `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL` exclusivamente em `erp2_test`: 11 arquivos, 54/54 PASS, incluindo busca de fornecedores e detalhe com nome.
- E2E real independente com seed sintética em memória: `purchases-fullstack.spec.ts` 1/1 PASS; `verify:purchases-e2e` confirmou `fully_received`, 4/4 unidades, 2 recebimentos, 2 movimentos, auditoria de criação 1, auditorias de recebimento 2 e estoque 14. Nenhuma senha foi exposta.
- A aprovação é somente deste recorte. Achados objetivos antes da progressão: o filtro web não oferecia `draft` e a lista API não devolvia `total` pré-paginação; ambos foram enviados como RED ao executor. Encomendas, cancelamento sujeito a política e gates humanos/fonte real permanecem pendentes. Bloco 4 e goal NÃO completos.

### 2026-09-03 — revisão independente do recorte de encomendas (RBAC, terminal e contrato nulo)

- O recorte de encomendas foi relido após as correções do executor: lista/criação/detalhe com timeline e transições de status, operações idempotentes recuperáveis e nenhum POST implícito de compra/estoque. `customer_orders:write` é exigido em todas as rotas do recorte; escrita exige CSRF; acesso de operador sem a permissão e CSRF ausente/inválido foram testados como 403 sem efeitos. A migração aditiva `003_manager_customers_read.sql` concede somente `customers:read` ao gestor.
- O contrato de opcionais aceita omissão ou `null`, normaliza nulo para o mesmo payload semântico antes do hash/idempotência/persistência e preserva nulos na resposta; replay com omissão/nulo não duplica efeitos. A decisão não inventa associação automática a compras nem política de cancelamento.
- Validação independente: `CustomerOrderPages.test.tsx` 9/9; `pnpm check` exit 0 (contratos 8, API unitária 13 com 2 skips, web 70, builds); integração PostgreSQL `erp2_test` 11 arquivos, 60/60; E2E real 1/1 + verify (delivered 4 eventos/4 auditorias, cancelled 2/2 com motivo, 0 compras e 0 movimentos); `git diff --check` sem erro.
- Este recorte do Bloco 4 está aprovado para progressão. Status globais permanecem Blocos 0–5 `PARCIAL` e Bloco 6 `NAO_FEITO`; seguem pendentes parcelas múltiplas via UI/estorno e decisão de duplicatas, cancelamento/associação de compras, catálogo/imagens/relatórios completos, migração/backup/restore, fonte real e aprovações humanas.

### 2026-09-03 — Bloco 5, recorte: relatório financeiro comparável e auditável

Antes: `/relatorios/financeiro` ainda não expunha um contrato verificável para comparação, série diária, contas a receber e bases distintas; a consulta podia misturar snapshots entre conexões e não tinha limites explícitos de período/aritmética.

Depois:
- API: `GET /reports/financial?from&to&compare=true` valida datas civis e limita o período a 366 dias (incluindo o período anterior), executa as leituras em uma transação `REPEATABLE READ READ ONLY`, explicita base de venda (`sale_created_at`) e caixa (`payment_received_at`), devolve KPIs, série diária com zeros, métodos de recebimento, recebíveis com drilldown e data de apuração, estoque e compras em aberto. Agregados são arredondados no banco; cálculo em centavos usa `bigint` e arredondamento simétrico para valores negativos. RBAC/CSRF e ausência de escrita foram preservados.
- Web: filtros de período/comparação na URL, validação civil exata sem normalização de datas impossíveis, estados de loading/erro/retry/vazio, definições acessíveis, série tabular, comparação e links para a venda de origem. O texto distingue recebimentos por método e explicita a data de apuração do vencimento.
- E2E/CI: seed dinâmica com janela livre comprovada no banco de teste evita colisões em reruns; o job dedicado exporta a seed em memória e executa a spec + verificador no `erp2_test`, sem segredos de produção.

Validação independente pós-hardening: `pnpm check` exit 0 (contratos 8, API unitária 13 + 2 skips preexistentes, web 82, builds); `FinancialReport.test.tsx` 10/10; integração PostgreSQL em `erp2_test` 13 arquivos, 69/69; E2E financeiro 1/1; `verify:financial-report-e2e` exit 0 (`250.00/80.00/100.00/100.00`, 2 recebíveis, contagens operacionais inalteradas); `git diff --check` exit 0 (somente avisos LF/CRLF). Nenhum banco real, segredo ou fonte oficial foi acessado.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: relatório de produtos completo, catálogo/imagens/sincronização, dashboard operacional, perfis finais, backup/restore, monitoramento e integrações reais ainda exigem implementação e/ou decisões externas. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — Bloco 5, recorte: relatório de produtos com giro, estoque e rankings

Antes: `/relatorios/produtos` consultava apenas variantes com venda e não aceitava filtros de clube/tipo/tamanho; não distinguia sem giro/estoque baixo nem entregava rankings por quantidade.

Depois:
- API: `GET /reports/products?from&to&club&type&size` valida período civil limitado a 366 dias, aplica filtros parametrizados e retorna variantes ativas sem venda no período. A agregação usa snapshots imutáveis de `sale_items` em CTE independente, exclui vendas revertidas, preserva saldo atual e expõe `noTurnover`/`lowStock` sem fan-out. O resumo traz unidades/receita/lucro, contagens sem giro/baixo estoque e rankings por clube, tipo e tamanho; contagens são `bigint` serializadas como strings para não estreitar somas válidas. Bases (`sale_created_at`/`current_state_as_of_request`) e `updatedAt`/`stockAsOf` ficam no envelope; GET não escreve.
- Web: filtros controlados persistidos na URL, validação civil, loading/erro/retry/vazio, KPIs, rankings com unidades/receita/participação, detalhamento por variante e definições de snapshot versus saldo atual. O foco do filtro é preservado após nova resposta/renderização.

Validação independente: `ProductReport.test.tsx` 5/5; `pnpm check` exit 0 (contratos 8, API unitária 13 + 2 skips preexistentes, web 87, builds); integração PostgreSQL em `erp2_test` 14 arquivos, 74/74; E2E operacional 3/3; `git diff --check` exit 0 (somente avisos LF/CRLF). A integração cobre líder por unidades diferente do líder por receita e soma `3.000.000.000` unidades sem overflow. Nenhum banco real, segredo ou fonte oficial foi acessado.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: dashboard com filtro/alertas completos, catálogo/imagens/sincronização, perfis finais, backup/restore, monitoramento e integrações reais ainda estão pendentes. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — Bloco 5, recorte: dashboard operacional com data e fila navegável

Antes: `/inicio` dependia de uma data fixa/prop, não persistia a referência na URL, não oferecia retry explícito nem deixava a fila de trabalho navegar para os conjuntos contados.

Depois:
- Web: `DashboardPage` lê/aplica `?date=AAAA-MM-DD` com validação civil exata, estado controlado sem remount, foco devolvido ao mesmo campo após refetch, loading/erro/retry e definições de `timezone`/bases. A fila expõe links para vendas em aberto (`pending` + `partially_paid`), estoque baixo ou zerado, compras abertas e encomendas abertas.
- API de vendas: filtro composto `GET /sales?status=open` lista somente `pending` e `partially_paid`; filtros individuais permanecem intactos. O endpoint do dashboard e suas contagens não foram alterados.
- Testes: cobertura de URL/data inválida, retry, foco, links, filtro composto e navegação operacional; nenhum POST/auditoria foi introduzido no dashboard.

Validação independente pós-revisão: `OperationalPages.test.tsx` + `SalesPages.test.tsx` 19/19; integração de vendas 12/12; `pnpm check` exit 0 (contratos 8, API unitária 13 + 2 skips preexistentes, web 92, builds); E2E operacional 4/4; integração completa `erp2_test` 14 arquivos, 75/75 (executor, com paralelismo limitado); `git diff --check` exit 0. O executor corrigiu ainda o mock E2E para o campo obrigatório `bases` e removeu schemas sintéticos órfãos do banco de teste.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: catálogo/imagens/sincronização, perfis finais, backup/restore, monitoramento e integrações reais ainda exigem implementação e/ou decisões externas. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — Bloco 5, recorte: catálogo somente leitura com paginação e estado de imagem

Antes: `/catalogo` exibia somente a primeira página implícita, não consumia o envelope `total/page/limit`, os mocks de detalhe usavam IDs que violavam o UUID da API e o estado de imagem não tinha uma fronteira explícita para upload/sincronização.

Depois:
- Web: filtros `search`/`club`/`type`/`size`/`image` controlados na URL, paginação real com envelope autoritativo, navegação acessível e clamp para páginas fora do alcance. URLs inválidas são canonicalizadas; página vazia mantém ação de recuperação. Cartões expõem clube/modelo, saldo, variantes, imagem presente/ausente e link seguro para o detalhe de estoque; loading/erro/retry/vazio e foco do campo de busca são verificáveis.
- Limite de escopo explícito: upload binário e sincronização com catálogo externo aguardam contrato/configuração de armazenamento; nenhum POST/PATCH/DELETE ou acesso a Drive/filesystem foi introduzido.
- Testes: mocks usam UUIDs válidos; cobertura prova filtros/foco, `total/page/limit`, envelope com página autoritativa divergente, página `5000` com recuperação, canonicalização de `page`, imagem/vazio/retry e E2E do drilldown.

Validação independente final: `CatalogPage.test.tsx` + `OperationalPages.test.tsx` 18/18; `pnpm check` exit 0 (contratos 8, API unitária 13 + 2 skips preexistentes, web 104, builds); E2E operacional 5/5 (executor e execução direta; a invocação `pnpm test:e2e:node` local foi interrompida apenas porque o preview permaneceu vivo após os 5 testes verdes); `git diff --check` exit 0 (somente avisos LF/CRLF). Nenhum banco real, segredo, armazenamento binário ou integração externa foi acessado.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: upload/sincronização, perfis finais, backup/restore, monitoramento e integrações reais ainda exigem contratos, implementação e/ou decisões externas. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — Bloco 5, recorte: perfil e diretório de usuários somente leitura

Antes: `/configuracoes` mostrava apenas um resumo mínimo da sessão; não havia uma superfície administrativa verificável para consultar usuários, papéis e situação sem expor dados sensíveis.

Depois:
- API: `GET /users?search&page&limit` exige `users:manage` (ou wildcard administrativo), usa busca case-insensitive, count separado e paginação parametrizada, com `page` limitado a `1_000_000` e `limit` a 100. O envelope `{items,total,page,limit}` expõe somente `id`, `username`, `displayName`, `role`, `active` e `createdAt`; não há POST/PATCH/DELETE, auditoria ou escrita. Inteiros gigantes e filtros inválidos retornam `VALIDATION_ERROR`.
- Web: Configurações exibe username quando disponível, rótulo legível dos quatro papéis fixos, lista ordenada de permissões efetivas e diretório somente para `users:manage`/`*`. Operadores e gestores não fazem fetch de `/users`; loading/erro/retry/vazio/paginação e sessão 401 permanecem recuperáveis; logout mantém CSRF e limpeza de cache.
- Limite explícito: esta etapa não cria/edita/desativa usuários, não altera papéis/permissões e não acessa credenciais, armazenamento binário, integrações externas ou Bloco 6.

Validação independente final: `SettingsPage.test.tsx` + `NewSaleCheckout.test.tsx` + `OperationalPages.test.tsx` 40/40; integração PostgreSQL isolada em `erp2_test` 3/3 (inclui 401/403, redaction, busca/ordem/paginação, inteiro gigante e ausência de escrita); `pnpm check` exit 0 (contratos 8, API unitária 13 + 2 skips, web 109, builds); E2E operacional 6/6; `git diff --check` exit 0 (somente avisos LF/CRLF). A suíte completa executada pelo executor também ficou em 15 arquivos/78/78. Revisão independente final: nenhum achado Critical, Important ou Minor.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: gestão de usuários (escrita), upload/sincronização, perfis finais, backup/restore, monitoramento e integrações reais ainda exigem contratos, implementação e/ou decisões externas. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — Bloco 5, recorte: status operacional e prontidão sanitizada

Antes: havia apenas o liveness público `GET /health`; Configurações não mostrava versão, prontidão do banco ou o estado explícito das integrações, e um erro 503 seria tratado pela web somente como falha genérica.

Depois:
- API: `GET /health/ready` mantém o liveness separado e executa somente `SELECT 1` quando há pool. Banco saudável retorna `200 ready` mesmo com catálogo externo não configurado; `integrations.catalog` é informativo (`configured` somente pela flag não secreta `CATALOG_SYNC_ENABLED=true`). Sem pool ou com falha de banco retorna `503 not_ready` com corpo estável e sanitizado. `APP_VERSION` aceita apenas semver ASCII limitada a 32 caracteres e usa `0.0.0` como fallback.
- Web: Configurações ganhou painel acessível de status operacional com versão, API, banco e catálogo. O fetcher aceita o envelope conhecido tanto em 200 quanto em 503, renderiza estado degradado sem detalhes brutos, oferece atualização manual/retry e não faz polling em foco/janela. Perfil, diretório protegido, sessão 401 e logout permanecem intactos.
- Operação: `docs/OPERACAO.md` documenta a diferença entre liveness, readiness e integração opcional; nenhum backup, upload, sincronização, credencial real ou Bloco 6 foi acionado.

Validação independente final: `apps/api/src/app.test.ts` 10/10; `SettingsPage.test.tsx` + `NewSaleCheckout.test.tsx` + `OperationalPages.test.tsx` 43/43; `pnpm check` exit 0 (contratos 8, API unitária 17 + 2 skips preexistentes, web 112, builds); integração users isolada em `erp2_test` 3/3; E2E operacional 6/6; `git diff --check` exit 0 (somente avisos LF/CRLF). Revisão independente final não encontrou achados Critical, Important ou Minor.

Este recorte está aprovado para progressão, mas o Bloco 5 permanece `PARCIAL`: gestão de usuários (escrita), upload/sincronização real, monitoramento/alertas externos, backup/restore homologado, integrações reais e demais aprovações ainda estão pendentes. Blocos 0–5 seguem `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 — revisão independente final do status operacional

- A semântica foi corrigida após revisão: catálogo externo opcional não bloqueia a prontidão; somente ausência/falha do banco produz `503 not_ready`. O estado de integração continua informativo e não presume conectividade.
- `fetchReadiness` aceita apenas o envelope conhecido em 200/503 e o painel mostra banco/API degradados sem repassar detalhes brutos; `APP_VERSION` fora do formato semver limitado retorna `0.0.0`.
- Validação pós-correção pelo orquestrador: `app.test.ts` 10/10; web focado 43/43; `pnpm check` exit 0 (contratos 8, API unitária 17 + 2 skips, web 112, builds); E2E operacional 6/6; `git diff --check` exit 0 (somente avisos LF/CRLF).
- A revisão bridge final não encontrou achados Critical, Important ou Minor. Nenhum segredo, banco real, armazenamento ou integração externa foi acessado; o status global permanece Bloco 5 `PARCIAL` e Bloco 6 `NAO_FEITO`.

### 2026-09-04 - Bloco 5, recorte: gestao administrativa de usuarios (API)

Antes: Configuracoes exibia diretorio read-only e `GET /users` existia, mas nao havia escrita administrativa; a sessao era lida uma unica vez antes da transacao, permitindo que contexto revogado fosse usado apos serializacao.

Depois:
- API: `POST /users` (201) e `PATCH /users/:id` (200) atras de `users:manage` + CSRF, schemas strict, papéis fixos, username normalizado em minusculas, senha 12-256 com hash scrypt, `USERNAME_TAKEN` 409, `USER_NOT_FOUND` 404, `SELF_PROTECTION`/`LAST_ADMIN` 409, auditoria `user.create`/`user.update` so com campos seguros, invalidacao de sessoes ao desativar, sem hard-delete e sem escrita em GET.
- POST e PATCH adquirem `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` e releem a sessao/permissao/CSRF dentro da transacao; contexto revogado/desativado/rebaixado resulta em 401/403 com rollback total. `usersQuerySchema` tambem e strict.
- `LAST_ADMIN` mantido como defesa em profundidade: com papéis fixos e sessao exigindo usuario ativo, remocao single-thread do ultimo admin e sempre `SELF_PROTECTION` ou permitida com outro admin restante; a invarianca "nunca zero admins" e provada pela demissao mutua concorrente (um 200 + um 403, exatamente 1 admin restante).

Validacao: web focado (`SettingsPage` + `NewSaleCheckout` + `OperationalPages`) 43/43; integracao users isolada em `erp2_test` 9/9 (3 execucoes, inclui corrida de revogacao via barreira `pg_stat_activity`, sem sleeps frageis); auth 5/5; `app.test.ts` 10/10; `pnpm check` exit 0; E2E operacional 6/6; `git diff --check` exit 0 (somente avisos LF/CRLF). Revisao independente pendente; web forms de usuarios ficam para recorte posterior. Bloco 5 segue `PARCIAL`; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 - revisao independente final da gestao administrativa de usuarios via API

- A revisao encontrou e o executor corrigiu o risco de autorizacao obsoleta: POST/PATCH agora relê sessao ativa, papel/permissoes e CSRF depois do lock dentro da transacao; revogacao/desativacao retorna 401 e rebaixamento retorna 403 sem usuario, auditoria ou update residual.
- `usersQuerySchema` foi tornado strict. A regressao deterministica usa barreira observavel em `pg_stat_activity`, sem sleep fragil; a corrida de papeis preserva exatamente um administrador ativo. `LAST_ADMIN` permanece defesa em profundidade coerente com os papeis fixos e a protecao de si proprio.
- Validacao independente pos-correcao: users 9/9; auth 5/5; `pnpm check` exit 0 (lint, tipos, contratos 8, API unit, web 112, builds); E2E operacional 6/6; `git diff --check` exit 0 (somente avisos LF/CRLF). Revisao bridge final: nenhum achado Critical, Important ou Minor.
- Recorte aprovado para progressao, sem formularios web, hard-delete, editor de permissoes, alteracao de senha, integracao externa ou Bloco 6. Bloco 5 permanece `PARCIAL`; Bloco 6 permanece `NAO_FEITO`.

### 2026-09-04 - Bloco 5, recorte: formularios web de gestao administrativa de usuarios

Antes: a API administrativa de usuarios ja estava aprovada, mas Configuracoes ainda oferecia apenas diretorio read-only; nao havia criacao/edicao/desativacao web nem tratamento verificavel de erros e retry.

Depois:
- Web: administradores com `users:manage`/`*` podem criar usuario (username normalizado, papel fixo e senha 12-256), editar nome/papel/ativo e desativar somente apos confirmacao. Operadores/gestores continuam sem chamadas de `/users`.
- PATCH envia somente o delta em relacao ao snapshot estavel da abertura; nenhum campo inalterado pode reverter uma mudanca concorrente e o retry reutiliza exatamente o mesmo body. Nenhuma alteracao nao gera request.
- A confirmacao usa payload congelado com `active:false`, portal/backdrop e modal acessivel com `aria-modal`, nomes/descricao, isolamento integral da arvore via `inert`/`aria-hidden`, foco inicial, ciclo Tab/Shift+Tab, Escape, cleanup/restauracao dos atributos e foco de retorno. Erros mantem o editor e focam retry; sucesso fecha e devolve foco a busca do diretorio.
- CSRF continua delegado ao helper existente; mensagens de `USERNAME_TAKEN`, `SELF_PROTECTION`, `LAST_ADMIN`, `USER_NOT_FOUND`, `INVALID_CSRF` e validacao sao seguras, sem expor detalhes brutos. Sessao nao-401 oferece retry local; 401 mantem entrada para login. Nao ha hard-delete, editor de permissoes ou alteracao de senha.

Validacao independente pos-correcao: `SettingsPage.test.tsx` + `NewSaleCheckout.test.tsx` + `OperationalPages.test.tsx` 62/62; `pnpm check` exit 0 (contratos 8, API unit 17 + 2 skips preexistentes, web 131, builds); `git diff --check` exit 0 (somente avisos LF/CRLF). O E2E operacional observou 6/6 no executor e em execucao direta; o preview permaneceu vivo apos os testes na invocacao direta, sem falha de teste. Revisao bridge final: nenhum achado Critical, Important ou Minor.

Este recorte esta aprovado para progressao. Bloco 5 permanece `PARCIAL`: upload/sincronizacao de catalogo, perfis finais, monitoramento/alertas externos, backup/restore homologado e integracoes reais ainda dependem de contratos, implementacao ou gates externos. Blocos 0-5 permanecem `PARCIAL`; Bloco 6 permanece `NAO_FEITO`.

### 2026-09-04 - Bloco 5, recorte: backup/restore local endurecido

Antes: os scripts criavam dumps com nome previsivel, liam o arquivo inteiro para checksum, aceitavam destino de restore controlado apenas pelo host visivel e passavam a URL completa (incluindo senha) aos processos `pg_*`; a verificacao de migrations aceitava qualquer contagem positiva.

Depois:
- `scripts/backup-db.mjs` e `scripts/restore-drill.mjs` usam nomes unicos, sidecar SHA-256 atomico e hash por streaming; falhas removem artefatos incompletos sem gerar checksum falso.
- O destino de backup e canonizado com `realpath` e a cadeia de ancestrais e inspecionada para `PG_VERSION`, cobrindo subdiretorios, symlinks e junctions. O restore aceita somente loopback (`localhost`, `127.0.0.1`, `::1`), rejeita query/fragmento/alias e reconstrói URI sanitizada, sem bypass por variaveis libpq herdadas mesmo com casing variado no Windows.
- Credenciais usam `PGPASSFILE` temporario exclusivo, com modo restritivo, limpeza em sucesso/falha/sinais e sem senha em argv/logs. Parametros seguros de conexao (por exemplo `sslmode`) sao preservados no backup; overrides de destino/credenciais e parametros desconhecidos sao recusados.
- O ensaio consulta e compara exatamente os nomes de migrations em `apps/api/migrations` (sem duplicatas, ausencias ou extras), restaura com `--clean --if-exists --no-owner --exit-on-error` e nao acessa producao.

Validacao independente final: `scripts/backup-restore-lib.test.mjs` + `scripts/backup-restore-scripts.test.mjs` 25/25; `pnpm check` exit 0 (lint, tipos, contratos 8, API unit 17 + 2 skips preexistentes, web 131, builds); `git diff --check` exit 0 (somente avisos LF/CRLF). Revisao bridge final: nenhum achado Critical, Important ou Minor apos a correcao de casing das variaveis de ambiente. Homologacao real com PostgreSQL/`pg_dump`/`pg_restore`/`psql` permanece pendente porque Docker e as ferramentas nao estao disponiveis neste ambiente; nenhum banco real, segredo ou backup existente foi acessado.

Este recorte esta aprovado para progressao. Bloco 5 permanece `PARCIAL` e Bloco 6 permanece `NAO_FEITO`; armazenamento/retencao externos, execucao periodica real, restore homologado e gates humanos/externos continuam pendentes.

### 2026-09-04 - Bloco 1/5, recorte: base PWA instalavel e cache seguro

- Web: manifest `pt-BR` com shell standalone em `/inicio`, escopo raiz, cores do produto e icones PNG full-bleed 180/192/512; HTML anuncia a manifest, o icone Apple e metadados moveis. O registro do service worker ocorre somente em build de producao e tolera navegadores sem suporte.
- Service worker: cache versionado por hash do build, limpeza de versoes antigas, precache estrito dos bundles listados pelo manifest de build do Vite, fallback de navegacao para o shell estatico e revalidacao com ciclo de vida estendido. O cache de runtime aceita somente GET same-origin de paths publicos (`/assets/`, `/icons/` e manifest) sem query e sem autorizacao; `/api`, documentos personalizados, credenciais inclusivas e metodos de escrita nunca entram no cache.
- Operacao: instalacao/atualizacao e a limitacao de que toda mutacao exige rede/API foram documentadas. Nao foi prometido modo offline transacional.

Validacao independente final deste recorte: `node --test scripts/pwa-validation.test.mjs` 8/8; `pnpm --filter @erp/web test -- src/pwa.test.ts` 3/3; `pnpm --filter @erp/web typecheck` e build web exit 0 (inclui `dist/.vite/manifest.json`, `dist/sw.js` revisado e PNGs); `pnpm check` exit 0 (lint, tipos, contratos 8, API unit 17 + 2 skips preexistentes, web 134, builds); `node --check apps/web/sw.js` exit 0; `git diff --check` exit 0 (somente avisos LF/CRLF). Revisao bridge final: `PASS / ACCEPTED`, sem blockers no recorte. Instalacao em dispositivo, auditoria visual real e homologacao offline permanecem gates pendentes; Blocos 0-5 seguem `PARCIAL` e Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 - fonte MySQL de homologacao capturada

- A configuração do ERP desktop confirmou `localhost:3306` e o banco autorizado `gemini_teste`; o serviço MySQL local respondeu normalmente. Foi criado o dump somente leitura `backups/gemini_teste-mysql-20260904-090700.sql` (47.601 bytes, 8 tabelas e 6 blocos de dados) com SHA-256 `25716F4E884A1C72D05A7D6084CCE9A8A7621BC0C89DC7251AF107260308464E`.
- O dump será usado somente como fonte autorizada para migração/homologação do PostgreSQL; a natureza dos dados deve ser confirmada pelo responsável antes de qualquer exposição ou compartilhamento. Nenhuma escrita foi feita no MySQL e nenhum segredo foi exposto. O dump permanece fora do Git até decisão de armazenamento/retencao.

### 2026-09-04 - Bloco 5, recorte: catalogo com upload de midia, leitura segura e sincronizacao

Antes: `/catalogo` era somente leitura com placeholder (`hasImage` booleano), as tabelas `media` e `catalog_sync_runs` existiam no schema sem nenhum modulo na API, e nao havia upload, leitura de imagem nem fronteira de sincronizacao.

Depois:
- API: novo modulo `apps/api/src/modules/catalog` registrado em `app.ts`. `POST /catalog/images` exige sessao, `catalog:write` e CSRF, recebe multipart via `@fastify/multipart` e valida extensao, MIME declarado e assinatura (magic bytes JPEG/PNG/WebP), limite de 5 MiB e SHA-256; a gravacao e atomica (temporario `wx` + fsync + renomeacao dentro de `MEDIA_STORAGE_DIR`), a linha so e confirmada apos o arquivo existir, falha de storage/transacao faz rollback e remove temporarios (sem orfaos), repeticao do mesmo arquivo para o mesmo produto e idempotente (200 `deduplicated`), `Idempotency-Key` cobre replay (409 em reuso com payload diverso) e a resposta nao expoe `storage_key` nem caminho local. `GET /catalog/media/:id` (permissao `inventory:read`) serve somente midia ativa por uuid opaco com allowlist de chave + contencao de caminho, ETag/304, `Content-Disposition` sanitizado e 404 sanitizado quando o arquivo falta. `POST /catalog/sync` (permissao `catalog:write` + CSRF, rate limit) executa um provedor substituivel: `LocalDirectoryCatalogSyncProvider` (diretorio `CATALOG_SYNC_LOCAL_DIR` com `Clube__Modelo.ext`) funciona hoje sem rede; `DriveCatalogSyncProvider` e um adapter isolado que exige credenciais apenas por ambiente e falha de forma controlada (`provider_not_configured`) sem credencial no codigo; itens validados pelo mesmo pipeline produzem `completed`/`partial`/`failed` com erros tipados por item, run auditada (`catalog.sync`) e idempotencia por chave; falha externa nao afeta vendas, estoque ou leitura local (provado em teste). `GET /products` agora retorna `mediaId` por produto.
- Web: `/catalogo` exibe imagem real (`/api/catalog/media/:id`) com fallback de erro recuperavel ("Recarregar imagem"), placeholder quando ausente, upload por cartao apenas para `catalog:write`/`*` com estado de envio, erro com retry que reenvia o mesmo arquivo, e painel de sincronizacao com estados em andamento/concluida (contagens)/parcial (lista de erros)/falha/nao configurada e chave de idempotencia reutilizada no retry. Filtros, paginação e URL permanecem intactos; nenhum caminho local ou dado sensível chega ao navegador.
- Operacao: `docs/OPERACAO.md` documenta `MEDIA_STORAGE_DIR` (incluido no compose como volume `media-data`), limites de upload, backup do diretorio de midia, provedores de sync e estados da run; `.env.example` recebe as variaveis de sincronizacao. `playwright.config.ts` propoe `E2E_MEDIA_DIR` para a API de E2E.
- Testes: unitarios de storage/validacao/provedores (17) cobrem gravacao atomica sem temporarios, rejeicao de traversal, sniffing de assinaturas, sanitizacao de nome e adapter Drive com fetch simulado (sem rede); integracao HTTP (16) cobre 401/403/CSRF, uuid inexistente, MIME/extensao/magic bytes invalidos, >5 MiB, checksum, rollback/limpeza, idempotencia e replay, 304/ETag, falha de integridade, sync completo/parcial/falho/nao configurado e leitura local preservada; componentes web (7 novos) e E2E full-stack dedicado (`tests/e2e/catalog-fullstack.spec.ts`, 1/1) com storage temporario e provedor local real.

Validacao: `pnpm check` exit 0 (lint, tipos, contratos 8, API unitaria 34 + 2 skips preexistentes, web 141, builds); integracao PostgreSQL isolada em `erp2_test` (WSL2, porta 55432): 16 arquivos, 100/100, exit 0; E2E mock operacional 6/6; E2E full-stack de catalogo 1/1 (upload real de PNG, leitura de midia com `content-type: image/png` e bytes identicos, sync `completed`); `git diff --check` exit 0 (somente avisos LF/CRLF preexistentes). Bloco 5 permanece `PARCIAL`: adapter Google Drive sem homologacao com credenciais reais, perfis finais, monitoramento/alertas externos e aprovacoes do responsavel seguem pendentes; Bloco 6 segue `NAO_FEITO`.

### 2026-09-04 - Bloco 5, evidencia: ensaio real de backup/restauracao no PostgreSQL de teste

Primeira homologacao real do procedimento de backup/restauracao, executada com os binarios PostgreSQL 16.14 do WSL2 (pg_dump/pg_restore/psql agora disponiveis; Docker e node/WSL seguem indisponiveis para rodar os scripts do repositorio em um unico ambiente) contra o banco exclusivamente sintetico `erp2_test` (porta 55432):

- `pg_dump --format=custom --no-owner` produziu dump de 202.934 bytes, SHA-256 `44136601bfa6781b0ed22711b361d189ae96847e0161248c953995950bc9bc4a`.
- `pg_restore --clean --if-exists --no-owner --exit-on-error` restaurou integralmente em banco descartavel `erp2_restore_test` sem nenhum erro.
- Verificacao pos-restore: `schema_migrations` contem exatamente `001_initial.sql`, `002_manager_purchase_read.sql` e `003_manager_customers_read.sql`, igual ao diretorio `apps/api/migrations` (sem duplicatas, ausencias ou extras); dados de teste presentes (ex.: 4 linhas em `media`).
- Banco de restauracao removido apos a verificacao; `erp2_test` intacto. Nenhuma credencial real, producao ou backup preexistente foi acessado.

Gap restante: os scripts `scripts/backup-db.mjs`/`scripts/restore-drill.mjs` (com toda a cadeia de seguranca propria) ainda nao foram executados de ponta a ponta porque exigem node e pg_* no mesmo ambiente; o procedimento de banco subjacente e os mesmos flags agora estao provados. O dump nao inclui o diretorio de midia (`MEDIA_STORAGE_DIR`), que precisa de copia externa propria, ja documentado em `docs/OPERACAO.md`.

### 2026-09-04 - Bloco 5, revisao do recorte de catalogo: quatro correcoes obrigatorias

Antes: a rota `GET /catalog` exigida pelos documentos nao existia (a UI chamava `GET /products`); `catalogSyncProviderFromEnv` devolvia um provedor local sem diretorio, cujo manifest vazio fazia `POST /catalog/sync` responder `completed` sem configuracao nenhuma; a rota de sync mantinha uma transacao aberta enquanto `executeSync`/`attachImageToProduct` abriam outras conexoes do pool (travamento garantido com pool minimo e run presa em `running` se a finalizacao falhasse); a documentacao afirmava "sem orfaos" de forma absoluta, mas uma queda do processo entre a gravacao do arquivo e o `COMMIT` pode deixar arquivo nao referenciado (nao ha reconciliacao de crash).

Depois:
1. `GET /catalog` implementado em `apps/api/src/modules/products/routes.ts` como alias canônico do mesmo handler de `GET /products` (mesma autorizacao `inventory:read`, filtros, ordenacao, paginacao, `mediaId` e redacao de `currentCost` — zero duplicacao de consulta). A UI `/catalogo` migrou para `/catalog` e o mock E2E ganhou a rota. Teste de integracao cobre 401, filtros (`search`, `image=with/without`), envelope de paginacao, `mediaId` apos upload, redacao de custo para quem nao tem `products:write` e paridade exata `GET /catalog` ≡ `GET /products`.
2. Resolucao real de provedor por ambiente: `catalogSyncProviderFromEnv` so devolve o provedor local com `CATALOG_SYNC_LOCAL_DIR` configurado (caso contrario `undefined` → resposta `not_configured` com run `failed`); diretorio configurado inexistente falha de forma deterministica (`local_dir_missing`); provedor que se declara nao configurado (`provider_not_configured`, ex.: Drive sem credenciais) responde `not_configured`. Testes de integracao usam um app dedicado sem provider injetado, manipulando o ambiente real: sem diretorio → `not_configured`/run `failed` (`provider_not_configured`); diretorio inexistente → `failed`/`local_dir_missing`; diretorio valido com `Env FC__Titular.png` → `completed` com 1 item anexado. Unitarios atualizados para as novas fronteiras.
3. Transacionalidade do sync reescrita em tres fases curtas: (a) transacao de abertura (idempotencia + INSERT da run `running`) commitada antes de qualquer trabalho pesado; (b) `executeSync` fora de transacao, com transacao propria por item; (c) transacao de finalizacao (UPDATE da run + auditoria + resposta idempotente). Se a execucao ou a finalizacao falham, `markRunFailed` compensa a run para `failed` (`execution_failed`/`finalization_failed`) — nunca fica presa em `running`. Testes novos: sync com pool de **uma unica conexao** conclui sem travar (o codigo anterior entraria em deadlock) e falha sintetica no UPDATE de finalizacao (pool proxy) responde 500 com run compensada para `failed`/`finalization_failed`.
4. Honestidade documental: `docs/OPERACAO.md` agora descreve a janela de queda (arquivo gravado antes do commit pode ficar sem linha apos crash; invisivel para leitura; sem reconciliacao automatica; limpeza manual segura = remover apenas arquivos ausentes de `media.storage_key`) em vez da garantia absoluta de "sem orfaos"; leitura de linha sem arquivo segue 404 sanitizado. O E2E full-stack passou a exercitar o caminho real de ambiente: `playwright.config.ts` configura `CATALOG_SYNC_LOCAL_DIR` (`E2E_SYNC_DIR` ou `e2e-artifacts/catalog-sync`) e o spec deposita `<Clube>__<Modelo>.png` antes de sincronizar.

Validacao: unitarios de catalogo 18/18; integracao PostgreSQL (`erp2_test`, WSL2 porta 55432) 16 arquivos / 106/106 testes, exit 0 — observacao registrada: com 16 suites em paralelo o total de conexoes (pools de teste) excede `max_connections=100` do cluster local e 8 suites degradam; com `--maxWorkers=4` a suite passa integral e estavel (limitacao de ambiente de teste, nao de produto); `pnpm check` exit 0 (lint, tipos, API unitaria, web 141, builds); E2E mock 6/6 (9 skipped sao os gates `E2E_FULLSTACK`, nao contados); E2E full-stack de catalogo 1/1 com upload, leitura de midia byte-a-byte e sync local real por ambiente; `git diff --check` exit 0. Blocos 0–5 permanecem `PARCIAL` e Bloco 6 `NAO_FEITO`.

### 2026-09-04 - Bloco 4, recorte: cancelamento de compra com motivo e bloqueio pos-recebimento

Antes: o doc 08 listava `POST /purchase-orders/:id/cancel` e o estado `cancelado` (com `cancellation_reason` obrigatorio no schema), mas a rota nao existia e a UI nao oferecia cancelamento; o registro de Bloco 3 tambem estava desatualizado — a UI de pagamento posterior e troca ja existe (`SalesPages.tsx`: "Registrar pagamento", "Registrar troca") e coberta por testes.

Depois:
- API: `POST /purchase-orders/:id/cancel` (permissao `purchases:write` + CSRF) em `apps/api/src/modules/purchases/routes.ts`. Transacao curta com `FOR UPDATE`: motivo obrigatorio (1-500, trim); so cancela `draft`/`placed` com `sum(received_quantity) = 0` (doc 08: "Cancelamento nao e permitido depois de recebimento sem fluxo de reversao") — caso contrario 409 `PURCHASE_ORDER_NOT_CANCELLABLE`; pedido ja cancelado responde 409 `PURCHASE_ORDER_ALREADY_CANCELLED`; inexistente 404. O motivo fica na ordem (`cancellation_reason`) e na auditoria (`purchase_order.cancel` com `previousStatus`). Cancelamento nao altera estoque nem custos (nao houve recebimento). `GET /purchase-orders/:id` agora expoe `cancellationReason`. Decisao registrada (regra 17 do goal): motivo obrigatorio, alinhado ao precedent de encomendas e a auditabilidade.
- Web: detalhe do pedido (`PurchasePages.tsx`) ganhou secao "Cancelamento" — formulario com motivo apenas para `draft`/`placed` com `purchases:write`/`*`; estados de validacao (motivo vazio sem rede), erro recuperavel via `PageError`, sucesso com recarga do detalhe, regra explicada para pedidos recebidos, permissao ausente explicita e motivo exibido nos pedidos cancelados.

Validacao: TDD (3 testes RED → GREEN) na integracao PostgreSQL `erp2_test` (cancelamento feliz com auditoria, motivo vazio 400, 401 anonimo, bloqueio apos recebimento com estado preservado, 404) — purchases 8/8; suíte completa 16 arquivos / 109/109 (`--maxWorkers=4`, teto de `max_connections=100` do cluster local com 16 suites paralelas); unitarios web de compras 12/12 (csrf, motivo obrigatorio, permissao, regra pos-recebimento, motivo exibido); `pnpm check` exit 0 (web 145); E2E mock 6/6 (9 gates skipped nao contados); `git diff --check` exit 0. Bloco 4 segue `PARCIAL` (homologacao de formularios com o responsavel) e Bloco 3 segue `PARCIAL` (aprovacao da diferenca financeira).

### 2026-09-04 - Bloco 3, recorte: estorno de venda com restauracao de estoque e pagamentos

Antes: o status `reversed` existia no schema e ja era respeitado em toda a borda (pagamentos, trocas e relatorios excluem vendas estornadas), mas nao havia endpoint nem UI para estornar — a regra do doc 06 ("correcao usa estorno autorizado") e a capability de administrador do doc 10 ("criacao, cancelamento e estorno de venda") ficavam sem implementacao.

Depois:
- API: `POST /sales/:id/reversal` (permissao nova `sales:reverse`, concedida somente ao administrador via `*` conforme doc 10; decisao registrada — motivo opcional, ate 500 caracteres, conforme decisao do proprietario de estorno sem motivo). Transacao com `FOR UPDATE`: 404 `SALE_NOT_FOUND`; 409 `SALE_ALREADY_REVERSED`; 409 `SALE_HAS_EXCHANGES` quando a venda tem trocas (as trocas ja movimentaram estoque; correcao continua pelas trocas). O estorno restaura o estoque item a item com movimento `reversal` rastreavel (`idempotency_key` unica por venda+variante), marca pagamentos `confirmed` como `reversed` (saem do caixa e dos relatorios, que ja filtram `status <> 'reversed'` e `payments.status = 'confirmed'`), marca a venda `reversed` e audita (`sale.reverse` com motivo e status anterior).
- Web: detalhe da venda (`SalesPages.tsx`) ganhou secao "Estorno" com formulario de motivo opcional apenas para perfis `sales:reverse`, estados de validacao, erro recuperavel, sucesso com recarga, regra explicada para vendas com troca e estado final para vendas estornadas.

Validacao: TDD (4 testes RED → GREEN) na integracao PostgreSQL `erp2_test` (estorno de venda paga com restauracao de estoque/pagamentos/auditoria, 401 anonimo, 403 gestor sem `sales:reverse`, estorno de parcialmente paga sem motivo, bloqueio com troca preservando estado, 404) — sales 16/16; web 18/18 (csrf, motivo opcional, erro preserva formulario, permissao, estado estornado, regra de troca); suíte completa de integração 16 arquivos / 113/113; `pnpm check` exit 0; E2E mock 6/6; `git diff --check` exit 0. Bloco 3 segue `PARCIAL` apenas pela aprovacao da diferenca financeira pelo responsavel.

### 2026-09-04 - Blocos 2/3/4/5, auditoria de repeticoes, reconciliacao de sync runs e recorte doc 05 (migracao de vendas legadas)

Auditoria pedida pela revisao (repeticoes nao podem duplicar efeitos):
- Cancelamento de compra: novo teste de integracao dispara dois `POST /purchase-orders/:id/cancel` concorrentes (Promise.all) sobre o mesmo pedido — resultado `[200, 409]` (o perdedor recebe `PURCHASE_ORDER_ALREADY_CANCELLED`), exatamente 1 linha de auditoria `purchase_order.cancel`, motivo preservado, estoque intacto. Estorno de venda: dois `POST /sales/:id/reversal` concorrentes — `[200, 409]` (`SALE_ALREADY_REVERSED`), estoque restaurado exatamente uma vez, 1 movimento `reversal`, 1 pagamento `reversed`, 1 auditoria. Nenhuma alteracao de produto foi necessaria: a serializacao por `SELECT ... FOR UPDATE` ja garantia o efeito unico; os testes passaram a prova-lo (evidencia, nao correcao).
- Compensacao de `catalog_sync_runs`: em vez de apenas documentar, implementada reconciliacao segura — no inicio de cada `POST /catalog/sync`, runs presas em `running` ha mais de 30 minutos (queda do processo antes da finalizacao) passam a `failed` com `stale_reconciled` (best-effort com `.catch`; seguro porque runs sao informativas e os itens anexados foram commitados por transacoes proprias, entao nada e revertido nem duplicado). Teste novo: run antiga reconciliada e run recente preservada em `running` no mesmo sync. `docs/OPERACAO.md` atualizado.

Novo recorte doc 05 (reconciliacao obrigatoria — "quantidade vendida historica / total das vendas / valores pendentes"):
- `apps/api/src/modules/migration/legacy-sales.ts`: migra `vendas` + `itensvenda` (dump MySQL de homologacao) para `sales`/`sale_items`/`payments`, criando `customers` faltantes por `legacy_id`. IDs deterministicos (sha256 com bits de versao UUID), `created_at` preservado do legado, status mapeado de `StatusPagamento`/`ValorPago`, pagamento com `idempotency_key` dedutivel. Reuso por checksum de fonte (`migration_runs`) — re-execucao responde `reused: true` sem duplicar (provado). Rejeicoes tipadas em `migration_rejections`: `SALE_TOTAL_MISMATCH`, `PAYMENT_INCONSISTENT`, `PENDING_SALE_MISSING_DUE_DATE`, `DUPLICATE_PRODUCT_IN_SALE`, `LEGACY_PRODUCT_NOT_MIGRATED`, `LEGACY_SALE_ALREADY_MIGRATED`. Registrada decisao: venda migrada nao gera `inventory_movements` (o saldo de abertura migrado ja reflete o estado pos-venda do legado).
- Testes: `legacy-sales.integration.test.ts` 3/3 (importacao com rejeicoes e conciliacao monetaria, replay sem duplicar, venda ja migrada rejeitada); arquivo registrado no script `test:integration` (17 suites).

Validacao observada:
- `pnpm check` exit 0 (lint, tipos, builds web/API).
- Integracao PostgreSQL isolada (`erp2_test`, WSL2 porta 55432) com `--maxWorkers=4`: **17 arquivos, 119/119 testes, exit 0**. Registro de ambiente: durante o dia a mesma suite passou a falhar por timeouts de hook de 30s; `pg_stat_activity` mostrou 15 backends parados em `DataFileImmediateSync` (fsync em rajada do ext4 no VHD do WSL2 quando 17 suites criam schemas simultaneamente). Os timeouts por hook foram elevados para 120s nos arquivos de integracao (somente infra de teste, sem codigo de produto); com isso a suite voltou a passar integral e reprodutivel.
- E2E mock operacional: 6/6 (9 gates `E2E_FULLSTACK` skipped, nao contados). E2E full-stack contra API real + `erp2_test`: catalogo, estoque, compras, venda paga (retry unico), relatorio financeiro (periodos + drilldown sem escrita), encomendas, pagamentos multiplos e criacao de venda — 8/9 verde.
- **sales-fullstack E2E: instavel, registrado sem maquiar** — falha ~50% das execucoes na etapa de troca: apos pagamento com resposta perdida + reload, o formulario de troca e remontado entre a marcacao da variante e o preenchimento das quantidades, o `<select>` nao controlado volta a vazio, o submit e bloqueado na validacao client-side e nenhum `POST /exchanges` acontece. `SalesPages.tsx` e o spec estao sem nenhuma alteracao nesta onda (o comportamento e pre-existente); um probe com os mesmos passos passou 8/8 e o estado no banco em todas as execucoes foi o correto (venda `paid` com exatamente 1 pagamento — a semantica de efeito unico do retry se mantem). Pendente investigacao da causa da remontagem; nenhum dado ou efeito duplicado foi observado.
- `git diff --check` exit 0 (somente avisos LF/CRLF preexistentes). Nenhum reset, clean, commit, stage ou push; nenhum acesso a MySQL de producao ou credenciais reais.

Bloco 5 permanece `PARCIAL` e Bloco 6 permanece `NAO_FEITO`. Pendentes do doc 05: migracao de compras em aberto (pedidosfornecedor/itenspedidofornecedor), encomendas abertas e conciliacao de saldo por SKU; investir na causa da remontagem do formulario de troca no E2E de vendas.

### 2026-09-04 - Blockers da revisao: rejeicao tipada de venda pendente sem cliente, flakiness eliminada no E2E de troca, best-effort explicito na compensacao de sync runs

1. Migracao de vendas legadas (doc 05):
- `apps/api/src/modules/migration/legacy-sales.ts`: linha `Pendente` sem cliente agora e rejeitada ANTES de qualquer INSERT com codigo tipado `PENDING_SALE_MISSING_CUSTOMER` (nao estoura mais a CHECK constraint do banco nem aborta o lote). Regra complementar registrada: `PENDING_SALE_DUE_DATE_PAST` quando a data prometida nao e posterior a data da venda — preserva "venda pendente exige cliente identificado e data futura de recebimento" (futura em relacao a venda, para nao rejeitar todo o historico legado).
- `legacy-sales.integration.test.ts` (TDD RED→GREEN, 3/3): fixture 109 (Pendente, sem cliente, com promisedDueDate) e fixture 110 (Pendente com data prometida no passado). Alem da rejeicao ordenada em `migration_rejections`, o teste prova ausencia de linhas parciais: 0 sales com legacy_id 109, 0 sale_items orfaos, e os unicos payments sao os de vendas migradas.

2. E2E de troca (flakiness sales-fullstack):
- Correcao no codigo real da UI (`SalesPages.tsx`): o `<select>` "Item vendido (devolver)" passou a ser controlado (`value={returnedId}` + `onChange` para estado React) e o submit le o estado em vez de `FormData` — o envio nunca depende do estado do DOM, que pode divergir da selecao visivel apos re-renders. O React restaura o valor controlado a cada commit (observado com hooks de setter: `option.selected = true` reaplicado pelo React por render), o que absorve corridas entre automacao e re-render.
- Investigacao com hooks de `value`/`selected` na pagina real provou: sem remontagem do formulario, eventos input/change chegam com o valor correto e o valor persiste apos 100 ms. O loop anterior (0/10) havia rodado contra bundle antigo, sem a correcao — com o bundle atual a falha nao foi reproduzida.
- Assercao fortalecida no spec (nao reduzida): `expect.poll` garante exatamente um `POST /exchanges` por execucao.
- Repeticoes observadas no codigo final sem instrumentacao: **10/10 execucoes PASS** (10/10 adicionais na rodada instrumentada), cada uma com seed nova. Banco conferido (`verify-sales-e2e.ts` na ultima execucao): venda `paid`, 1 pagamento, exatamente 1 troca com 2 itens, 3 movimentos de estoque (5→4), 1 auditoria de pagamento + 1 de troca.

3. Catalog sync (semantica da compensacao):
- Comentarios de `markRunFailed`/`reconcileStaleSyncRuns` e do ponto de chamada agora DECLARAM explicitamente o contrato best-effort: se o proprio UPDATE de compensacao falhar, a excecao e engolida de proposito; a run presa permanece `running` ate a proxima passada de reconciliacao (repetivel — cada `POST /catalog/sync` tenta de novo com threshold de 30 minutos) ou verificacao manual. O sync nunca e interrompido por falha da compensacao.
- Teste novo de evidencia em `catalog.integration.test.ts` ("falha da reconciliacao e best-effort"): pool que rejeita especificamente o UPDATE de reconciliacao — o sync responde 200 e cria sua run `failed/provider_not_configured` normalmente, e a run presa segue `running` (fica para a proxima passada). Catalogo: 24/24.

Validacao observada (ambiente local, banco de teste `erp2_test` WSL2 porta 55432; sem producao, sem credenciais reais):
- `pnpm check` exit 0 (lint, tipos, unitarios, builds).
- Integracao PostgreSQL isolada com `--maxWorkers=4`: **17 arquivos / 120/120 testes, exit 0** (119 anteriores + novo teste de compensacao).
- E2E mock: 6/6 (9 gates `E2E_FULLSTACK` skipped, nao contados).
- E2E_FULLSTACK=1 com seeds sinteticas novas por suite (`e2e-artifacts/run-fullstack-all.sh`, scripts temporarios fora do git): **9/9 PASS** — catalogo, estoque, compras, venda paga (retry unico), relatorio financeiro, encomendas, criacao de venda, pagamentos multiplos e vendas (troca). Primeira onda com 9/9 desde que o sales-fullstack existia.
- Verificacoes de banco pos-execucao (`verify-*-e2e.ts`, todas corretas): venda paga com retry unico (efeitos 1x), multi-pagamentos (2 pagamentos 90+60, `paid`), criacao de venda (pending/partial com auditorias), compras (fully_received, 2 recebimentos, estoque 14), estoque (2 ajustes, delta 8), encomendas (delivered/cancelled com auditorias, motivo preservado), relatorio financeiro (GET sem escrita: contagens de vendas/pagamentos/auditoria inalteradas).
- `git diff --check` exit 0 (somente avisos LF/CRLF preexistentes).

Blocos 0–5 permanecem `PARCIAL` e Bloco 6 permanece `NAO_FEITO`. Pendencias abertas do goal: aprovacao da diferenca financeira pelo responsavel (Bloco 3), homologacao de formularios (Bloco 4), migracao de compras em aberto e encomendas abertas com conciliacao de saldo por SKU (doc 05).

### 2026-09-05 — Onda 3: divergências da migração real corrigidas, migração determinística em homologação

Causas encontradas no dump autorizado `backups/gemini_teste-mysql-20260904-090700.sql`:

1. 56 `PAYMENT_INCONSISTENT`: semântica legada interpretada errado pelo migrador. Prova no legado: `TelaVendasController.java:407` insere a venda sem a coluna `ValorPago` (fica `0.00`); `ValorPago` só é incrementado em pagamentos posteriores (`HistoricoVendasController.java:299`) e o status vira `Pago` quando `ValorPago >= ValorFinal` (linhas 311–312). Venda criada já paga fica `Pago` com `ValorPago 0.00`. Correção em `legacy-sales.ts`: `StatusPagamento = Pago` é autoritativo; pagamento migrado = `ValorFinalVenda` com `received_at = DataVenda`; `ValorPago` do legado é ignorado para `Pago` (mantido para parciais `Pendente`).
2. Compras com recebimentos zerados: bug no parser `mysql-dump.ts` — o regex de `CREATE TABLE` parava no primeiro `)` seguido de `;`, e o match de `encomendascliente` (6423 chars) engolia o `CREATE` de `itenspedidofornecedor`, que nunca era registrado; compras normalizadas com `items: []`, 0 itens e 0 recebimentos. Correção: regex ancorada no `)` de fechamento em início de linha com `ENGINE` (`/\n\)[^;]*;/`).
3. 20 produtos rejeitados como `INVALID_LEGACY_PRODUCT`: o legado grava campos textuais sem aspas quando numéricos (tamanho infantil `28`, modelo `2006`); o parser entrega `number` e o contrato exigia `string`. Correção em `gemini-dump.ts`: coerção numérico→string em `Modelo`/`Clube`/`Tamanho`; `CustoUnitarioComTaxas` nulo usa o custo do fornecedor.

Validação observada (sem produção, sem credenciais reais; escrita só em bancos `*_test`):

- `pnpm check` exit 0 (lint, tipos, contratos 8, API unitária 35 + 2 skips preexistentes, web 151, builds API/web).
- `test:integration` oficial com `--maxWorkers=4`: **18/18 arquivos, 125/125 testes, exit 0**. `gemini-dump.integration.test.ts` precisou do mesmo timeout de hook 120 s já usado nos demais arquivos (limite do WSL/ext4 sob 18 suítes paralelas, sem código de produto).
- Testes de migração atualizados para a semântica correta (`legacy-sales` 3/3, `gemini-dump` 4/4): `Pago` com `ValorPago` divergente migra como pago pelo final; `Pendente` sem data continua rejeitada (`PENDING_SALE_MISSING_DUE_DATE`) porque a `CHECK sales_check2` e a decisão do responsável exigem cliente + vencimento para pendente.
- Migração real em banco de homologação limpo `erp2_homolog_test` (guarda `*_test`, fora do `erp2_test` do E2E): produtos **176/176, 0 rejeições, saldo 176/176**; vendas **65/69** (82 itens, 60 pagamentos); compras **6/6** (95 itens, 5 recebimentos/58 itens, recebido 87/pendente 86, status iguais ao legado); encomendas 0/0 (tabela vazia no dump); imagens 0/0 (dump não traz arquivos).
- 4 rejeições, todas `PENDING_SALE_MISSING_DUE_DATE` (vendas 8, 10, 50, 61 — `Pendente` sem `DataPrometida`, que o legado permite mas o sistema novo proíbe).
- Replay: `reused: true` nos 4 módulos sem duplicar (65/82/60 reconferidos no banco).
- Reconciliação determinística, todas as divergências explicadas: vendas 10280,00→9500,00 (780,00 = 4 rejeitadas 120+80+280+300); pago legado 740,00 vs migrado 8010,00 (legado não preenche `ValorPago` na criação); pendente 2270,00 vs 1490,00 (780,00 rejeitado); 6 SKUs com unidades divergentes (itens das 4 rejeitadas); compras por status `fully_received 4 / placed 1 / partially_received 1` iguais ao legado.
- `git diff --check` limpo (somente avisos LF/CRLF preexistentes); grep por debug/skips/`SPEC_DIAG` vazio em `migration`; scripts de diagnóstico temporários removidos; nenhum commit/stage/push; nenhuma escrita no MySQL.

Bloco 6 passa a `PARCIAL` (itens 1–2 do roadmap: migração completa em homologação + rejeições corrigidas até resultado determinístico). Seguem pendentes: treinamento, operação paralela, checklist/aprovação de corte e migração incremental/final; E2E fullstack não reexecutado nesta onda (nenhuma rota de produto foi alterada — só biblioteca de migração usada por testes e script isolado).
