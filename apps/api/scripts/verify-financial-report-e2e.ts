import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_FIN_IDS_FILE'] ?? 'e2e-artifacts/financial-report-ids.json'
const idsFile =
  [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ??
  configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  partialSaleId?: string
  pendingSaleId?: string
  from?: string
  to?: string
  prevFrom?: string
  prevTo?: string
  sales?: string
  payments?: string
  audits?: string
}
if (!ids.partialSaleId || !ids.pendingSaleId || !ids.from || !ids.to || !ids.prevFrom || !ids.prevTo) {
  throw new Error('partialSaleId, pendingSaleId, from, to, prevFrom and prevTo are required.')
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const sums = await pool.query<{ currentSales: string; currentReceipts: string; prevSales: string; prevReceipts: string }>(
    `SELECT
      (SELECT coalesce(sum(final_amount), 0)::numeric(14,2)::text FROM sales
        WHERE status <> 'reversed' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2) AS "currentSales",
      (SELECT coalesce(sum(amount), 0)::numeric(14,2)::text FROM payments
        WHERE status = 'confirmed' AND (received_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2) AS "currentReceipts",
      (SELECT coalesce(sum(final_amount), 0)::numeric(14,2)::text FROM sales
        WHERE status <> 'reversed' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $3 AND $4) AS "prevSales",
      (SELECT coalesce(sum(amount), 0)::numeric(14,2)::text FROM payments
        WHERE status = 'confirmed' AND (received_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $3 AND $4) AS "prevReceipts"`,
    [ids.from, ids.to, ids.prevFrom, ids.prevTo],
  )
  const receivables = await pool.query<{ saleId: string; amountDue: string }>(
    `SELECT s.id AS "saleId",
            (s.final_amount - coalesce((SELECT sum(amount) FROM payments WHERE sale_id = s.id AND status = 'confirmed'), 0))::numeric(14,2)::text AS "amountDue"
     FROM sales s
     WHERE s.id IN ($1, $2)
     ORDER BY s.payment_due_date, s.id`,
    [ids.partialSaleId, ids.pendingSaleId],
  )
  const counts = await pool.query<{ sales: string; payments: string; audits: string }>(
    `SELECT (SELECT count(*) FROM sales)::text AS sales,
            (SELECT count(*) FROM payments)::text AS payments,
            (SELECT count(*) FROM audit_log WHERE action NOT LIKE 'auth.%')::text AS audits`,
  )
  const row = sums.rows[0]!
  const evidence = {
    currentSales: row.currentSales,
    currentReceipts: row.currentReceipts,
    prevSales: row.prevSales,
    prevReceipts: row.prevReceipts,
    receivables: receivables.rows,
    sales: counts.rows[0]!.sales,
    payments: counts.rows[0]!.payments,
    audits: counts.rows[0]!.audits,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.currentSales !== '250.00') failures.push(`vendas atuais esperavam 250.00, obteve ${row.currentSales}`)
  if (row.currentReceipts !== '80.00') failures.push(`recebimentos atuais esperavam 80.00, obteve ${row.currentReceipts}`)
  if (row.prevSales !== '100.00') failures.push(`vendas anteriores esperavam 100.00, obteve ${row.prevSales}`)
  if (row.prevReceipts !== '100.00') failures.push(`recebimentos anteriores esperavam 100.00, obteve ${row.prevReceipts}`)
  if (receivables.rows.length !== 2) failures.push(`recebiveis esperavam 2, obteve ${receivables.rows.length}`)
  if (counts.rows[0]!.sales !== ids.sales) failures.push(`GET do relatorio escreveu vendas (${ids.sales} -> ${counts.rows[0]!.sales})`)
  if (counts.rows[0]!.payments !== ids.payments) failures.push(`GET do relatorio escreveu pagamentos (${ids.payments} -> ${counts.rows[0]!.payments})`)
  if (counts.rows[0]!.audits !== ids.audits) failures.push(`GET do relatorio escreveu auditoria (${ids.audits} -> ${counts.rows[0]!.audits})`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
