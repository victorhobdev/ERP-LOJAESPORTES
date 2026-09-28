# Evidência TDD — pagamentos posteriores e histórico

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Pagamento posterior é append-only e idempotente | `sales.integration.test.ts` | HTTP 404 | 2 pagamentos; replay mantém 2; payload diferente retorna 409 |
| Estados avançam de pendente para parcial e pago | `sales.integration.test.ts` | HTTP 404 | Saldos 150,00 → 100,00 → 0,00 e estados correspondentes |
| Pagamentos não alteram novamente o estoque | `sales.integration.test.ts` | HTTP 404 | Saldo permanece 1 após dois pagamentos |
| Duas cobranças concorrentes não excedem o saldo devido | `sales.integration.test.ts` | Duas respostas HTTP 404 | Respostas 201/409; total confirmado 100,00 em 1 registro |
| Detalhe e lista refletem pagamentos/estado atuais | `sales.integration.test.ts` | Fluxo bloqueado pelo HTTP 404 | Detalhe tem 2 pagamentos; filtro `paid` encontra venda; limite > 100 retorna 400 |

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 18 testes anteriores PASS e 2 novos testes falham em `/sales/:id/payments` ausente.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 5 arquivos, 20 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 10 arquivos, 33 testes PASS; 88,12% statements, 80,76% branches, 100% functions e 91,54% lines.
