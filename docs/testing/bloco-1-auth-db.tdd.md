# Evidência TDD — Bloco 1, autenticação e banco

## Fonte

- `docs/reconstrucao-erp/04-backend-api.md`
- `docs/reconstrucao-erp/05-dados-migracao.md`
- `docs/reconstrucao-erp/10-seguranca-operacao.md`
- `docs/reconstrucao-erp/11-roadmap-validacao.md`

## Garantias do ciclo

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Schema reexecutável contém as entidades operacionais planejadas | `apps/api/src/shared/db/migration.test.ts` | ENOENT para `001_initial.sql` | PASS; 25 tabelas exigidas encontradas após duas execuções |
| Banco rejeita saldo negativo | `apps/api/src/shared/db/migration.test.ts` | ENOENT para `001_initial.sql` | PASS; constraint rejeitou `stock_quantity = -1` |
| RBAC nega permissão ausente e aceita wildcard administrativo | `apps/api/src/shared/auth/authorization.test.ts` | Módulo `authorization.js` ausente | 2 testes PASS |
| Sessão e CSRF usam segredos opacos armazenados por hash | `apps/api/src/shared/auth/session.test.ts` | Módulo `session.js` ausente | 2 testes PASS |

PGlite é usado somente para validação rápida de sintaxe/invariantes PostgreSQL enquanto o daemon Docker local está indisponível. Ele não satisfaz nem será reportado como teste de integração com servidor PostgreSQL real.

Comando RED: `pnpm --filter @erp/api test`. Resultado: 3 arquivos/4 alvos falharam exclusivamente pelas implementações ainda ausentes; os 3 testes anteriores da API permaneceram verdes.

## GREEN e cobertura

- `pnpm --filter @erp/api test`: 5 arquivos, 9 testes PASS.
- `pnpm check`: ESLint, tipos, 19 testes totais e builds de produção PASS.
- `pnpm test:coverage`: API 91,42% statements, 85,71% branches, 90,9% functions e 93,75% lines; contratos e web 100% no código incluído.
- O schema usa `numeric(14,2)`, checks de quantidade/saldo, chaves únicas de idempotência, trilha de auditoria, sessões com hashes e todas as entidades dos documentos 00–11.

Lacuna preservada: esses resultados não substituem a execução do mesmo schema, transações e concorrência em um servidor PostgreSQL isolado.
