/* eslint-disable no-undef */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

if (process.argv.includes('--help')) {
  console.log('DATABASE_URL=... BACKUP_DIR=... node scripts/backup-db.mjs')
  process.exit(0)
}
const databaseUrl = process.env.DATABASE_URL
const backupDir = process.env.BACKUP_DIR
if (!databaseUrl || !backupDir) throw new Error('DATABASE_URL and BACKUP_DIR are required.')
const resolvedDir = path.resolve(backupDir)
await mkdir(resolvedDir, { recursive: true })
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const file = path.join(resolvedDir, `erp2-${timestamp}.dump`)
await run('pg_dump', ['--format=custom', '--no-owner', '--file', file, databaseUrl])
const checksum = createHash('sha256').update(await readFile(file)).digest('hex')
await writeFile(`${file}.sha256`, `${checksum}  ${path.basename(file)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ file, checksum }))

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}
