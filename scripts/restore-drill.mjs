/* eslint-disable no-undef */
import { timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  assertAbsolutePath,
  assertMigrationSet,
  childEnvironment,
  listMigrationFilenames,
  parseChecksumSidecar,
  parseMigrationVersions,
  parseRestoreTarget,
  registerTemporaryFileCleanup,
  sha256File,
  toolInvocation,
  writePgpassFile,
} from './backup-restore-lib.mjs'

if (process.argv.includes('--help')) {
  console.log('BACKUP_FILE=... RESTORE_DATABASE_URL=..._restore_test node scripts/restore-drill.mjs')
  process.exit(0)
}
const backupFile = process.env.BACKUP_FILE
const restoreUrl = process.env.RESTORE_DATABASE_URL
if (!backupFile || !restoreUrl) throw new Error('BACKUP_FILE and RESTORE_DATABASE_URL are required.')
const resolvedFile = assertAbsolutePath(backupFile, 'BACKUP_FILE')
const fileStat = await stat(resolvedFile).catch(() => null)
if (!fileStat?.isFile()) throw new Error('Backup file not found.')
const target = parseRestoreTarget(restoreUrl)
let sidecar
try {
  sidecar = await readFile(`${resolvedFile}.sha256`, 'utf8')
} catch {
  throw new Error('Backup checksum file is missing or unreadable.')
}
const expected = parseChecksumSidecar(sidecar)
const actual = await sha256File(resolvedFile)
if (expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
  throw new Error('Backup checksum mismatch.')
}
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api', 'migrations')
const expectedMigrations = await listMigrationFilenames(migrationsDir)
const pgpass = target.password === '' ? null : await writePgpassFile({
  host: target.host,
  port: target.port,
  database: target.databaseName,
  username: target.username,
  password: target.password,
})
const cleanupPgpass = pgpass ? registerTemporaryFileCleanup(pgpass) : async () => {}
try {
  await runTool('pg_restore', 'ERP2_TEST_PG_RESTORE', ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--dbname', target.sanitizedUri, resolvedFile], pgpass)
  const versions = await runToolCapture(
    'psql',
    'ERP2_TEST_PSQL',
    [target.sanitizedUri, '--no-psqlrc', '--tuples-only', '--command', 'SELECT filename FROM schema_migrations ORDER BY filename;'],
    pgpass,
  )
  const restored = parseMigrationVersions(versions)
  assertMigrationSet(restored, expectedMigrations)
  console.log(JSON.stringify({ restored: resolvedFile, database: target.databaseName, checksum: actual, migrations: restored.length }))
} finally {
  await cleanupPgpass()
}

function childEnv(pgpass) {
  return childEnvironment(process.env, pgpass)
}

function runTool(defaultBinary, overrideEnv, args, pgpass) {
  const { command, args: finalArgs } = toolInvocation(defaultBinary, process.env[overrideEnv], args)
  const label = command === process.execPath ? defaultBinary : command
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, { env: childEnv(pgpass), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.resume()
    child.stderr.resume()
    child.once('error', () => reject(new Error(`${label} failed to start.`)))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label} failed.`)))
  })
}

function runToolCapture(defaultBinary, overrideEnv, args, pgpass) {
  const { command, args: finalArgs } = toolInvocation(defaultBinary, process.env[overrideEnv], args)
  const label = command === process.execPath ? defaultBinary : command
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, { env: childEnv(pgpass), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.resume()
    child.once('error', () => reject(new Error(`${label} failed to start.`)))
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${label} failed.`)))
  })
}
