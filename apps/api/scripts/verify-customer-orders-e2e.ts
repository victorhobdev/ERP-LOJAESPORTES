import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_CUSTOMER_ORDERS_IDS_FILE'] ?? 'e2e-artifacts/customer-orders-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  deliveredId?: string
  cancelledId?: string
}
if (!ids.deliveredId || !ids.cancelledId) throw new Error('deliveredId and cancelledId are required.')
const userId = process.env['E2E_USER_ID']
if (!userId) throw new Error('E2E_USER_ID is required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    delivered_status: string
    delivered_events: string
    delivered_audits: string
    cancelled_status: string
    cancelled_events: string
    cancelled_audits: string
    cancel_reason: string | null
    purchases: string
    movements: string
  }>(
    `SELECT
       (SELECT status FROM customer_orders WHERE id = $1) AS delivered_status,
       (SELECT count(*) FROM customer_order_events WHERE customer_order_id = $1) AS delivered_events,
       (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action LIKE 'customer_order.%') AS delivered_audits,
       (SELECT status FROM customer_orders WHERE id = $2) AS cancelled_status,
       (SELECT count(*) FROM customer_order_events WHERE customer_order_id = $2) AS cancelled_events,
       (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action LIKE 'customer_order.%') AS cancelled_audits,
       (SELECT cancellation_reason FROM customer_orders WHERE id = $2) AS cancel_reason,
       (SELECT count(*) FROM purchase_orders WHERE created_by = $3) AS purchases,
       (SELECT count(*) FROM inventory_movements WHERE user_id = $3) AS movements`,
    [ids.deliveredId, ids.cancelledId, userId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Encomendas sinteticas nao encontradas.')
  const evidence = {
    deliveredId: ids.deliveredId,
    cancelledId: ids.cancelledId,
    deliveredStatus: row.delivered_status,
    deliveredEvents: row.delivered_events,
    deliveredAudits: row.delivered_audits,
    cancelledStatus: row.cancelled_status,
    cancelledEvents: row.cancelled_events,
    cancelledAudits: row.cancelled_audits,
    cancelReason: row.cancel_reason,
    purchases: row.purchases,
    movements: row.movements,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.delivered_status !== 'delivered') failures.push(`entregue esperava delivered, obteve ${row.delivered_status}`)
  if (row.delivered_events !== '4') failures.push(`eventos da entregue esperavam 4, obteve ${row.delivered_events}`)
  if (row.delivered_audits !== '4') failures.push(`auditorias da entregue esperavam 4, obteve ${row.delivered_audits}`)
  if (row.cancelled_status !== 'cancelled') failures.push(`cancelada esperava cancelled, obteve ${row.cancelled_status}`)
  if (row.cancelled_events !== '2') failures.push(`eventos da cancelada esperavam 2, obteve ${row.cancelled_events}`)
  if (row.cancelled_audits !== '2') failures.push(`auditorias da cancelada esperavam 2, obteve ${row.cancelled_audits}`)
  if (!row.cancel_reason) failures.push('motivo do cancelamento ausente')
  if (row.purchases !== '0') failures.push(`compras esperavam 0, obteve ${row.purchases}`)
  if (row.movements !== '0') failures.push(`movimentos esperavam 0, obteve ${row.movements}`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
