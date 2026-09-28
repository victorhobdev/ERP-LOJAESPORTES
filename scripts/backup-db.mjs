/* eslint-disable no-undef */
import { mkdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import {
  assertAbsolutePath,
  canonicalSafeBackupDir,
  childEnvironment,
  parseConnectionParts,
  registerTemporaryFileCleanup,
  sanitizeConnectionSearch,
  sanitizedConnectionUri,
  sha256File,
  toolInvocation,
  uniqueDumpPath,
  writeChecksumAtomic,
  writePgpassFile,
} from './backup-restore-lib.mjs'

if (process.argv.includes('--help')) {
  console.log('DATABASE_URL=... BACKUP_DIR=... node scripts/backup-db.mjs')
  process.exit(0)
}
const databaseUrl = process.env.DATABASE_URL
const backupDir = process.env.BACKUP_DIR
if (!databaseUrl || !backupDir) throw new Error('DATABASE_URL and BACKUP_DIR are required.')
let source
try {
  source = parseConnectionParts(databaseUrl)
} catch {
  throw new Error('DATABASE_URL must be a valid PostgreSQL URL.')
}
const resolvedDir = await canonicalSafeBackupDir(assertAbsolutePath(backupDir, 'BACKUP_DIR'))
await mkdir(resolvedDir, { recursive: true })
const file = await uniqueDumpPath(resolvedDir)
const pgpass = source.password === '' ? null : await writePgpassFile({
  host: source.host,
  port: source.port,
  database: source.database,
  username: source.username,
  password: source.password,
})
const cleanupPgpass = pgpass ? registerTemporaryFileCleanup(pgpass) : async () => {}
try {
  const safeSearch = sanitizeConnectionSearch(source.search)
  await runPgDump(sanitizedConnectionUri({ ...source, search: safeSearch }), pgpass, file)
  const size = await stat(file).then(
    (fileStat) => fileStat.size,
    () => { throw new Error('Backup dump is empty.') },
  )
  if (size === 0) throw new Error('Backup dump is empty.')
  const checksum = await sha256File(file)
  await writeChecksumAtomic(file, checksum)
  console.log(JSON.stringify({ file, checksum }))
} catch (error) {
  await rm(file, { force: true }).catch(() => {})
  await rm(`${file}.sha256`, { force: true }).catch(() => {})
  throw error
} finally {
  await cleanupPgpass()
}

function runPgDump(sanitizedUri, pgpass, file) {
  const env = childEnvironment(process.env, pgpass)
  const { command, args } = toolInvocation('pg_dump', process.env.ERP2_TEST_PG_DUMP, ['--format=custom', '--no-owner', '--file', file, sanitizedUri])
  const label = command === process.execPath ? 'pg_dump' : command
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.resume()
    child.stderr.resume()
    child.once('error', () => reject(new Error(`${label} failed to start.`)))
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed.`))
    })
  })
}
