import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { Pool } from 'pg'

import { normalizeGeminiDump } from '../src/modules/migration/gemini-dump.js'
import { migrateLegacyCustomerOrders } from '../src/modules/migration/legacy-customer-orders.js'
import { migrateLegacyPurchases } from '../src/modules/migration/legacy-purchases.js'
import { migrateLegacyProducts } from '../src/modules/migration/legacy-products.js'
import { migrateLegacySales } from '../src/modules/migration/legacy-sales.js'
import { parseMysqlDump } from '../src/modules/migration/mysql-dump.js'
import { buildReconciliationReport } from '../src/modules/migration/reconcile.js'
import { applyMigrations } from '../src/shared/db/migrate.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

/**
 * Migração de homologação do dump autorizado `gemini_teste` (somente leitura do dump;
 * escrita exclusivamente no PostgreSQL de teste/homologação terminado em `_test`).
 *
 * Uso: TEST_DATABASE_URL=... node --import tsx scripts/migrate-gemini-dump.ts [dump.sql]
 */
const databaseUrl = process.env['TEST_DATABASE_URL']
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const dumpPath = process.argv[2]
  ?? (() => {
    // Procura o dump autorizado no repo e em ../backups (script roda de apps/api).
    for (const candidate of ['backups/gemini_teste-mysql-20260904-090700.sql', '../../backups/gemini_teste-mysql-20260904-090700.sql']) {
      try {
        readFileSync(candidate, 'utf8')
        return candidate
      } catch { /* tenta o próximo */ }
    }
    throw new Error('Dump autorizado não encontrado (esperado backups/gemini_teste-mysql-20260904-090700.sql).')
  })()
const sourceName = 'gemini_teste'

const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  await applyMigrations(pool)
  const actor = await ensureMigrationActor(pool)
  const dump = parseMysqlDump(readFileSync(dumpPath, 'utf8'))
  const normalized = normalizeGeminiDump(dump)

  const products = await migrateLegacyProducts(pool, { sourceName, actorUserId: actor, rows: normalized.products })
  const sales = await migrateLegacySales(pool, { sourceName, actorUserId: actor, rows: normalized.sales })
  const purchases = await migrateLegacyPurchases(pool, { sourceName, actorUserId: actor, rows: normalized.purchases })
  const customerOrders = await migrateLegacyCustomerOrders(pool, {
    sourceName,
    actorUserId: actor,
    rows: normalized.customerOrders.map((order) => ({
      ...order,
      customer: normalized.customers.find((customer) => customer.legacyId === order.customerLegacyId) ?? null,
    })),
  })

  const reconciliation = await buildReconciliationReport(pool, normalized)
  const report = { dumpPath, sourceName, products, sales, purchases, customerOrders, reconciliation }
  console.log(JSON.stringify(report, null, 2))

  mkdirSync('e2e-artifacts', { recursive: true })
  writeFileSync(path.join('e2e-artifacts', 'migration-gemini-report.json'), JSON.stringify(report, null, 2))
} finally {
  await pool.end()
}

async function ensureMigrationActor(pool: Pool): Promise<string> {
  const existing = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'migracao.gemini'")
  if (existing.rows[0]) return existing.rows[0].id
  const id = randomUUID()
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role_id)
     VALUES ($1, 'migracao.gemini', 'Migração gemini_teste', $2, '00000000-0000-4000-8000-000000000001')`,
    [id, `migracao:${randomUUID()}:${randomUUID()}`],
  )
  return id
}
