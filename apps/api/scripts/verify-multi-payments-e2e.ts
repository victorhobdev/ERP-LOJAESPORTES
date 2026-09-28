import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_MULTI_PAYMENTS_IDS_FILE'] ?? 'e2e-artifacts/multi-payments-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as { saleId?: string }
if (!ids.saleId) throw new Error('saleId is required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    status: string
    payments: string
    amounts: string[]
    audits: string
  }>(
    `SELECT s.status,
            (SELECT count(*) FROM payments WHERE sale_id = $1 AND status = 'confirmed') AS payments,
            (SELECT coalesce(array_agg(amount::text ORDER BY received_at, id), '{}') FROM payments WHERE sale_id = $1 AND status = 'confirmed') AS amounts,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'sale.payment') AS audits
     FROM sales s WHERE s.id = $1`,
    [ids.saleId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Venda sintetica nao encontrada.')
  const evidence = { saleId: ids.saleId, status: row.status, payments: row.payments, amounts: row.amounts, paymentAudits: row.audits }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.status !== 'paid') failures.push(`status esperado paid, obteve ${row.status}`)
  if (row.payments !== '2') failures.push(`pagamentos esperavam 2, obteve ${row.payments}`)
  if (JSON.stringify([...row.amounts].sort()) !== JSON.stringify(['60.00', '90.00'])) {
    failures.push(`valores esperavam 60.00+90.00, obteve ${JSON.stringify(row.amounts)}`)
  }
  if (row.audits !== '2') failures.push(`auditorias esperavam 2, obteve ${row.audits}`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
