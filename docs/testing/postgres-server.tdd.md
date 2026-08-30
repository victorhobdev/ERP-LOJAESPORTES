# Evidência TDD — servidor PostgreSQL

## Ambiente isolado

- PostgreSQL 16.14 em WSL2.
- Cluster descartável: `/tmp/erp2-postgres-20260830`.
- Banco dedicado: `erp2_test`.
- Porta local: `55432`.
- Sem credenciais ou dados reais.

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Migrações são aplicadas uma vez e registradas por checksum | `database.integration.test.ts` | Módulo `migrate.js` ausente | Pendente |
| Rollback remove escrita parcial em PostgreSQL servidor | `database.integration.test.ts` | Módulo `migrate.js` ausente | Pendente |

O teste possui guarda de segurança e recusa execução se `current_database()` não for exatamente `erp2_test`.

Comando RED: `$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_test'; pnpm --filter @erp/api test:integration`. O primeiro comando revelou glob incompatível no Windows; após corrigir o runner para o caminho exato, o RED válido foi a ausência exclusiva de `migrate.js`.
