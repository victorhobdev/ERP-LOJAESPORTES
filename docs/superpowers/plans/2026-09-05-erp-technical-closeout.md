# ERP 2.0 Technical Closeout Implementation Plan

## Execução — 2026-09-05

Tarefas 1–6 executadas; evidências em PROGRESSO.md, seção Fechamento técnico. Checkboxes originais abaixo preservam o roteiro proposto; o registro desta seção é o estado executado.

- [x] Baseline confirmado com as reproduções prévias, sem repetir testes vermelhos por orientação do usuário.
- [x] Venda paga filtrada por SKU; bloqueio após reload verificado nos controles visíveis; 9/9 fullstack com verifies.
- [x] Reconciliação por origem, centavos inteiros, cálculo independente dos totais esperados e teste de corrupção detectada.
- [x] Documentação Windows e launcher local com login verificado.
- [x] Instalação, check, integração 125/125, E2E mock, PWA, auditoria, scripts backup e restauração real em banco NOVO (sem drop/overwrite).
- [x] Evidências registradas; corte, Drive e quatro pendentes não aprovados automaticamente.

Correções ao roteiro: explicações financeiras somente quando esperado=migrado; diferenças residuais são UNEXPLAINED. Não seguir o exemplo abaixo que atribui automaticamente qualquer divergência a rejeições. Não sobrescrever dump nem apagar banco de ensaio existente. Validar contagens restauradas além das migrations. Backup mensal permanece política a instalar no ambiente definitivo.

> **For agentic workers:** REQUIRED SUB-SKILL: use `execute-block-plan` to execute this plan continuously and `verification-before-completion` before reporting success. Track every step with the checkboxes below. Do not stop between tasks while safe local work remains.

**Goal:** Close every currently known technical defect, obtain a reproducible 9/9 full-stack gate, make the real MySQL-to-PostgreSQL reconciliation internally correct, and leave only genuinely external cutover actions.

**Architecture:** Preserve the current React/Fastify/PostgreSQL design and make surgical changes in the E2E fixture scope, migration reconciliation, and operational documentation. No schema or product behavior should change in this wave. The real dump remains read-only; all writes go only to PostgreSQL databases whose names end in `_test`.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Vitest, Playwright, pnpm, PowerShell and Git Bash on Windows.

**Spec:** `C:/Users/Vitinho/.codex/attachments/fbde6e32-e913-4b41-bc00-2c045d244431/goal-objective.md`, `docs/reconstrucao-erp/00-plano-mestre.md`, `docs/reconstrucao-erp/05-dados-migracao.md`, `docs/reconstrucao-erp/10-seguranca-operacao.md`, and `docs/reconstrucao-erp/11-roadmap-validacao.md`.

## Global Constraints

- Preserve the dirty working tree and all user changes. Do not reset, clean, stage, commit, push, deploy, or remove the legacy ERP.
- Do not access or modify MySQL production. The authorized source is the existing dump `backups/gemini_teste-mysql-20260904-090700.sql`.
- Do not read or use real credentials. Google Drive remains a controlled external gate until credentials are supplied by the owner.
- Use only `erp2_test`, `erp2_homolog_test`, or another database name ending in `_test` for writes.
- Do not change business behavior to make a test pass. Keep stock, money, authorization, idempotency, audit, and due-date assertions intact.
- Do not invent due dates for legacy sales 8, 10, 50, and 61. They remain typed rejections until the owner supplies dates or explicitly accepts exclusion.
- Preserve the historical entries in `PROGRESSO.md`; append new observed evidence instead of rewriting earlier runs.
- A skipped full-stack test is not a passed gate. Final acceptance requires all nine real-API suites to pass with zero skipped tests.

## Verified Starting State

- `pnpm check`: exit 0; contracts 8/8, API unit 35 passed with 2 pre-existing skips, web 151/151, API/web builds successful.
- API integration: 18/18 files and 125/125 tests passed against `erp2_test`.
- Standard Playwright run: 7 passed and 9 full-stack gates skipped.
- Official full-stack runner: 8/9; `paid-sale` fails because an unfiltered `GET /api/inventory` returns only the first 50 rows and omits its freshly seeded variant.
- Real migration replay: all four modules return `reused: true`; products 176/176 variants with zero product rejections, sales 65/69 with four typed rejections, purchases 6/6 with 95 items and five receipts.
- Reconciliation defect: `products.rejected` reports 4 because it counts every row in `migration_rejections`, including sale rejections.
- Reconciliation completeness defect: the JSON values expose sales/payment/receivable differences, but `knownDivergences` does not name those aggregate differences or their semantic causes.

## File Map

- Modify `tests/e2e/paid-sale-fullstack.spec.ts`: scope inventory verification to the unique seeded SKU.
- Modify `apps/api/src/modules/migration/reconcile.ts`: count product rejections by source table and add deterministic aggregate divergence explanations.
- Modify `apps/api/src/modules/migration/gemini-dump.integration.test.ts`: prove source-specific rejection counts and all expected aggregate explanations.
- Modify `docs/OPERACAO.md`: document the supported Windows full-stack command and the four unresolved legacy receivables without stale decisions.
- Modify `docs/reconstrucao-erp/PROGRESSO.md`: append fresh observed evidence and keep block status truthful.
- Do not create a new abstraction or dependency for any of these changes.

---

### Task 1: Preserve and reproduce the two red gates

**Files:**
- Inspect: `tests/e2e/paid-sale-fullstack.spec.ts`
- Inspect: `apps/api/src/modules/inventory/routes.ts`
- Inspect: `apps/api/src/modules/migration/reconcile.ts`
- Inspect: `apps/api/src/modules/migration/gemini-dump.integration.test.ts`

**Interfaces:**
- Consumes: `GET /api/inventory?search=<term>&limit=<n>` and `buildReconciliationReport(pool, dump)`.
- Produces: saved baseline evidence for the fixes in Tasks 2 and 3.

- [ ] **Step 1: Confirm the worktree and exact target files**

Run:

```powershell
git status --short
rg -n "page.request.get\('/api/inventory'|SELECT count\(\*\)::text AS total FROM migration_rejections|knownDivergences" tests/e2e/paid-sale-fullstack.spec.ts apps/api/src/modules/migration/reconcile.ts
```

Expected: both inventory reads are unfiltered; the rejection query has no `source_table` condition.

- [ ] **Step 2: Preserve the full-stack failure as the red proof**

Run from repository root:

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" -lc "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh"
```

Expected baseline: `paid-sale` fails at the stock assertion with `Expected: 4` and `Received: undefined`; other suites continue. If the suite unexpectedly passes because the variant happens to land in the first page, the unfiltered request is still defective and Task 2 remains required.

- [ ] **Step 3: Preserve the reconciliation defect as the red proof**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_homolog_test'
pnpm --dir apps/api exec tsx scripts/migrate-gemini-dump.ts ../../backups/gemini_teste-mysql-20260904-090700.sql
```

Expected baseline: product migration reports `rejectedRows: 0`, while `reconciliation.products.rejected` incorrectly reports `4`; the aggregate sales/payment/receivable differences appear as values but not as coded entries in `knownDivergences`.

---

### Task 2: Make the paid-sale full-stack test independent of accumulated fixtures

**Files:**
- Modify: `tests/e2e/paid-sale-fullstack.spec.ts`
- Verify only: `apps/api/scripts/seed-paid-sale-e2e.ts`
- Verify only: `scripts/run-fullstack-e2e.sh`

**Interfaces:**
- Consumes: seed field `sku`, exported automatically by the runner as `E2E_SKU`.
- Produces: a stock reader that asserts exactly one seeded variant and returns its `stockQuantity`.

- [ ] **Step 1: Add the unique SKU contract**

Add beside the existing `club`, `model`, and `variantId` environment reads:

```ts
const sku = process.env['E2E_SKU'] ?? ''
```

At the start of the test, add:

```ts
expect(sku, 'E2E_SKU sintético').not.toBe('')
```

- [ ] **Step 2: Add a scoped stock helper inside the Playwright test**

After `addButton`, add:

```ts
const seededStock = async () => {
  const response = await page.request.get(`/api/inventory?search=${encodeURIComponent(sku)}&limit=10`)
  expect(response.status()).toBe(200)
  const inventory = (await response.json()) as {
    items: Array<{ variantId: string; stockQuantity: number }>
  }
  const seededItems = inventory.items.filter((item) => item.variantId === variantId)
  expect(seededItems).toHaveLength(1)
  return seededItems[0]!.stockQuantity
}
```

- [ ] **Step 3: Replace both unfiltered inventory assertions**

Replace the first inventory request block with:

```ts
expect(await seededStock()).toBe(4)
```

Replace the second inventory request block with:

```ts
expect(await seededStock()).toBe(3)
```

Do not increase the API default limit, remove the exact stock assertions, or query the database from the browser test.

- [ ] **Step 4: Run the paid-sale flow through the official runner**

Run:

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" -lc "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh"
```

Expected: `paid-sale` passes and its verify script confirms stock 3, two distinct sales, one payment per sale, and no duplicated retry effect. The whole command must end `FULLSTACK RESULT: 9 passed / 0 failed of 9`.

---

### Task 3: Make reconciliation source-correct and self-explanatory

**Files:**
- Modify: `apps/api/src/modules/migration/reconcile.ts`
- Test: `apps/api/src/modules/migration/gemini-dump.integration.test.ts`

**Interfaces:**
- Consumes: `migration_rejections.source_table`, legacy normalized totals, and migrated PostgreSQL totals.
- Produces: `ReconciliationReport.products.rejected` scoped to `produtos` and stable explanation codes in `knownDivergences`.

- [ ] **Step 1: Strengthen the failing integration expectations first**

In the existing reconciliation test, change the product assertion to include the correct source-specific count:

```ts
expect(report.products).toEqual({
  legacyRows: 3,
  migratedProducts: 2,
  migratedVariants: 3,
  rejected: 0,
})
```

Add these expectations:

```ts
expect(report.knownDivergences.some((line) => line.startsWith('SALES_REJECTED_TOTAL:'))).toBe(true)
expect(report.knownDivergences.some((line) => line.startsWith('PAID_STATUS_AUTHORITATIVE:'))).toBe(true)
expect(report.knownDivergences.some((line) => line.startsWith('RECEIVABLES_REJECTED_TOTAL:'))).toBe(true)
```

The fixture already has rejection rows for sales, purchases, and customer orders while product rejections remain zero, so it proves that product counts are isolated.

- [ ] **Step 2: Run the focused test and confirm red**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_test'
pnpm --filter @erp/api exec vitest run --maxWorkers=1 src/modules/migration/gemini-dump.integration.test.ts
```

Expected: failure because `products.rejected` is 3 in the mini fixture and the three aggregate codes do not exist yet.

- [ ] **Step 3: Scope product rejection count to the product source**

Replace the global rejection query with:

```ts
const productRejectedRow = await pool.query<{ total: string }>(
  `SELECT count(*)::text AS total
   FROM migration_rejections
   WHERE source_table = 'produtos'`,
)
```

Use it in the returned product object:

```ts
rejected: Number(productRejectedRow.rows[0]?.total ?? '0'),
```

- [ ] **Step 4: Capture migrated totals once and append deterministic coded explanations**

Before building `knownDivergences`, normalize the values already queried:

```ts
const legacySalesMoney = money(legacySalesTotal)
const migratedSalesMoney = money(Number(salesRow.rows[0]?.total ?? '0'))
const legacyPaidMoney = money(legacyPaidTotal)
const migratedPaidMoney = money(Number(paymentsRow.rows[0]?.total ?? '0'))
const legacyPendingMoney = money(legacyPendingTotal)
const migratedOutstandingMoney = money(Number(receivablesRow.rows[0]?.total ?? '0'))
```

After rejection reason entries and before image information, append only when values differ:

```ts
if (legacySalesMoney !== migratedSalesMoney) {
  knownDivergences.push(
    `SALES_REJECTED_TOTAL: legado=${legacySalesMoney}; migrado=${migratedSalesMoney}; diferença explicada por vendas tipadamente rejeitadas`,
  )
}
if (legacyPaidMoney !== migratedPaidMoney) {
  knownDivergences.push(
    `PAID_STATUS_AUTHORITATIVE: ValorPago legado=${legacyPaidMoney}; pagamentos migrados=${migratedPaidMoney}; vendas Pago usam ValorFinalVenda`,
  )
}
if (legacyPendingMoney !== migratedOutstandingMoney) {
  knownDivergences.push(
    `RECEIVABLES_REJECTED_TOTAL: legado=${legacyPendingMoney}; migrado=${migratedOutstandingMoney}; diferença explicada por vendas pendentes tipadamente rejeitadas`,
  )
}
```

Reuse the normalized values in `sales`, `payments`, and `receivables` instead of formatting the same totals again. Keep the existing rejection reason and SKU divergence entries.

- [ ] **Step 5: Run focused integration and confirm green**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_test'
pnpm --filter @erp/api exec vitest run --maxWorkers=1 src/modules/migration/gemini-dump.integration.test.ts
```

Expected: 4/4 tests pass; products report zero rejections despite non-product rejection rows; all three aggregate explanation codes are present.

- [ ] **Step 6: Verify the real dump report**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_homolog_test'
pnpm --dir apps/api exec tsx scripts/migrate-gemini-dump.ts ../../backups/gemini_teste-mysql-20260904-090700.sql
```

Expected:

- every migration module has `reused: true`;
- `products.rejected` is 0;
- sales remain 65/69 with exactly four `PENDING_SALE_MISSING_DUE_DATE` rejections;
- stock remains 176/176 matched with no divergent balance;
- `knownDivergences` contains the three stable aggregate explanation codes and the six-SKU explanation.

---

### Task 4: Make the final local verification command reproducible on Windows

**Files:**
- Modify: `docs/OPERACAO.md`
- Verify only: `scripts/run-fullstack-e2e.sh`

**Interfaces:**
- Consumes: Git Bash bundled with Git for Windows and `TEST_DATABASE_URL` restricted to `_test`.
- Produces: an exact PowerShell command that invokes the official nine-suite runner with Node visible in the Git Bash environment.

- [ ] **Step 1: Extend the verification section with the supported Windows command**

Add this command after the standard E2E command:

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" -lc "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh"
```

Document that this is the full-stack gate against real API/PostgreSQL, uses a new synthetic seed per suite, requires ports 3333 and 4173, and accepts only `9 passed / 0 failed of 9`. State that plain WSL `bash.exe` is not the supported invocation when Node is absent from its `PATH`.

- [ ] **Step 2: Remove stale operational decisions from the pending list**

Keep only facts that are still external:

- Google Drive credentials and live Drive homologation;
- owner-provided due dates or explicit exclusion approval for legacy sales 8, 10, 50, and 61;
- user training, a defined real parallel-operation window, daily reconciliation during it, and final cut approval.

Do not list the database choice, single-user count, devices, financial recognition, purchase cancellation, or monthly local backup policy as undecided; those were already decided by the owner.

In the backup and alerts sections, align the runbook with the confirmed policy: generate one backup set per month in an absolute directory on the same PC but outside the PostgreSQL data directory, never overwrite a previous dump, and alert when the newest successful backup is older than 31 days. Do not require an off-machine copy and do not add automatic deletion because no retention limit was approved.

---

### Task 5: Execute the complete local closeout gate

**Files:**
- Test all changed and existing code.
- Modify documentation only after observing command results.

**Interfaces:**
- Consumes: the changes from Tasks 2–4.
- Produces: fresh evidence sufficient to declare the technical workspace green or an exact remaining technical blocker.

- [ ] **Step 1: Verify lockfile installation**

Run:

```powershell
pnpm install --frozen-lockfile
```

Expected: exit 0 with no lockfile modification.

- [ ] **Step 2: Run lint, types, unit/component tests, PWA checks, and builds**

Run:

```powershell
pnpm check
```

Expected: exit 0. Record exact file/test counts from the output rather than copying previous counts.

- [ ] **Step 3: Run the complete API integration suite**

Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/erp2_test'
pnpm --filter @erp/api test:integration
```

Expected: 18/18 files and the current full test count pass with zero failures.

- [ ] **Step 4: Run standard browser tests**

Run:

```powershell
pnpm test:e2e
```

Expected: the synthetic/mock suite passes. Report the nine skipped full-stack files as skipped here, not as passes; Task 5 Step 5 is their real gate.

- [ ] **Step 5: Run all real-API browser flows**

Run:

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" -lc "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh"
```

Expected: catalog, inventory, purchases, paid-sale, financial-report, customer-orders, sale-creation, multi-payments, and sales all pass; every configured database verifier passes; final line is `FULLSTACK RESULT: 9 passed / 0 failed of 9`.

- [ ] **Step 6: Re-run backup/restore script regression suites**

Run:

```powershell
node --test scripts/backup-restore-lib.test.mjs scripts/backup-restore-scripts.test.mjs
```

Expected: exit 0. Do not claim a real restore drill unless `pg_dump`, `pg_restore`, and `psql` are actually available to the host scripts and a `_restore_test` database was restored and checked.

- [ ] **Step 7: Demonstrate an actual homologation backup and restore with the available WSL PostgreSQL tools**

Use an explicit workspace artifact directory and an exact restore database name guarded by the required suffix:

```powershell
$erpBackupDir = Join-Path $PWD 'e2e-artifacts\backup-drill'
New-Item -ItemType Directory -Force -Path $erpBackupDir | Out-Null
$erpWslBackupDir = (wsl.exe wslpath -a "$erpBackupDir").Trim()
$erpRestoreDb = 'erp2_restore_test'
if (-not $erpRestoreDb.EndsWith('_restore_test')) { throw 'Restore target must end in _restore_test.' }
wsl.exe -e pg_dump -h 127.0.0.1 -p 55432 -U postgres -Fc -f "$erpWslBackupDir/erp2_homolog_test.dump" erp2_homolog_test
Get-FileHash -Algorithm SHA256 (Join-Path $erpBackupDir 'erp2_homolog_test.dump')
wsl.exe -e dropdb --if-exists -h 127.0.0.1 -p 55432 -U postgres $erpRestoreDb
wsl.exe -e createdb -h 127.0.0.1 -p 55432 -U postgres $erpRestoreDb
wsl.exe -e pg_restore --clean --if-exists --no-owner --exit-on-error -h 127.0.0.1 -p 55432 -U postgres -d $erpRestoreDb "$erpWslBackupDir/erp2_homolog_test.dump"
wsl.exe -e psql -h 127.0.0.1 -p 55432 -U postgres -d $erpRestoreDb -Atc "SELECT count(*) FROM schema_migrations;"
```

Expected: every command exits 0, the dump is non-empty with a SHA-256 value, and the final query returns `3`, matching `001_initial.sql`, `002_manager_purchase_read.sql`, and `003_manager_customers_read.sql`. The `dropdb` target is permitted only after the exact `_restore_test` suffix guard above; never substitute another database name.

- [ ] **Step 8: Run a production dependency and secret hygiene check**

Run:

```powershell
pnpm audit --prod --audit-level high
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!backups/**' --glob '!docs/superpowers/plans/**' "(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z]{20,}|CATALOG_SYNC_DRIVE_ACCESS_TOKEN=.+|DATABASE_URL=.+:.+@)" .
```

Expected: no high/critical production advisory and no committed hard-coded secret. If the network prevents the audit, record that exact environmental failure; do not call the security gate green.

- [ ] **Step 9: Check the final diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exit 0. CRLF conversion warnings are informational. The status may remain dirty because this is the user's working tree; verify that only planned files changed during this wave.

---

### Task 6: Update progress truthfully and hand off the external cut actions

**Files:**
- Modify: `docs/reconstrucao-erp/PROGRESSO.md`
- Verify: `docs/reconstrucao-erp/11-roadmap-validacao.md`

**Interfaces:**
- Consumes: observed outputs from Task 5 and real replay output from Task 3.
- Produces: a final technical closeout entry and a minimal external-action list.

- [ ] **Step 1: Append one dated closeout entry**

Record:

- files and causes corrected;
- exact `pnpm check`, integration, mock E2E, full-stack, migration replay, backup-script tests, real WSL backup/restore drill, audit, and `git diff --check` results;
- products 176/176 with `products.rejected: 0`;
- sales 65/69 and the four rejected legacy IDs;
- purchases 6/6 and stock 176/176;
- confirmation that the report itself contains the aggregate explanations;
- confirmation that no production system, real credential, commit, stage, push, or deployment was used.

- [ ] **Step 2: Keep block statuses evidence-based**

Mark a block `COMPLETO` only when its roadmap gate is actually proven. Otherwise keep `PARCIAL` and replace broad language with the exact external action still required. Passing all local tests permits the phrase “trabalho técnico local concluído”; it does not prove training, real parallel operation, Drive authentication, or owner approval.

- [ ] **Step 3: End with one compact owner checklist**

The final report must request only these actions:

1. Assign due dates to legacy sales 8, 10, 50, and 61, or explicitly approve their exclusion.
2. Supply Google Drive credentials only through the documented environment variables when live Drive sync is desired.
3. Perform the sole-user walkthrough, choose the real parallel-operation dates, reconcile daily during that window, and approve the final cut.

Do not ask the owner to decide items already recorded as confirmed.

## Final Acceptance

The executor may report this plan technically complete only when all of the following are simultaneously true:

- the paid-sale flow is scoped to its own fixture and the official runner ends 9/9;
- product reconciliation reports zero product rejections while preserving the four sale rejections;
- every money/row mismatch is represented in `knownDivergences` with a stable cause code;
- real migration replay remains deterministic and idempotent;
- `pnpm check`, all API integration tests, browser gates, backup-script tests, a real `_restore_test` restore drill, security checks, and `git diff --check` have fresh observed evidence;
- `PROGRESSO.md` contains the latest evidence and no stale decision list;
- all remaining items require actual owner data, credentials, elapsed parallel-operation time, or human approval.

If any technical command fails, fix the cause and repeat the affected command plus the complete final gate. Do not stop at the first green focused test and do not declare the goal complete merely because only external blockers remain.
