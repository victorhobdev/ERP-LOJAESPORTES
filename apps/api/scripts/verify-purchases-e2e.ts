import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_PURCHASES_IDS_FILE'] ?? 'e2e-artifacts/purchases-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  orderId?: string
  variantId?: string
}
if (!ids.orderId || !ids.variantId) throw new Error('orderId and variantId are required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    status: string
    ordered: string
    received: string
    receipts: string
    movements: string
    order_audits: string
    receive_audits: string
    stock_quantity: number
  }>(
    `SELECT po.status,
            (SELECT sum(ordered_quantity) FROM purchase_order_items WHERE purchase_order_id = $1) AS ordered,
            (SELECT sum(received_quantity) FROM purchase_order_items WHERE purchase_order_id = $1) AS received,
            (SELECT count(*) FROM goods_receipts WHERE purchase_order_id = $1) AS receipts,
            (SELECT count(*) FROM inventory_movements
              WHERE source_entity_type = 'goods_receipt'
                AND source_entity_id IN (SELECT id FROM goods_receipts WHERE purchase_order_id = $1)) AS movements,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'purchase_order.create') AS order_audits,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'purchase_order.receive') AS receive_audits,
            (SELECT stock_quantity FROM product_variants WHERE id = $2) AS stock_quantity
     FROM purchase_orders po WHERE po.id = $1`,
    [ids.orderId, ids.variantId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Pedido sintetico nao encontrado.')
  const evidence = {
    orderId: ids.orderId,
    status: row.status,
    ordered: row.ordered,
    received: row.received,
    receipts: row.receipts,
    movements: row.movements,
    orderAudits: row.order_audits,
    receiveAudits: row.receive_audits,
    stockQuantity: row.stock_quantity,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.status !== 'fully_received') failures.push(`status esperado fully_received, obteve ${row.status}`)
  if (row.ordered !== '4') failures.push(`pedido esperado 4, obteve ${row.ordered}`)
  if (row.received !== '4') failures.push(`recebido esperado 4, obteve ${row.received}`)
  if (row.receipts !== '2') failures.push(`recebimentos esperavam 2, obteve ${row.receipts}`)
  if (row.movements !== '2') failures.push(`movimentos esperavam 2, obteve ${row.movements}`)
  if (row.order_audits !== '1') failures.push(`auditoria de criacao esperava 1, obteve ${row.order_audits}`)
  if (row.receive_audits !== '2') failures.push(`auditorias de recebimento esperavam 2, obteve ${row.receive_audits}`)
  if (Number(row.stock_quantity) < Number(row.received)) failures.push(`estoque ${row.stock_quantity} inconsistente com recebido ${row.received}`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
