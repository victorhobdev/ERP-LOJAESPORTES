# Operação do ERP 2.0

## Subida local reproduzível

Para abrir a homologação neste PC, com PostgreSQL local na porta 55432:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

Acesse http://127.0.0.1:5173. Na primeira execução o comando cria `vitinho.local` e mostra uma senha aleatória; nas seguintes preserva a senha. Usa exclusivamente `erp2_homolog_test`, com os dados migrados. Logs ficam em `e2e-artifacts/local-api.log` e `local-web.log`. O PostgreSQL precisa estar ligado. Os processos ficam em segundo plano; após reiniciar o PC execute novamente o comando.

A operação com API e banco neste PC funciona sem internet. A sincronização Drive exige internet; sem API/banco local disponíveis as operações não podem ser gravadas.

## Conferência pós-dump Gemini

O ajuste de conferência de 05/09/2026 é executado somente pelo runner dedicado e exige que o banco conectado seja exatamente `erp2_homolog_test`. O modo padrão é somente leitura:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/erp2_homolog_test'
pnpm --dir apps/api exec tsx scripts/migrate-gemini-conference.ts
```

O relatório é salvo em `e2e-artifacts/migration-gemini-conference-report.json`. Não usar `--apply` sem aprovação explícita do responsável; o runner não aceita produção e não cria recebimentos para o fechamento administrativo.

Alternativa com Docker:

1. Copie `.env.example` para `.env` e troque todas as credenciais.
2. Execute `docker compose up --build -d`.
3. Aguarde `docker compose ps` mostrar PostgreSQL e API como `healthy`.
4. Acesse `http://127.0.0.1:8080`. A API fica exposta apenas pelo proxy `/api`.

As migrations são aplicadas pela API antes de aceitar tráfego. Não reutilize banco de produção para testes ou ensaios.

## Instalação e atualização da PWA

Abra a aplicação em uma origem segura (`https://`) ou em `http://127.0.0.1` durante o desenvolvimento e use a opção
de instalar do navegador. O shell estático e os ícones são versionados pelo template `apps/web/sw.js`; ao publicar uma versão nova,
o service worker troca o cache antigo depois de ativar o novo e, no build de produção, pré-carrega os bundles listados
em `dist/.vite/manifest.json`. O worker nunca armazena respostas de `/api`, documentos personalizados, requisições com
query, autorização ou métodos de escrita.

A PWA não implementa operação offline transacional. Vendas, pagamentos, estoque, compras, encomendas e demais mutações
exigem rede e confirmação da API; se a conexão cair, corrija a conectividade e repita a ação a partir do estado exibido.

## Imagens do catálogo e sincronização

O upload de imagens (`POST /api/catalog/images`, permissão `catalog:write` + CSRF) aceita somente JPEG, PNG e WebP, com validação de extensão, MIME declarado e assinatura (magic bytes), limite de 5 MB e checksum SHA-256. A imagem pertence ao produto lógico (clube + modelo); repetir o mesmo arquivo para o mesmo produto é idempotente (não duplica linha nem arquivo) e a chave `Idempotency-Key` cobre reenvios de rede. A gravação é atômica (temporário + renomeação dentro do diretório configurado) e, em falhas normais (validação, storage, transação), o rollback remove o arquivo e nenhuma linha sem arquivo é confirmada. A leitura (`GET /api/catalog/media/:id`, permissão `inventory:read`) só serve mídia ativa por identificador opaco, sem traversal e sem expor caminhos locais.

A listagem canônica do catálogo é `GET /api/catalog` (permissão `inventory:read`), com os mesmos filtros, paginação, `mediaId` e redação de custo de `GET /api/products`, que segue disponível como rota de estoque.

**Limitação conhecida (janela de queda):** o arquivo é gravado no storage antes do `COMMIT` da transação do banco. Se o processo cair exatamente entre a gravação e o commit, o arquivo pode ficar sem linha correspondente — fica invisível para leitura (toda leitura exige linha ativa) e não corrompe dados, mas não há reconciliação automática de órfãos implementada. Limpeza manual segura: remover apenas arquivos cujo nome não exista em `media.storage_key`. Se uma linha referenciar arquivo ausente (ex.: storage restaurado sem o diretório), a leitura responde 404 sanitizado.

- `MEDIA_STORAGE_DIR`: diretório local obrigatório para gravar os arquivos (no `compose.yml` é o volume `media-data:/data/media`). Inclua este diretório na estratégia de backup/cópia externa junto com o banco; o dump do PostgreSQL não contém as imagens. Sem a variável, uploads retornam `MEDIA_STORAGE_NOT_CONFIGURED` e o restante do sistema continua operando.
- Sincronização (`POST /api/catalog/sync`, permissão `catalog:write` + CSRF): provedor substituível, sem rede externa obrigatória. `CATALOG_SYNC_PROVIDER=local` (padrão) lê o diretório `CATALOG_SYNC_LOCAL_DIR` com arquivos nomeados `Clube__Modelo.ext` — sem essa variável o provedor não é considerado configurado; com a variável apontando para um diretório inexistente, a execução falha de forma determinística (`local_dir_missing`). `CATALOG_SYNC_PROVIDER=drive` usa o adapter isolado do Google Drive, que exige `CATALOG_SYNC_DRIVE_FOLDER_ID` e `CATALOG_SYNC_DRIVE_ACCESS_TOKEN` exclusivamente por ambiente (nenhuma credencial no código). Sem provedor válido, a execução responde `not_configured` e registra a run como `failed` controlado, sem afetar vendas, estoque ou leitura local. A execução não mantém transação aberta durante a sincronização (fases curtas de abertura/finalização), funciona com pool mínimo e, se a execução ou a finalização falharem, a run é marcada `failed` (`execution_failed`/`finalization_failed`) em vez de permanecer `running`. Runs `running` com mais de 30 minutos (queda do processo antes da finalização) são reconciliadas como `failed` (`stale_reconciled`) no início da próxima sincronização; itens já anexados por transações próprias não são revertidos nem duplicados por essa reconciliação.
- Estados da run em `catalog_sync_runs`: `completed` (todos os itens anexados), `partial` (alguns itens com erro tipado por item, por exemplo `PRODUCT_NOT_FOUND`, `IMAGE_TOO_LARGE`), `failed` (nenhum item anexado, falha do provedor ou provedor não configurado) e `running` durante a execução. Cada execução é auditada (`catalog.sync`) e uploads individuais também (`catalog.image.upload`).
- Integração Google Drive implementada como adapter, mas ainda sem homologação com credenciais reais; permanece pendência externa.

## Compras: cancelamento de pedido

`POST /api/purchase-orders/:id/cancel` (permissão `purchases:write` + CSRF) cancela pedidos em `draft` ou `placed` com motivo obrigatório (1–500 caracteres), que fica na própria ordem (`cancellation_reason`) e na auditoria (`purchase_order.cancel`). Cancelamento é proibido depois de qualquer recebimento (409 `PURCHASE_ORDER_NOT_CANCELLABLE`, conforme doc 08 — correção de recebimento usa estorno) e pedido já cancelado responde 409 `PURCHASE_ORDER_ALREADY_CANCELLED`. O cancelamento não altera estoque nem custos (não havia recebimento); a interface de detalhe do pedido só oferece o formulário para perfis autorizados e exibe o motivo nos pedidos cancelados.

## Vendas: estorno

`POST /api/sales/:id/reversal` (permissão `sales:reverse`, concedida apenas ao administrador — doc 10; decisão do proprietário: pode ser feito sem motivo) devolve integralmente o estoque dos itens (movimento `reversal` rastreável), marca os pagamentos confirmados como `reversed` (saem automaticamente do caixa e dos relatórios, que já excluem vendas `reversed`) e registra a ação na auditoria (`sale.reverse`, com motivo opcional e status anterior). Motivo é opcional, até 500 caracteres. Venda com troca não pode ser estornada (409 `SALE_HAS_EXCHANGES`) porque as trocas já movimentaram estoque — a correção nesse caso continua pelas trocas; venda estornada rejeita novos pagamentos e trocas (409).

## Verificação

Fullstack no Windows (Git Bash, Node no PATH; portas 3333 e 4173 livres):

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" -lc 'TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh'
```

Cada suíte cria sua seed; aceite: 9 passed / 0 failed of 9, com verificadores de persistência. O bash do WSL sem Node no PATH não executa esse runner.

- `pnpm check`: lint, tipos, unitários e builds.
- `TEST_DATABASE_URL=... pnpm --filter @erp/api test:integration`: transações e concorrência em PostgreSQL dedicado `erp2_test`.
- `pnpm test:e2e`: interface em Chromium, com API sintética interceptada.
- `GET /api/health`: liveness do processo. O healthcheck do container também aguarda o banco pela inicialização/migrations.
- `GET /api/health/ready`: prontidão (200 `ready` sempre que o banco responde, independente do catálogo; 503 `not_ready` sem banco ou com banco fora do ar, com corpo sanitário). `integrations.catalog` é apenas informativo (`configured` somente com `CATALOG_SYNC_ENABLED=true`, sem verificar conectividade). `APP_VERSION` define a versão exibida quando semver válida de até 32 caracteres (padrão `0.0.0`).

## Backup

Política confirmada: um backup mensal no próprio PC, fora do diretório de dados, sem sobrescrever arquivos nem apagar backups automaticamente. Incluir mídia local. O agendamento mensal ainda deve ser instalado para o ambiente definitivo; a política descrita não equivale a uma tarefa já agendada.

Com `pg_dump` no `PATH`, configure `DATABASE_URL` e um `BACKUP_DIR` absoluto fora do volume do PostgreSQL, então rode `node scripts/backup-db.mjs`. O script recusa destino relativo, raiz do sistema e diretório com `PG_VERSION`, gera nome único sem sobrescrever, exige dump não vazio e grava o `.sha256` de forma atômica; falha do `pg_dump` não deixa checksum falso e nada é impresso com segredo. Parâmetros de conexão seguros como `sslmode=require` são preservados; overrides de destino/credenciais e parâmetros desconhecidos são recusados. Copie ambos para armazenamento fora da máquina e aplique a retenção aprovada.

## Ensaio de restauração

Crie previamente um banco descartável cujo nome termine em `_restore_test` e disponibilize o PostgreSQL por loopback (o `compose.yml` não publica a porta por padrão; use uma exposição/port-forward local aprovado, sem usar aliases DNS). Configure `BACKUP_FILE` e `RESTORE_DATABASE_URL` e execute `node scripts/restore-drill.mjs`. O script exige arquivo regular absoluto, sidecar `.sha256` válido com checksum correspondente, host de loopback (`localhost`, `127.0.0.1` ou `::1`), sem query/fragmento, e recusa produção/remoto mesmo com sufixo; restaura com `--clean --if-exists --no-owner --exit-on-error`, usa `PGPASSFILE` temporário sem expor a senha em argumentos e comprova exatamente o conjunto de migrations versionadas em `schema_migrations` via `psql`. Nunca aponte o ensaio para produção. Suítes: `node --test scripts/backup-restore-lib.test.mjs` e `node --test scripts/backup-restore-scripts.test.mjs` (fakes via `ERP2_TEST_PG_*` somente com `NODE_ENV=test`; sem ensaio real homologado — Docker/pg_* indisponíveis neste ambiente).

## Alertas mínimos

Monitore falha/reinício dos processos, cinco erros HTTP em janela curta, indisponibilidade de `/api/health`, backup com mais de 31 dias e falha do ensaio periódico. Logs da API são JSON e removem cookies, autorização e `set-cookie`.

## Pendências externas antes do corte

- configurar Google Drive com credenciais fornecidas pelo responsável e homologar a conexão;
- definir vencimentos históricos das vendas 8, 10, 50 e 61 ou aprovar explicitamente a exclusão; R$ 780,00 seguem registrados no dump e nas rejeições, sem descarte;
- validar as telas com o único usuário, definir período paralelo e aprovar o corte final;
- instalar e conferir o backup mensal no ambiente definitivo, incluindo mídias.
