# Evidência TDD — pedidos e recebimentos de compra

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criar pedido exige autenticação | `purchases.integration.test.ts` | HTTP 404 | HTTP 401 `UNAUTHENTICATED` |
| API calcula estimativa, taxa, total e custo unitário final | `purchases.integration.test.ts` | HTTP 404 | 4 × 50,00 + 20,00 = 220,00; custo final 55,00 |
| Recebimentos parciais conciliam pedido/recebido/pendente | `purchases.integration.test.ts` | HTTP 404 | 4/2/2 e depois 4/4/0; estados parcial/integral |
| Recebimento idempotente não duplica estoque | `purchases.integration.test.ts` | HTTP 404 | Replay idêntico; conteúdo diferente retorna 409 |
| Recebimento atualiza custo médio e gera movimento/auditoria | `purchases.integration.test.ts` | HTTP 404 | Estoque 4, custo 55,00, 2 movimentos e 2 auditorias |
| Concorrência não recebe além do pedido | `purchases.integration.test.ts` | HTTP 404 | Respostas 201/409; quantidade/estoque/recebimentos permanecem 1 |

Todos os dados são fixtures sintéticas em schema PostgreSQL descartável. O status `cancelled` não é exercitado enquanto a divergência legada não for aprovada.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 22 testes anteriores PASS e 3 testes novos falham exclusivamente por rotas ausentes.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 6 arquivos, 26 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 11 arquivos, 39 testes PASS; 88,34% statements, 80,57% branches, 100% functions e 91,77% lines.

Fornecedor/variante inexistentes, taxa sem base de rateio, excesso ainda parcial e pedido já integral são rejeitados antes de qualquer escrita operacional.
