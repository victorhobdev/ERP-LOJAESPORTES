# Evidência TDD — encomendas de cliente

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criação exige autenticação e é idempotente | `customer-orders.integration.test.ts` | HTTP 404 | HTTP 401; replay idêntico e chave alterada 409 |
| Encomenda aceita descrição livre sem variante/compra | `customer-orders.integration.test.ts` | HTTP 404 | Criada `pending` com vínculos nulos |
| Transições seguem ordem e geram timeline imutável | `customer-orders.integration.test.ts` | HTTP 404 | 4 eventos: pendente, pedido, chegada e entrega |
| Transição inválida é rejeitada | `customer-orders.integration.test.ts` | HTTP 404 | Salto para entrega retorna 409 |
| Cancelamento exige e preserva motivo | `customer-orders.integration.test.ts` | HTTP 404 | Sem motivo retorna 400; motivo aparece na timeline |
| Encomenda não cria compra nem movimento automaticamente | `customer-orders.integration.test.ts` | HTTP 404 | Contagens de compra e movimento permanecem zero |

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 26 testes anteriores PASS e 3 testes novos falham por rotas ausentes.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 7 arquivos, 29 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 12 arquivos, 42 testes PASS; 87,39% statements, 80,43% branches, 100% functions e 90,85% lines.
