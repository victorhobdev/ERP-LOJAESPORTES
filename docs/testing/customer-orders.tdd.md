# Evidência TDD — encomendas de cliente

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criação exige autenticação e é idempotente | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |
| Encomenda aceita descrição livre sem variante/compra | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |
| Transições seguem ordem e geram timeline imutável | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |
| Transição inválida é rejeitada | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |
| Cancelamento exige e preserva motivo | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |
| Encomenda não cria compra nem movimento automaticamente | `customer-orders.integration.test.ts` | HTTP 404 | Pendente |

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 26 testes anteriores PASS e 3 testes novos falham por rotas ausentes.
