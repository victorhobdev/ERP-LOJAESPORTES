/* eslint-disable no-undef */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SECRET_URL = 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/erp2_test'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

let sharedFakes = null
function fakeTools() {
  if (!sharedFakes) {
    const dir = tempDir('erp2-faketools-')
    const dump = path.join(dir, 'fake-pg-dump.mjs')
    const restore = path.join(dir, 'fake-pg-restore.mjs')
    const psql = path.join(dir, 'fake-psql.mjs')
    writeFileSync(dump, `import { existsSync, writeFileSync } from 'node:fs'
if (process.env.FAKE_PG_DUMP_FAIL) process.exit(1)
const file = process.argv[process.argv.indexOf('--file') + 1]
if (process.env.FAKE_DUMP_RECORD) writeFileSync(process.env.FAKE_DUMP_RECORD, JSON.stringify({ args: process.argv.slice(2), hasPgpass: Boolean(process.env.PGPASSFILE), pgpassPath: process.env.PGPASSFILE ?? '', pgpassExists: process.env.PGPASSFILE ? existsSync(process.env.PGPASSFILE) : false, inheritedHostaddr: process.env.PGHOSTADDR ?? null, inheritedService: process.env.PGSERVICE ?? null, inheritedPassword: process.env.PGPASSWORD ?? null }))
writeFileSync(file, process.env.FAKE_PG_DUMP_EMPTY ? '' : 'FAKE-DUMP-BYTES\\n')
`)
    writeFileSync(restore, `import { existsSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), hasPgpass: Boolean(process.env.PGPASSFILE), pgpassPath: process.env.PGPASSFILE ?? '', pgpassExists: process.env.PGPASSFILE ? existsSync(process.env.PGPASSFILE) : false, inheritedHostaddr: process.env.PGHOSTADDR ?? null, inheritedService: process.env.PGSERVICE ?? null, inheritedPassword: process.env.PGPASSWORD ?? null }))
if (process.env.FAKE_PG_RESTORE_FAIL) process.exit(1)
`)
    writeFileSync(psql, `import { existsSync, writeFileSync } from 'node:fs'
if (process.env.FAKE_PSQL_RECORD) writeFileSync(process.env.FAKE_PSQL_RECORD, JSON.stringify({ args: process.argv.slice(2), hasPgpass: Boolean(process.env.PGPASSFILE), pgpassPath: process.env.PGPASSFILE ?? '', pgpassExists: process.env.PGPASSFILE ? existsSync(process.env.PGPASSFILE) : false, inheritedHostaddr: process.env.PGHOSTADDR ?? null, inheritedService: process.env.PGSERVICE ?? null, inheritedPassword: process.env.PGPASSWORD ?? null }))
process.stdout.write(process.env.FAKE_PSQL_OUTPUT ?? '001_initial.sql\\n002_manager_purchase_read.sql\\n003_manager_customers_read.sql\\n')
`)
    sharedFakes = { dump, restore, psql }
  }
  return sharedFakes
}

async function runScript(name, env, args = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(scriptDir, name), ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    })
    return { exit: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      exit: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

function cleanEnv(extra) {
  const tools = fakeTools()
  return {
    NODE_ENV: 'test',
    ERP2_TEST_PG_DUMP: tools.dump,
    ERP2_TEST_PG_RESTORE: tools.restore,
    ERP2_TEST_PSQL: tools.psql,
    PATH: process.env.PATH,
    ...extra,
  }
}

test('backup --help works without configuration', async () => {
  const result = await runScript('backup-db.mjs', { PATH: process.env.PATH }, ['--help'])
  assert.equal(result.exit, 0)
  assert.ok(result.stdout.includes('BACKUP_DIR'))
})

test('backup refuses missing vars, relative and unsafe destinations', async () => {
  const noVars = await runScript('backup-db.mjs', cleanEnv({}))
  assert.notEqual(noVars.exit, 0)
  assert.match(noVars.stderr, /DATABASE_URL and BACKUP_DIR are required/)
  const relative = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: 'relative/dir' }))
  assert.notEqual(relative.exit, 0)
  const root = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: path.parse(process.cwd()).root }))
  assert.notEqual(root.exit, 0)
  assert.match(root.stderr, /unsafe/)
  const dataDir = tempDir('erp2-pgdata-')
  writeFileSync(path.join(dataDir, 'PG_VERSION'), '16\n')
  try {
    const data = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: dataDir }))
    assert.notEqual(data.exit, 0)
    assert.match(data.stderr, /unsafe|data directory/i)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('backup writes dump plus verifiable checksum without leaking the URL', async () => {
  const dir = tempDir('erp2-backup-')
  const dumpRecord = path.join(dir, 'pg-dump-record.json')
  try {
    const result = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: dir, FAKE_DUMP_RECORD: dumpRecord, PGHOSTADDR: '203.0.113.10', PGSERVICE: 'prod', PGPASSWORD: 'wrong' }))
    assert.equal(result.exit, 0)
    const body = JSON.parse(result.stdout)
    assert.match(body.file, /\.dump$/)
    assert.match(body.checksum, /^[0-9a-f]{64}$/)
    assert.equal(result.stdout.includes('s3cret-test-only'), false)
    const invocation = JSON.parse(readFileSync(dumpRecord, 'utf8'))
    assert.equal(invocation.hasPgpass, true)
    assert.equal(invocation.pgpassExists, true)
    assert.equal(invocation.args.join(' ').includes('s3cret-test-only'), false)
    assert.equal(existsSync(invocation.pgpassPath), false)
    assert.equal(invocation.inheritedHostaddr, null)
    assert.equal(invocation.inheritedService, null)
    assert.equal(invocation.inheritedPassword, null)
    const dump = readFileSync(body.file)
    assert.equal(dump.length > 0, true)
    assert.equal(createHash('sha256').update(dump).digest('hex'), body.checksum)
    const sidecar = readFileSync(`${body.file}.sha256`, 'utf8')
    assert.ok(sidecar.startsWith(`${body.checksum}  `))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup rejects empty dumps and pg_dump failures without false checksums', async () => {
  const emptyDir = tempDir('erp2-backup-empty-')
  try {
    const empty = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: emptyDir, FAKE_PG_DUMP_EMPTY: '1' }))
    assert.notEqual(empty.exit, 0)
    assert.match(empty.stderr, /empty/)
    assert.equal(readdirSync(emptyDir).filter((name) => name.endsWith('.sha256')).length, 0)
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }
  const failDir = tempDir('erp2-backup-fail-')
  try {
    const failed = await runScript('backup-db.mjs', cleanEnv({ DATABASE_URL: SECRET_URL, BACKUP_DIR: failDir, FAKE_PG_DUMP_FAIL: '1' }))
    assert.notEqual(failed.exit, 0)
    assert.match(failed.stderr, /pg_dump failed/)
    assert.equal(readdirSync(failDir).length, 0)
  } finally {
    rmSync(failDir, { recursive: true, force: true })
  }
})

test('restore --help works without configuration', async () => {
  const result = await runScript('restore-drill.mjs', { PATH: process.env.PATH }, ['--help'])
  assert.equal(result.exit, 0)
  assert.ok(result.stdout.includes('BACKUP_FILE'))
})

test('restore refuses bad inputs before touching pg_restore', async () => {
  const dir = tempDir('erp2-restore-')
  const record = path.join(dir, 'pg-restore-args.txt')
  const base = cleanEnv({})
  try {
    const missing = await runScript('restore-drill.mjs', base)
    assert.notEqual(missing.exit, 0)
    const dump = path.join(dir, 'erp2-x.dump')
    writeFileSync(dump, 'FAKE-DUMP-BYTES\n')
    const noSidecar = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump, RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test', FAKE_RECORD: record,
    }))
    assert.notEqual(noSidecar.exit, 0)
    assert.match(noSidecar.stderr, /checksum/i)
    writeFileSync(`${dump}.sha256`, 'not-hex\n')
    const malformed = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump, RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test', FAKE_RECORD: record,
    }))
    assert.notEqual(malformed.exit, 0)
    writeFileSync(`${dump}.sha256`, `${'00'.repeat(32)}  erp2-x.dump\n`)
    const mismatch = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump, RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test', FAKE_RECORD: record,
    }))
    assert.notEqual(mismatch.exit, 0)
    assert.match(mismatch.stderr, /mismatch/)
    const remote = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump, RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@prod.example.com:5432/app_restore_test', FAKE_RECORD: record,
    }))
    assert.notEqual(remote.exit, 0)
    for (const suffix of ['?hostaddr=203.0.113.10', '?host=db.internal', '?dbname=prod', '?service=prod', '#fragment']) {
      const unsafeTarget = await runScript('restore-drill.mjs', cleanEnv({
        BACKUP_FILE: dump, RESTORE_DATABASE_URL: `postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test${suffix}`, FAKE_RECORD: record,
      }))
      assert.notEqual(unsafeTarget.exit, 0)
    }
    const noSuffix = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump, RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app', FAKE_RECORD: record,
    }))
    assert.notEqual(noSuffix.exit, 0)
    assert.equal(existsSync(record), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore succeeds with flags, exact migrations and sanitized output', async () => {
  const dir = tempDir('erp2-restore-ok-')
  const record = path.join(dir, 'pg-restore-args.txt')
  const psqlRecord = path.join(dir, 'psql-record.json')
  try {
    const dump = path.join(dir, 'erp2-ok.dump')
    writeFileSync(dump, 'FAKE-DUMP-BYTES\n')
    const checksum = createHash('sha256').update(readFileSync(dump)).digest('hex')
    writeFileSync(`${dump}.sha256`, `${checksum}  erp2-ok.dump\n`)
    const result = await runScript('restore-drill.mjs', cleanEnv({
      BACKUP_FILE: dump,
      RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test',
      FAKE_RECORD: record,
      FAKE_PSQL_RECORD: psqlRecord,
      FAKE_PSQL_OUTPUT: '001_initial.sql\n002_manager_purchase_read.sql\n003_manager_customers_read.sql\n',
      PGHOSTADDR: '203.0.113.10',
      PGSERVICE: 'prod',
      PGPASSWORD: 'wrong',
    }))
    assert.equal(result.exit, 0)
    const invocation = JSON.parse(readFileSync(record, 'utf8'))
    const recorded = invocation.args.join(' ')
    for (const flag of ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--dbname']) {
      assert.ok(recorded.includes(flag), `missing ${flag}`)
    }
    const body = JSON.parse(result.stdout)
    assert.equal(body.database, 'app_restore_test')
    assert.equal(body.checksum, checksum)
    assert.equal(body.migrations, 3)
    assert.equal(invocation.hasPgpass, true)
    assert.equal(invocation.pgpassExists, true)
    assert.equal(recorded.includes('s3cret-test-only'), false)
    assert.equal(existsSync(invocation.pgpassPath), false)
    assert.equal(invocation.inheritedHostaddr, null)
    assert.equal(invocation.inheritedService, null)
    assert.equal(invocation.inheritedPassword, null)
    const psqlInvocation = JSON.parse(readFileSync(psqlRecord, 'utf8'))
    assert.equal(psqlInvocation.hasPgpass, true)
    assert.equal(psqlInvocation.pgpassExists, true)
    assert.equal(psqlInvocation.inheritedHostaddr, null)
    assert.equal(psqlInvocation.inheritedService, null)
    assert.equal(psqlInvocation.inheritedPassword, null)
    assert.equal(psqlInvocation.args.join(' ').includes('s3cret-test-only'), false)
    assert.equal(existsSync(psqlInvocation.pgpassPath), false)
    assert.equal(result.stdout.includes('s3cret-test-only'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore fails on zero or invalid migration counts', async () => {
  const dir = tempDir('erp2-restore-count-')
  try {
    const dump = path.join(dir, 'erp2-c.dump')
    writeFileSync(dump, 'FAKE-DUMP-BYTES\n')
    const checksum = createHash('sha256').update(readFileSync(dump)).digest('hex')
    writeFileSync(`${dump}.sha256`, `${checksum}  erp2-c.dump\n`)
    for (const count of ['  0', 'nonsense', '001_initial.sql\n002_manager_purchase_read.sql\n003_manager_customers_read.sql\n004_unexpected.sql\n']) {
      const result = await runScript('restore-drill.mjs', cleanEnv({
        BACKUP_FILE: dump,
        RESTORE_DATABASE_URL: 'postgresql://tester:s3cret-test-only@127.0.0.1:5432/app_restore_test',
        FAKE_RECORD: path.join(dir, 'record.txt'),
        FAKE_PSQL_OUTPUT: count,
      }))
      assert.notEqual(result.exit, 0)
      assert.match(result.stderr, /migration/i)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
