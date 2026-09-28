import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_SALES_IDS_FILE'] ?? 'e2e-artifacts/sales-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
if (!existsSync(idsFile)) throw new Error(`ids file not found: ${configuredIdsFile}`)
const ids = JSON.parse(readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
  saleId?: string
  variantId?: string
}
if (!ids.saleId || !ids.variantId) throw new Error('saleId and variantId are required.')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    status: string
    stock_quantity: number
    payments: string
    exchanges: string
    exchange_items: string
    movements: string
    payment_audits: string
    exchange_audits: string
  }>(
    `SELECT s.status,
            (SELECT stock_quantity FROM product_variants WHERE id = $2) AS stock_quantity,
            (SELECT count(*) FROM payments WHERE sale_id = $1 AND status = 'confirmed') AS payments,
            (SELECT count(*) FROM exchanges WHERE sale_id = $1) AS exchanges,
            (SELECT count(*) FROM exchange_items ei JOIN exchanges e ON e.id = ei.exchange_id WHERE e.sale_id = $1) AS exchange_items,
            (SELECT count(*) FROM inventory_movements
              WHERE source_entity_id = $1
                 OR source_entity_id IN (SELECT id FROM exchanges WHERE sale_id = $1)) AS movements,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'sale.payment') AS payment_audits,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'sale.exchange') AS exchange_audits
     FROM sales s WHERE s.id = $1`,
    [ids.saleId, ids.variantId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Venda sintetica nao encontrada.')
  const evidence = {
    saleId: ids.saleId,
    status: row.status,
    stockQuantity: row.stock_quantity,
    payments: row.payments,
    exchanges: row.exchanges,
    exchangeItems: row.exchange_items,
    movements: row.movements,
    paymentAudits: row.payment_audits,
    exchangeAudits: row.exchange_audits,
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  const failures: string[] = []
  if (row.status !== 'paid') failures.push(`status esperado paid, obteve ${row.status}`)
  if (row.payments !== '1') failures.push(`pagamentos esperavam 1, obteve ${row.payments}`)
  if (row.exchanges !== '1') failures.push(`trocas esperavam 1, obteve ${row.exchanges}`)
  if (row.exchange_items !== '2') failures.push(`itens de troca esperavam 2, obteve ${row.exchange_items}`)
  if (row.movements !== '3') failures.push(`movimentos esperavam 3, obteve ${row.movements}`)
  if (row.payment_audits !== '1') failures.push(`auditorias de pagamento esperavam 1, obteve ${row.payment_audits}`)
  if (row.exchange_audits !== '1') failures.push(`auditorias de troca esperavam 1, obteve ${row.exchange_audits}`)
  const deltaSum = await pool.query<{ sum: string }>(
    `SELECT coalesce(sum(quantity_delta), 0)::text AS sum FROM inventory_movements WHERE variant_id = $1`,
    [ids.variantId],
  )
  // Contrato da seed: variante criada com saldo 5 sem movimento de abertura.
  const expectedStock = 5 + Number(deltaSum.rows[0]?.sum ?? 0)
  if (row.stock_quantity !== expectedStock) failures.push(`estoque ${row.stock_quantity} inconsistente com deltas (esperado ${expectedStock})`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
