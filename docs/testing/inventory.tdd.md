# Evidência TDD — produtos e estoque

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Produtos exigem autenticação | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 401 com `UNAUTHENTICATED` |
| Produto lógico cria variantes com saldo zero | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 201; detalhe e lista agregam 2 variantes com saldo zero |
| Chave de negócio duplicada retorna conflito | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 409 com `PRODUCT_ALREADY_EXISTS` |
| Ajuste exige sessão/CSRF/motivo e gera auditoria | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 201; movimento e auditoria persistidos na mesma transação |
| Repetição idempotente não duplica movimento | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | Mesma resposta HTTP 201; contagem permanece em 1 |
| Mesma chave com payload diferente é rejeitada | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 409 com `IDEMPOTENCY_KEY_REUSED` |
| Saída maior que saldo não altera estoque | `inventory.integration.test.ts` | Rota ausente, HTTP 404 | HTTP 409; saldo e contagens permanecem inalterados |
| Duas saídas concorrentes não deixam saldo negativo | `inventory.integration.test.ts` | Duas respostas HTTP 404 | Respostas 201/409; saldo final 1 e filtro de baixo estoque confirmado |

Todos os dados são fixtures sintéticas dentro de schema PostgreSQL descartável.

Comando RED: suíte de integração com `TEST_DATABASE_URL`; 4 testes do novo módulo falharam exclusivamente por rotas ausentes, enquanto os 7 testes anteriores de banco/autenticação permaneceram verdes.

Durante a revisão, a listagem autenticada foi adicionada ao mesmo teste e revelou um segundo RED: HTTP 500 por `ORDER BY` antes de `GROUP BY`. A consulta foi corrigida e o cenário passou.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 3 arquivos, 11 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 8 arquivos, 24 testes PASS; 89,24% statements, 82,2% branches, 100% functions e 93,1% lines.
