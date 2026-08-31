# Evidência TDD — pedidos e recebimentos de compra

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criar pedido exige autenticação | `purchases.integration.test.ts` | HTTP 404 | Pendente |
| API calcula estimativa, taxa, total e custo unitário final | `purchases.integration.test.ts` | HTTP 404 | Pendente |
| Recebimentos parciais conciliam pedido/recebido/pendente | `purchases.integration.test.ts` | HTTP 404 | Pendente |
| Recebimento idempotente não duplica estoque | `purchases.integration.test.ts` | HTTP 404 | Pendente |
| Recebimento atualiza custo médio e gera movimento/auditoria | `purchases.integration.test.ts` | HTTP 404 | Pendente |
| Concorrência não recebe além do pedido | `purchases.integration.test.ts` | HTTP 404 | Pendente |

Todos os dados são fixtures sintéticas em schema PostgreSQL descartável. O status `cancelled` não é exercitado enquanto a divergência legada não for aprovada.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 22 testes anteriores PASS e 3 testes novos falham exclusivamente por rotas ausentes.
