# Evidência TDD — trocas de venda

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Troca cria evento sem reescrever item vendido | `sales.integration.test.ts` | HTTP 404 | 1 evento/2 itens; item da venda continua apontando para a variante original |
| Item devolvido entra e item entregue sai em movimentos separados | `sales.integration.test.ts` | HTTP 404 | Saldos 4 → 5 e 2 → 1; 2 movimentos vinculados |
| Reenvio idempotente não duplica evento/movimentos | `sales.integration.test.ts` | HTTP 404 | Replay idêntico; conteúdo diferente retorna 409 |
| Quantidade devolvida não excede a vendida | `sales.integration.test.ts` | HTTP 404 | Segunda devolução retorna `RETURN_QUANTITY_EXCEEDED` |
| Falta do item entregue reverte toda a troca | `sales.integration.test.ts` | Duas respostas HTTP 404 | Respostas 201/409; somente a troca completa altera ambos os saldos |
| Detalhe agregado expõe histórico de trocas | `sales.integration.test.ts` | Fluxo bloqueado pelo HTTP 404 | `exchanges` contém evento e itens retornado/entregue |

O contrato sintético troca quantidades iguais. Tratamento financeiro de diferença de valor depende de decisão operacional e não é inferido.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 20 testes anteriores PASS e 2 novos testes falham porque `/sales/:id/exchanges` não existe.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 5 arquivos, 22 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 10 arquivos, 35 testes PASS; 88,03% statements, 80,13% branches, 100% functions e 91,23% lines.
