# Evidência TDD — migração legada de produtos e estoque

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Produto lógico agrupa variantes legadas válidas | `legacy-products.integration.test.ts` | Módulo ausente | Pendente |
| Saldo inicial é explicado por `opening_balance` | `legacy-products.integration.test.ts` | Módulo ausente | Pendente |
| IDs legados permanecem rastreáveis | `legacy-products.integration.test.ts` | Módulo ausente | Pendente |
| Linha inválida ou variante duplicada gera rejeição com causa | `legacy-products.integration.test.ts` | Módulo ausente | Pendente |
| Snapshot idêntico não duplica execução nem entidades | `legacy-products.integration.test.ts` | Módulo ausente | Pendente |

Os testes usam somente fixtures sintéticas em schema PostgreSQL descartável. A fonte MySQL/backup real não é lida nem alterada.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 11 testes anteriores PASS e a nova suíte falha exclusivamente por `Cannot find module './legacy-products.js'`.
