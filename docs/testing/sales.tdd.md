# Evidência TDD — vendas

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criar venda exige autenticação | `sales.integration.test.ts` | HTTP 404 | HTTP 401 `UNAUTHENTICATED` |
| API recalcula preço, custo, desconto e total | `sales.integration.test.ts` | HTTP 404 | 2 × 150,00 − 10,00 = 290,00 calculado no servidor |
| Venda paga grava item, pagamento, baixa e auditoria | `sales.integration.test.ts` | HTTP 404 | 1 venda/item/pagamento/movimento/auditoria; saldo 3 → 1 |
| Reenvio idempotente não duplica venda | `sales.integration.test.ts` | HTTP 404 | Resposta idêntica; chave com payload diferente retorna 409 |
| Venda pendente exige cliente e vencimento | `sales.integration.test.ts` | HTTP 404 | Sem identificação retorna 400; identificada retorna `pending` e saldo 150,00 |
| Concorrência do último item não produz saldo negativo nem escrita parcial | `sales.integration.test.ts` | Duas respostas HTTP 404 | Respostas 201/409; 1 venda, 1 movimento e saldo zero |

Todos os usuários, clientes, produtos, preços e saldos são fixtures sintéticas em schema PostgreSQL descartável.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 14 testes anteriores PASS e 4 testes de vendas falham exclusivamente pelas rotas ausentes.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 5 arquivos, 18 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 10 arquivos, 31 testes PASS; 88,08% statements, 80,99% branches, 100% functions e 91,45% lines.

Chaves de idempotência são escopadas por usuário; preço/custo vêm do banco e todos os valores são calculados em centavos inteiros antes da persistência decimal.
