# Evidência TDD — vendas

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Criar venda exige autenticação | `sales.integration.test.ts` | HTTP 404 | Pendente |
| API recalcula preço, custo, desconto e total | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Venda paga grava item, pagamento, baixa e auditoria | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Reenvio idempotente não duplica venda | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Venda pendente exige cliente e vencimento | `sales.integration.test.ts` | HTTP 404 | Pendente |
| Concorrência do último item não produz saldo negativo nem escrita parcial | `sales.integration.test.ts` | Duas respostas HTTP 404 | Pendente |

Todos os usuários, clientes, produtos, preços e saldos são fixtures sintéticas em schema PostgreSQL descartável.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 14 testes anteriores PASS e 4 testes de vendas falham exclusivamente pelas rotas ausentes.
