import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Pool } from 'pg'

import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const configuredIdsFile = process.env['E2E_IDS_FILE'] ?? 'e2e-artifacts/paid-sale-fullstack-ids.json'
const idsFile = [configuredIdsFile, resolve(process.cwd(), '../../', configuredIdsFile)].find((candidate) => existsSync(candidate)) ?? configuredIdsFile
const lastLine = existsSync(idsFile) ? readFileSync(idsFile, 'utf8').trim().split('\n').at(-1) ?? '{}' : '{}'
const fromFile = JSON.parse(lastLine) as { saleId?: string; retrySaleId?: string; firstServerSaleId?: string }
const variantId = process.env['E2E_VARIANT_ID']
const saleId = process.env['E2E_SALE_ID'] ?? fromFile.saleId
const retrySaleId = process.env['E2E_RETRY_SALE_ID'] ?? fromFile.retrySaleId
const firstServerSaleId = process.env['E2E_FIRST_SERVER_SALE_ID'] ?? fromFile.firstServerSaleId
if (!variantId || !saleId) {
  throw new Error('E2E_VARIANT_ID and a sale id (file or E2E_SALE_ID) are required.')
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const state = await pool.query<{
    stock_quantity: number
    sales: string
    payments: string
    movements: string
    audits: string
  }>(
    `SELECT v.stock_quantity,
            (SELECT count(*) FROM sales WHERE id = $2) AS sales,
            (SELECT count(*) FROM payments WHERE sale_id = $2 AND status = 'confirmed') AS payments,
            (SELECT count(*) FROM inventory_movements WHERE source_entity_type = 'sale' AND source_entity_id = $2) AS movements,
            (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action = 'sale.create') AS audits
     FROM product_variants v WHERE v.id = $1`,
    [variantId, saleId],
  )
  const row = state.rows[0]
  if (!row) throw new Error('Variante sintetica nao encontrada.')
  const evidence: Record<string, unknown> = {
    saleId,
    stockQuantity: row.stock_quantity,
    sales: row.sales,
    payments: row.payments,
    movements: row.movements,
    saleCreateAudits: row.audits,
  }
  const failures: string[] = []
  if (row.sales !== '1') failures.push(`venda esperava 1 registro, obteve ${row.sales}`)
  if (row.payments !== '1') failures.push(`pagamento esperado 1 confirmado, obteve ${row.payments}`)
  if (row.movements !== '1') failures.push(`baixa esperada 1 movimento, obteve ${row.movements}`)
  if (row.audits !== '1') failures.push(`auditoria sale.create esperada 1, obteve ${row.audits}`)
  if (retrySaleId) {
    evidence.retrySaleId = retrySaleId
    evidence.retryMatchesFirstServerResponse = retrySaleId === firstServerSaleId
    const retryState = await pool.query<{ sales: string; payments: string; movements: string; audits: string }>(
      `SELECT (SELECT count(*) FROM sales WHERE id = $1) AS sales,
              (SELECT count(*) FROM payments WHERE sale_id = $1 AND status = 'confirmed') AS payments,
              (SELECT count(*) FROM inventory_movements WHERE source_entity_type = 'sale' AND source_entity_id = $1) AS movements,
              (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'sale.create') AS audits`,
      [retrySaleId],
    )
    evidence.retryEffects = retryState.rows[0]
    if (retrySaleId !== firstServerSaleId) failures.push('retentativa nao retornou a mesma venda da resposta perdida')
    if (retryState.rows[0]?.payments !== '1' || retryState.rows[0]?.movements !== '1' || retryState.rows[0]?.audits !== '1') {
      failures.push('retentativa duplicou efeitos no banco')
    }
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
