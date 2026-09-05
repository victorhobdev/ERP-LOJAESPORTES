# Migração de Conferência Gemini — Implementation Plan

> **For agentic workers:** Execute inline, task-by-task, preserving unrelated working-tree changes.

**Goal:** Implementar uma atualização única, idempotente e segura para a conferência pós-dump em `erp2_homolog_test`, deixando a aplicação final bloqueada até aprovação.

**Architecture:** Um módulo transacional dedicado concentra precondições, mapeamentos, ajustes de estoque, fechamento administrativo e criação dos dois pedidos. Um runner CLI usa dry-run por padrão e só aceita aplicação no banco exato de homologação.

**Tech Stack:** TypeScript, Node.js, `pg`, Vitest, PostgreSQL e as tabelas existentes de compras, estoque, auditoria e migração.

**Spec:** `docs/superpowers/specs/2026-09-05-gemini-conferencia-design.md`

## Global Constraints

- O dump continua somente leitura.
- `erp2_homolog_test` é o único banco autorizado pelo runner.
- Dry-run não escreve nada.
- Ajustes de estoque usam os saldos esperados como precondição.
- Fechamento legado não cria `goods_receipts` nem movimentos novos.
- Pedidos Kakaric começam sem recebimento; estoque só muda pelo fluxo normal.
- Reexecução não duplica dados nem reaplica estoque.

### Task 1: Especificar o comportamento com teste de integração

**Files:**
- Create: `apps/api/src/modules/migration/gemini-conference.integration.test.ts`

**Interfaces:**
- Testará `runGeminiConferenceMigration(pool, { mode, actorUserId })` e o tipo `GeminiConferenceReport`.

- [ ] **Step 1: Preparar fixture isolada**

Criar schema PostgreSQL dedicado como os testes de migração existentes, aplicar as migrations e inserir as cinco variantes, os pedidos legados 2/5, o fornecedor legado e um usuário de migração.

- [ ] **Step 2: Escrever o teste vermelho**

Cobrir dry-run sem alteração; precondições e mapeamento; aplicação com deltas `-1,-1,-1,+2,+1`; pendente legado `86 → 0` sem novos recibos/movimentos; pedidos de `8/R$50,00` e `20/R$1.094,00`; cinco produtos novos; e segunda execução sem aumento de contagens.

- [ ] **Step 3: Executar o teste e confirmar falha pela ausência do módulo**

Rodar `pnpm --dir apps/api exec vitest run --config vitest.unit.config.ts src/modules/migration/gemini-conference.integration.test.ts` com `TEST_DATABASE_URL` apontando para `erp2_test`.

### Task 2: Implementar a migração dedicada

**Files:**
- Create: `apps/api/src/modules/migration/gemini-conference.ts`

**Interfaces:**
- Produz `runGeminiConferenceMigration(pool, { mode: 'dry-run' | 'apply', actorUserId })`.
- Produz relatório serializável com `mode`, `reused`, `conflicts`, `stockAdjustments`, `legacyClosures`, `orders` e `createdProducts`.

- [ ] **Step 1: Implementar leitura e validação**

Usar as chaves de produto existentes, conversões de tamanho e custos fixos. Validar banco/estado atual, candidatos únicos e ausência de pendências legadas fora dos IDs 2 e 5.

- [ ] **Step 2: Implementar dry-run read-only**

Executar a validação em `BEGIN READ ONLY`, montar o relatório esperado e fazer `ROLLBACK`, sem inserir `migration_runs`.

- [ ] **Step 3: Implementar apply transacional e idempotente**

Criar/usar fornecedor `KAKARIC`, inserir produtos/variantes novas com IDs e SKUs determinísticos, criar os pedidos como `placed`, registrar auditoria, aplicar somente os ajustes de saldo com `manual_adjustment`, fechar os pedidos legados e gravar uma linha concluída em `migration_runs`.

- [ ] **Step 4: Reexecutar o teste de integração**

Confirmar o ciclo RED→GREEN e que o replay retorna `reused` sem novas linhas ou deltas.

### Task 3: Adicionar o runner seguro e relatório

**Files:**
- Create: `apps/api/scripts/migrate-gemini-conference.ts`
- Modify: `docs/OPERACAO.md`

- [ ] **Step 1: Implementar CLI dry-run por padrão**

Ler `HOMOLOG_DATABASE_URL` ou `TEST_DATABASE_URL`, exigir `current_database() = 'erp2_homolog_test'`, localizar o usuário `migracao.gemini` e gravar `e2e-artifacts/migration-gemini-conference-report.json`.

- [ ] **Step 2: Exigir `--apply` explícito**

Sem `--apply`, o runner nunca abre uma transação de escrita; com `--apply`, mantém o mesmo bloqueio de banco e imprime o relatório final.

- [ ] **Step 3: Documentar o comando de dry-run**

Adicionar somente o uso seguro na documentação operacional; não publicar endpoint nem botão de aplicação.

### Task 4: Verificação final

- [ ] **Step 1:** Rodar o teste específico de integração.
- [ ] **Step 2:** Rodar typecheck/lint dos pacotes tocados.
- [ ] **Step 3:** Executar o runner sem `--apply` em `erp2_homolog_test`.
- [ ] **Step 4:** Consultar novamente saldos, pedidos, recibos, movimentos, totais e produtos para comparar antes/depois e confirmar que o dry-run não escreveu.
- [ ] **Step 5:** Reportar blocos completos/parciais e manter `--apply` não executado até aprovação.
