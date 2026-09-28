import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Pool } from 'pg'

import {
  GEMINI_CONFERENCE_SOURCE_NAME,
  GEMINI_CONFERENCE_SOURCE_CHECKSUM,
  GeminiConferenceConflict,
  STOCK_RECONCILIATION,
  runGeminiConferenceMigration,
} from '../src/modules/migration/gemini-conference.js'
import { normalizeGeminiDump } from '../src/modules/migration/gemini-dump.js'
import { parseMysqlDump } from '../src/modules/migration/mysql-dump.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['HOMOLOG_DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
if (!databaseUrl) throw new Error('HOMOLOG_DATABASE_URL or TEST_DATABASE_URL is required.')
await assertTestDatabaseUrl(databaseUrl)

const dumpPath = process.argv[2] && !process.argv[2]!.startsWith('--')
  ? process.argv[2]!
  : findReferenceDump()
const mode = process.argv.includes('--apply') ? 'apply' as const : 'dry-run' as const

const dumpBytes = readFileSync(dumpPath)
const normalized = normalizeGeminiDump(parseMysqlDump(dumpBytes.toString('utf8')))
validateReferenceDump(normalized)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const artifactsDirectory = path.join(repoRoot, 'e2e-artifacts')

const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  const database = await pool.query<{ name: string }>('SELECT current_database() AS name')
  if (database.rows[0]?.name !== 'erp2_homolog_test') {
    throw new Error(`Refusing to touch database "${database.rows[0]?.name ?? ''}": expected erp2_homolog_test.`)
  }
  const actor = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'migracao.gemini'")
  if (!actor.rows[0]) throw new Error('Usuário migracao.gemini não encontrado; a migração base do dump precisa existir primeiro.')

  const migration = await runGeminiConferenceMigration(pool, { mode, actorUserId: actor.rows[0].id })
  const report = {
    mode,
    database: database.rows[0].name,
    referenceDump: path.resolve(dumpPath),
    referenceDumpSha256: createHash('sha256').update(dumpBytes).digest('hex'),
    sourceName: GEMINI_CONFERENCE_SOURCE_NAME,
    sourceChecksum: GEMINI_CONFERENCE_SOURCE_CHECKSUM,
    migration,
  }
  mkdirSync(artifactsDirectory, { recursive: true })
  writeFileSync(path.join(artifactsDirectory, 'migration-gemini-conference-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (error instanceof GeminiConferenceConflict) {
    const report = {
      mode,
      database: 'erp2_homolog_test',
      referenceDump: path.resolve(dumpPath),
      referenceDumpSha256: createHash('sha256').update(dumpBytes).digest('hex'),
      sourceName: GEMINI_CONFERENCE_SOURCE_NAME,
      sourceChecksum: GEMINI_CONFERENCE_SOURCE_CHECKSUM,
      migration: error.report,
    }
    mkdirSync(artifactsDirectory, { recursive: true })
    writeFileSync(path.join(artifactsDirectory, 'migration-gemini-conference-report.json'), JSON.stringify(report, null, 2))
    console.error(JSON.stringify(report, null, 2))
    process.exitCode = 2
  } else {
    throw error
  }
} finally {
  await pool.end()
}

function findReferenceDump(): string {
  for (const candidate of ['backups/gemini_teste-mysql-20260904-090700.sql', '../../backups/gemini_teste-mysql-20260904-090700.sql']) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // tenta o próximo caminho
    }
  }
  throw new Error('Dump de referência não encontrado.')
}

function validateReferenceDump(dump: ReturnType<typeof normalizeGeminiDump>) {
  for (const target of STOCK_RECONCILIATION) {
    const row = dump.products.find((product) => product.legacyId === target.legacyId)
    if (!row || row.stockQuantity !== target.expectedBefore) {
      throw new Error(`Dump de referência incompatível para ProdutoID ${target.legacyId}.`)
    }
  }
}
