# Evidência TDD — migração legada de produtos e estoque

## Garantias

| Garantia | Teste | RED | GREEN |
| --- | --- | --- | --- |
| Produto lógico agrupa variantes legadas válidas | `legacy-products.integration.test.ts` | Módulo ausente | 2 variantes criadas sob 1 produto |
| Saldo inicial é explicado por `opening_balance` | `legacy-products.integration.test.ts` | Módulo ausente | Saldo 3 = soma de movimentos 3 |
| IDs legados permanecem rastreáveis | `legacy-products.integration.test.ts` | Módulo ausente | `legacy_id` 10 e 11 preservados |
| Linha inválida ou variante duplicada gera rejeição com causa | `legacy-products.integration.test.ts` | Módulo ausente | 2 rejeições classificadas, sem interromper válidos |
| Snapshot idêntico não duplica execução nem entidades | `legacy-products.integration.test.ts` | Módulo ausente | Ordem invertida reutiliza 1 run, 2 variantes e 1 movimento |
| Conflito com destino não sobrescreve cadastro existente | `legacy-products.integration.test.ts` | Módulo ausente | `LEGACY_ID_ALREADY_MIGRATED` e `TARGET_VARIANT_CONFLICT`; saldo original preservado |

Os testes usam somente fixtures sintéticas em schema PostgreSQL descartável. A fonte MySQL/backup real não é lida nem alterada.

Comando RED: `pnpm --filter @erp/api test:integration` com `TEST_DATABASE_URL`; 11 testes anteriores PASS e a nova suíte falha exclusivamente por `Cannot find module './legacy-products.js'`.

Comandos GREEN:

- `pnpm --filter @erp/api test:integration`: 4 arquivos, 14 testes PASS em PostgreSQL 16 real.
- `pnpm check`: lint, TypeScript estrito, 23 testes unitários e builds PASS.
- `pnpm --filter @erp/api test:coverage:all`: 9 arquivos, 27 testes PASS; 89,48% statements, 81,93% branches, 100% functions e 92,92% lines.
