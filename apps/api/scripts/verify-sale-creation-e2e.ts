import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_SALE_CREATION_IDS_FILE'] ?? 'e2e-artifacts/sale-creation-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  pendingSaleId?: string
  partialSaleId?: string
}
if (!ids.pendingSaleId || !ids.partialSaleId) throw new Error('pendingSaleId and partialSaleId are required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    pending_status: string
    pending_due: string
    pending_payments: string
    partial_status: string
    partial_due: string
    partial_payments: string
    sale_audits: string
  }>(
    `SELECT
       (SELECT status FROM sales WHERE id = $1) AS pending_status,
       (SELECT (final_amount - coalesce((SELECT sum(amount) FROM payments WHERE sale_id = $1 AND status = 'confirmed'), 0))::text FROM sales WHERE id = $1) AS pending_due,
       (SELECT count(*) FROM payments WHERE sale_id = $1) AS pending_payments,
       (SELECT status FROM sales WHERE id = $2) AS partial_status,
       (SELECT (final_amount - coalesce((SELECT sum(amount) FROM payments WHERE sale_id = $2 AND status = 'confirmed'), 0))::text FROM sales WHERE id = $2) AS partial_due,
       (SELECT count(*) FROM payments WHERE sale_id = $2 AND status = 'confirmed') AS partial_payments,
       (SELECT count(*) FROM audit_log WHERE action = 'sale.create' AND entity_id IN ($1::text, $2::text)) AS sale_audits`,
    [ids.pendingSaleId, ids.partialSaleId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Vendas sinteticas nao encontradas.')
  const evidence = {
    pendingSaleId: ids.pendingSaleId,
    partialSaleId: ids.partialSaleId,
    pendingStatus: row.pending_status,
    pendingDue: row.pending_due,
    pendingPayments: row.pending_payments,
    partialStatus: row.partial_status,
    partialDue: row.partial_due,
    partialPayments: row.partial_payments,
    saleAudits: row.sale_audits,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.pending_status !== 'pending') failures.push(`pendente esperava pending, obteve ${row.pending_status}`)
  if (row.pending_due !== '150.00') failures.push(`saldo pendente esperado 150.00, obteve ${row.pending_due}`)
  if (row.pending_payments !== '0') failures.push(`pagamentos da pendente esperavam 0, obteve ${row.pending_payments}`)
  if (row.partial_status !== 'partially_paid') failures.push(`parcial esperava partially_paid, obteve ${row.partial_status}`)
  if (row.partial_due !== '90.00') failures.push(`saldo parcial esperado 90.00, obteve ${row.partial_due}`)
  if (row.partial_payments !== '1') failures.push(`pagamentos da parcial esperavam 1, obteve ${row.partial_payments}`)
  if (row.sale_audits !== '2') failures.push(`auditorias de criacao esperavam 2, obteve ${row.sale_audits}`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
