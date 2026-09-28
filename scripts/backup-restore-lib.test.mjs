/* eslint-disable no-undef */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertAbsolutePath,
  assertMigrationSet,
  assertSafeBackupDir,
  canonicalSafeBackupDir,
  childEnvironment,
  listMigrationFilenames,
  parseChecksumSidecar,
  parseMigrationVersions,
  parseRestoreTarget,
  removePgpassFile,
  sanitizeConnectionSearch,
  sha256File,
  toolInvocation,
  uniqueDumpPath,
  writeChecksumAtomic,
  writePgpassFile,
} from './backup-restore-lib.mjs'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'erp2-backup-test-'))
}

test('assertAbsolutePath rejects relative and empty values without echoing secrets', () => {
  assert.throws(() => assertAbsolutePath('', 'BACKUP_DIR'), /absolute/)
  assert.throws(() => assertAbsolutePath('relative/dir', 'BACKUP_DIR'), /absolute/)
  assert.throws(() => assertAbsolutePath('postgresql://user:pass@host/db', 'DATABASE_URL'), /absolute/)
  assert.equal(typeof assertAbsolutePath(path.resolve('x'), 'BACKUP_DIR'), 'string')
})

test('assertSafeBackupDir refuses filesystem root and live data directories', async () => {
  const root = path.parse(process.cwd()).root
  await assert.rejects(() => assertSafeBackupDir(root), /unsafe/)
  const dataDir = tempDir()
  try {
    writeFileSync(path.join(dataDir, 'PG_VERSION'), '16\n')
  await assert.rejects(() => assertSafeBackupDir(dataDir), /unsafe|data directory/i)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
  const clean = tempDir()
  try {
    await assertSafeBackupDir(clean)
  } finally {
    rmSync(clean, { recursive: true, force: true })
  }
})

test('uniqueDumpPath never reuses an existing name', async () => {
  const dir = tempDir()
  try {
    const first = await uniqueDumpPath(dir)
    assert.match(path.basename(first), /^erp2-.*\.dump$/)
    writeFileSync(first, 'taken')
    const second = await uniqueDumpPath(dir)
    assert.notEqual(first, second)
    assert.throws(() => statSync(second), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeChecksumAtomic stores a verifiable sidecar', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'erp2-test.dump')
    writeFileSync(file, 'bytes')
    await writeChecksumAtomic(file, 'ab'.repeat(32))
    const sidecar = `${file}.sha256`
    assert.equal(statSync(sidecar).size > 0, true)
    assert.equal(parseChecksumSidecar(readFileSync(sidecar, 'utf8')), 'ab'.repeat(32))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseChecksumSidecar rejects malformed content', () => {
  assert.equal(parseChecksumSidecar(`${'cd'.repeat(32)}  erp2-x.dump\n`), 'cd'.repeat(32))
  assert.throws(() => parseChecksumSidecar(''), /checksum/i)
  assert.throws(() => parseChecksumSidecar('not-hex  erp2-x.dump\n'), /checksum/i)
  assert.throws(() => parseChecksumSidecar(`${'ab'.repeat(31)}  erp2-x.dump\n`), /checksum/i)
})

test('parseRestoreTarget allows only loopback hosts with the disposable suffix', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const target = parseRestoreTarget(`postgresql://user:pass@${host}:5432/app_restore_test`)
    assert.equal(target.databaseName, 'app_restore_test')
    assert.equal(target.host, host.replace(/^\[(.*)\]$/, '$1'))
    assert.ok(!target.sanitizedUri.includes('pass'), 'sanitized URI must not carry the password')
    assert.ok(!target.sanitizedUri.includes('?') && !target.sanitizedUri.includes('#'), 'sanitized URI must not carry query or fragment')
  }
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@postgres:5432/app_restore_test'), /host/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@db:5432/app_restore_test'), /host/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@prod.example.com:5432/app_restore_test'), /host/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_test?hostaddr=203.0.113.10'), /query/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_test?host=db.internal'), /query/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_test?dbname=prod'), /query/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_test?service=prod'), /query/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_test#frag'), /fragment/i)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app'), /_restore_test/)
  assert.throws(() => parseRestoreTarget('postgresql://user:pass@127.0.0.1:5432/app_restore_testing'), /_restore_test/)
  assert.throws(() => parseRestoreTarget('not a url at all'), /URL/i)
  assert.throws(() => parseRestoreTarget('https://127.0.0.1:5432/app_restore_test'), /URL|protocol/i)
})

test('sanitized restore URI preserves user, port and database only', () => {
  const target = parseRestoreTarget('postgresql://op%40x:s3cret@127.0.0.1:5543/app_restore_test')
  assert.equal(target.sanitizedUri, 'postgresql://op%40x@127.0.0.1:5543/app_restore_test')
  const ipv6 = parseRestoreTarget('postgresql://op@[::1]/app_restore_test')
  assert.equal(ipv6.sanitizedUri, 'postgresql://op@[::1]/app_restore_test')
  const noPort = parseRestoreTarget('postgresql://op@127.0.0.1/app_restore_test')
  assert.equal(noPort.sanitizedUri, 'postgresql://op@127.0.0.1/app_restore_test')
})

test('backup connection parameters preserve TLS options but reject destination or secret overrides', () => {
  assert.equal(sanitizeConnectionSearch('?sslmode=require&connect_timeout=5'), '?sslmode=require&connect_timeout=5')
  assert.throws(() => sanitizeConnectionSearch('?hostaddr=203.0.113.10'), /parameter/i)
  assert.throws(() => sanitizeConnectionSearch('?password=leaked'), /parameter/i)
  assert.throws(() => sanitizeConnectionSearch('?unknown=value'), /parameter/i)
})

test('childEnvironment removes inherited libpq destination and password overrides', () => {
  const env = childEnvironment({ PGHOSTADDR: '203.0.113.10', pgHoStAddr: '203.0.113.11', pgservice: 'prod', PGPASSWORD: 'wrong', pgpassword: 'wrong-too', KEEP: 'yes' }, 'C:/tmp/pgpass')
  assert.equal(env.PGHOSTADDR, undefined)
  assert.equal(env.pgHoStAddr, undefined)
  assert.equal(env.PGSERVICE, undefined)
  assert.equal(env.pgservice, undefined)
  assert.equal(env.PGPASSWORD, undefined)
  assert.equal(env.pgpassword, undefined)
  assert.equal(env.PGPASSFILE, 'C:/tmp/pgpass')
  assert.equal(env.KEEP, 'yes')
})

test('parseRestoreTarget never echoes the input URL', () => {
  const secret = 'postgresql://admin:s3cret@evil.example:5432/x'
  try {
    parseRestoreTarget(secret)
    assert.fail('should have thrown')
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /./)
    assert.equal((error instanceof Error ? error.message : String(error)).includes('s3cret'), false)
    assert.equal((error instanceof Error ? error.message : String(error)).includes('evil.example'), false)
  }
})

test('migration versions must match the expected set exactly', () => {
  assert.deepEqual(parseMigrationVersions('001_a.sql\n002_b.sql\n'), ['001_a.sql', '002_b.sql'])
  assert.throws(() => parseMigrationVersions(''), /migration/i)
  assert.throws(() => parseMigrationVersions('   \n'), /migration/i)
  const expected = ['001_a.sql', '002_b.sql']
  assertMigrationSet(['002_b.sql', '001_a.sql'], expected)
  assert.throws(() => assertMigrationSet(['001_a.sql', '002_b.sql', '003_x.sql'], expected), /migration/i)
  assert.throws(() => assertMigrationSet(['001_a.sql'], expected), /migration/i)
  assert.throws(() => assertMigrationSet(['001_a.sql', '002_c.sql'], expected), /migration/i)
})

test('listMigrationFilenames reads the repo migration set', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api', 'migrations')
  const names = await listMigrationFilenames(dir)
  assert.ok(names.length >= 3, 'expected at least the seeded migrations')
  assert.deepEqual([...names].sort(), names)
  for (const name of names) assert.match(name, /^\d+_.+\.sql$/)
})

test('sha256File streams the same digest without loading everything', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'data.bin')
    const bytes = Buffer.alloc(300_000, 7)
    writeFileSync(file, bytes)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(await sha256File(file), expected)
    assert.equal(expected, createHash('sha256').update(Buffer.alloc(300_000, 7)).digest('hex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pgpass round-trips an escaped entry with restrictive mode', async () => {
  const file = await writePgpassFile({ host: '127.0.0.1', port: '5432', database: 'app_restore_test', username: 'u:x', password: 'p\\ss:w' })
  try {
    assert.equal(readFileSync(file, 'utf8'), '127.0.0.1:5432:app_restore_test:u\\:x:p\\\\ss\\:w\n')
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600)
    }
    await removePgpassFile(file)
    assert.throws(() => statSync(file), /ENOENT/)
  } finally {
    await removePgpassFile(file)
  }
})

test('canonicalSafeBackupDir rejects links resolving into PGDATA', async (t) => {
  const base = tempDir()
  try {
    const pgdata = path.join(base, 'pgdata')
    mkdirSync(pgdata, { recursive: true })
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '16\n')
    const link = path.join(base, 'link-pgdata')
    try {
      symlinkSync(pgdata, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`platform cannot create links: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    await assert.rejects(() => canonicalSafeBackupDir(link), /unsafe|PGDATA|data/i)
    const safeTarget = path.join(base, 'safe')
    mkdirSync(safeTarget, { recursive: true })
    const safeLink = path.join(base, 'link-safe')
    try {
      symlinkSync(safeTarget, safeLink, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`platform cannot create links: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    assert.equal(await canonicalSafeBackupDir(safeLink), await canonicalSafeBackupDir(safeTarget))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('toolInvocation only overrides binaries under NODE_ENV=test', () => {
  const previous = process.env.NODE_ENV
  try {
    delete process.env.NODE_ENV
    assert.deepEqual(toolInvocation('pg_dump', '/tmp/fake.mjs', ['--a']), { command: 'pg_dump', args: ['--a'] })
    process.env.NODE_ENV = 'production'
    assert.deepEqual(toolInvocation('pg_dump', '/tmp/fake.mjs', ['--a']), { command: 'pg_dump', args: ['--a'] })
    process.env.NODE_ENV = 'test'
    assert.deepEqual(toolInvocation('pg_dump', '', ['--a']), { command: 'pg_dump', args: ['--a'] })
    assert.deepEqual(toolInvocation('pg_dump', undefined, ['--a']), { command: 'pg_dump', args: ['--a'] })
    const overridden = toolInvocation('pg_dump', '/tmp/fake.mjs', ['--a', 'b'])
    assert.equal(overridden.command, process.execPath)
    assert.deepEqual(overridden.args, ['/tmp/fake.mjs', '--a', 'b'])
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('nested directories are created only by the caller after safety checks', async () => {
  const base = tempDir()
  try {
    const nested = path.join(base, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    await assertSafeBackupDir(nested)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
