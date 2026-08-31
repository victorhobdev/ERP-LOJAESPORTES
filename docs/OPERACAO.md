# Operação do ERP 2.0

## Subida local reproduzível

1. Copie `.env.example` para `.env` e troque todas as credenciais.
2. Execute `docker compose up --build -d`.
3. Aguarde `docker compose ps` mostrar PostgreSQL e API como `healthy`.
4. Acesse `http://127.0.0.1:8080`. A API fica exposta apenas pelo proxy `/api`.

As migrations são aplicadas pela API antes de aceitar tráfego. Não reutilize banco de produção para testes ou ensaios.

## Verificação

- `pnpm check`: lint, tipos, unitários e builds.
- `TEST_DATABASE_URL=... pnpm --filter @erp/api test:integration`: transações e concorrência em PostgreSQL dedicado `erp2_test`.
- `pnpm test:e2e`: interface em Chromium, com API sintética interceptada.
- `GET /api/health`: liveness do processo. O healthcheck do container também aguarda o banco pela inicialização/migrations.

## Backup

Com `pg_dump` no `PATH`, configure `DATABASE_URL` e um `BACKUP_DIR` absoluto fora do volume do PostgreSQL, então rode `node scripts/backup-db.mjs`. O script cria dump custom e arquivo `.sha256` exclusivo. Copie ambos para armazenamento fora da máquina e aplique a retenção aprovada.

## Ensaio de restauração

Crie previamente um banco descartável cujo nome termine em `_restore_test`. Configure `BACKUP_FILE` e `RESTORE_DATABASE_URL` e execute `node scripts/restore-drill.mjs`. O script recusa outros nomes, valida checksum, restaura com `--exit-on-error` e confirma a tabela de migrations. Nunca aponte o ensaio para produção.

## Alertas mínimos

Monitore falha/reinício dos containers, cinco erros HTTP em janela curta, indisponibilidade de `/api/health`, ausência do backup diário e falha do ensaio periódico. Logs da API são JSON e removem cookies, autorização e `set-cookie`.

## Pendências externas antes do corte

- confirmar banco MySQL oficial e obter cópia somente leitura;
- aprovar regime de reconhecimento financeiro e política de diferenças em trocas;
- configurar armazenamento/Google Drive e credenciais sem versioná-las;
- definir retenção dos backups, janela de paralelismo/corte e responsáveis;
- homologar impressão/dispositivos, concorrência real e usabilidade com usuários responsáveis.
