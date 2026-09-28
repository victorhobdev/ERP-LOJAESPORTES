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
| Migrações são aplicadas uma vez e registradas por checksum | `database.integration.test.ts` | Módulo `migrate.js` ausente | PASS; primeira execução aplica `001`, segunda aplica zero e checksum tem 64 hex |
| Rollback remove escrita parcial em PostgreSQL servidor | `database.integration.test.ts` | Módulo `migrate.js` ausente | PASS; produto inserido dentro da transação não existe após rollback |

O teste possui guarda de segurança e recusa execução se `current_database()` não for exatamente `erp2_test`.

Comando RED: `$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_test'; pnpm --filter @erp/api test:integration`. O primeiro comando revelou glob incompatível no Windows; após corrigir o runner para o caminho exato, o RED válido foi a ausência exclusiva de `migrate.js`.

## GREEN

- Mesmo comando do RED: 1 arquivo, 2 testes PASS em aproximadamente 9,6 s.
- Cada execução cria um schema aleatório com prefixo `erp2_test_`, configura `search_path`, executa os testes e remove somente esse schema no teardown.
- A guarda confirma `current_database() = 'erp2_test'` antes de qualquer DDL destrutiva.
- `pnpm check` foi executado em paralelo e também passou integralmente.

Incidente de gate: a primeira tentativa excedeu o timeout de 5 s enquanto o PostgreSQL ainda concluía a migração. A inspeção mostrou todas as tabelas e o checksum gravados. O teste foi isolado por schema aleatório e recebeu timeout explícito de 30 s; a repetição passou, sem mascarar falha SQL.
