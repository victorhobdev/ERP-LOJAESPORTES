# Evidência TDD — Bloco 1, autenticação e banco

## Fonte

- `docs/reconstrucao-erp/04-backend-api.md`
- `docs/reconstrucao-erp/05-dados-migracao.md`
- `docs/reconstrucao-erp/10-seguranca-operacao.md`
- `docs/reconstrucao-erp/11-roadmap-validacao.md`

## Garantias do ciclo

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Schema reexecutável contém as entidades operacionais planejadas | `apps/api/src/shared/db/migration.test.ts` | ENOENT para `001_initial.sql` | Pendente |
| Banco rejeita saldo negativo | `apps/api/src/shared/db/migration.test.ts` | ENOENT para `001_initial.sql` | Pendente |
| RBAC nega permissão ausente e aceita wildcard administrativo | `apps/api/src/shared/auth/authorization.test.ts` | Módulo `authorization.js` ausente | Pendente |
| Sessão e CSRF usam segredos opacos armazenados por hash | `apps/api/src/shared/auth/session.test.ts` | Módulo `session.js` ausente | Pendente |

PGlite é usado somente para validação rápida de sintaxe/invariantes PostgreSQL enquanto o daemon Docker local está indisponível. Ele não satisfaz nem será reportado como teste de integração com servidor PostgreSQL real.

Comando RED: `pnpm --filter @erp/api test`. Resultado: 3 arquivos/4 alvos falharam exclusivamente pelas implementações ainda ausentes; os 3 testes anteriores da API permaneceram verdes.
