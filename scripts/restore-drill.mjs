/* eslint-disable no-undef */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

if (process.argv.includes('--help')) {
  console.log('BACKUP_FILE=... RESTORE_DATABASE_URL=..._restore_test node scripts/restore-drill.mjs')
  process.exit(0)
}
const backupFile = process.env.BACKUP_FILE
const restoreUrl = process.env.RESTORE_DATABASE_URL
if (!backupFile || !restoreUrl) throw new Error('BACKUP_FILE and RESTORE_DATABASE_URL are required.')
const databaseName = decodeURIComponent(new URL(restoreUrl).pathname.slice(1))
if (!databaseName.endsWith('_restore_test')) throw new Error('Restore drill refuses databases not ending in _restore_test.')
const resolvedFile = path.resolve(backupFile)
const expected = (await readFile(`${resolvedFile}.sha256`, 'utf8')).trim().split(/\s+/)[0]
const actual = createHash('sha256').update(await readFile(resolvedFile)).digest('hex')
if (expected !== actual) throw new Error('Backup checksum mismatch.')
await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--dbname', restoreUrl, resolvedFile])
await run('psql', [restoreUrl, '--no-psqlrc', '--tuples-only', '--command', 'SELECT count(*) FROM schema_migrations;'])
console.log(JSON.stringify({ restored: resolvedFile, database: databaseName, checksum: actual }))

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}
