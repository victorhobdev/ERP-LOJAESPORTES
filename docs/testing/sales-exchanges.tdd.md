# Evidência TDD — trocas de venda

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Troca cria evento sem reescrever item vendido | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Item devolvido entra e item entregue sai em movimentos separados | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Reenvio idempotente não duplica evento/movimentos | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Quantidade devolvida não excede a vendida | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Falta do item entregue reverte toda a troca | `sales.integration.test.ts` | Duas respostas HTTP 404 | Pendente |
| Detalhe agregado expõe histórico de trocas | `sales.integration.test.ts` | Fluxo bloqueado pelo HTTP 404 | Pendente |

O contrato sintético troca quantidades iguais. Tratamento financeiro de diferença de valor depende de decisão operacional e não é inferido.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 20 testes anteriores PASS e 2 novos testes falham porque `/sales/:id/exchanges` não existe.
