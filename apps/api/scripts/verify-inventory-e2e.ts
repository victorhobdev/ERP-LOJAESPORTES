import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_INVENTORY_IDS_FILE'] ?? 'e2e-artifacts/inventory-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  productId?: string
  variantId?: string
}
if (!ids.productId || !ids.variantId) throw new Error('productId and variantId are required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    stock_quantity: number
    movements: string
    delta_sum: string
    audits: string
    product_audits: string
  }>(
    `SELECT v.stock_quantity,
            (SELECT count(*) FROM inventory_movements WHERE variant_id = $1) AS movements,
            (SELECT coalesce(sum(quantity_delta), 0) FROM inventory_movements WHERE variant_id = $1) AS delta_sum,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'inventory.manual_adjustment') AS audits,
            (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action IN ('product.create', 'product.update')) AS product_audits
     FROM product_variants v WHERE v.id = $1`,
    [ids.variantId, ids.productId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Variante sintetica nao encontrada.')
  const evidence = {
    productId: ids.productId,
    variantId: ids.variantId,
    stockQuantity: row.stock_quantity,
    movements: row.movements,
    deltaSum: row.delta_sum,
    adjustmentAudits: row.audits,
    productAudits: row.product_audits,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.movements !== '2') failures.push(`movimentos esperavam 2, obteve ${row.movements}`)
  if (row.audits !== '2') failures.push(`auditorias de ajuste esperavam 2, obteve ${row.audits}`)
  if (Number(row.delta_sum) !== row.stock_quantity) failures.push(`saldo ${row.stock_quantity} nao explicado pela soma ${row.delta_sum}`)
  if (row.product_audits !== '2') failures.push(`auditorias de produto esperavam 2 (create+update), obteve ${row.product_audits}`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
