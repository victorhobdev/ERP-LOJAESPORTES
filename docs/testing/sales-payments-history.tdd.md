# Evidência TDD — pagamentos posteriores e histórico

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Pagamento posterior é append-only e idempotente | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Estados avançam de pendente para parcial e pago | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Pagamentos não alteram novamente o estoque | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Duas cobranças concorrentes não excedem o saldo devido | `sales.integration.test.ts` | Duas respostas HTTP 404 | Pendente |
| Detalhe e lista refletem pagamentos/estado atuais | `sales.integration.test.ts` | Fluxo bloqueado pelo HTTP 404 | Pendente |

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 18 testes anteriores PASS e 2 novos testes falham em `/sales/:id/payments` ausente.
