/* eslint-disable no-undef */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const RESTORE_DB_SUFFIX = '_restore_test'
export const RESTORE_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']
export const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
export const MIGRATION_FILENAME_PATTERN = /^\d+_.+\.sql$/
export const LIBPQ_DESTINATION_ENV = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSYSCONFDIR',
  'PGPASSFILE',
  'PGPASSWORD',
]
const SAFE_CONNECTION_PARAMETERS = new Set([
  'application_name',
  'channel_binding',
  'connect_timeout',
  'gssdelegation',
  'gssencmode',
  'krbsrvname',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'load_balance_hosts',
  'options',
  'sslcert',
  'sslcrl',
  'sslcrldir',
  'sslkey',
  'sslmode',
  'sslrootcert',
  'target_session_attrs',
  'tcp_user_timeout',
])

export function toolInvocation(defaultBinary, testBinary, args) {
  if (process.env.NODE_ENV === 'test' && typeof testBinary === 'string' && testBinary !== '') {
    return { command: process.execPath, args: [testBinary, ...args] }
  }
  return { command: defaultBinary, args }
}

export function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`)
  }
  return path.resolve(value)
}

export async function assertSafeBackupDir(resolvedDir) {
  return canonicalSafeBackupDir(resolvedDir)
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function realpathNearestExisting(target) {
  const suffix = []
  let current = target
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

export async function canonicalSafeBackupDir(resolvedDir) {
  const canonical = await realpathNearestExisting(resolvedDir)
  const root = path.parse(canonical).root
  if (canonical === root) throw new Error('Refusing an obviously unsafe backup destination.')
  let cursor = canonical
  for (;;) {
    if (await pathExists(path.join(cursor, 'PG_VERSION'))) {
      throw new Error('Refusing a backup destination inside a PostgreSQL data directory.')
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return canonical
    cursor = parent
  }
}

export async function uniqueDumpPath(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const candidate = path.join(dir, `erp2-${timestamp}-${randomBytes(6).toString('hex')}.dump`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('Could not allocate a unique backup name.')
}

export async function writeChecksumAtomic(file, checksum) {
  const sidecar = `${file}.sha256`
  const staging = `${sidecar}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(staging, `${checksum}  ${path.basename(file)}\n`)
  await rename(staging, sidecar)
}

export function parseChecksumSidecar(text) {
  const token = String(text).trim().split(/\s+/)[0] ?? ''
  if (!CHECKSUM_PATTERN.test(token)) throw new Error('Invalid backup checksum file.')
  return token
}

export function parseConnectionParts(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid database URL.')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Invalid database URL.')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  let username
  let password
  try {
    username = decodeURIComponent(parsed.username)
    password = decodeURIComponent(parsed.password)
  } catch {
    throw new Error('Invalid database URL.')
  }
  const segments = parsed.pathname.split('/').filter((part) => part !== '')
  if (segments.length !== 1) throw new Error('Invalid database URL.')
  let database
  try {
    database = decodeURIComponent(segments[0])
  } catch {
    throw new Error('Invalid database URL.')
  }
  if (database === '') throw new Error('Invalid database URL.')
  return {
    username,
    password,
    host,
    port: parsed.port,
    database,
    search: parsed.search,
    hash: parsed.hash,
  }
}

export function sanitizedConnectionUri(parts) {
  const host = parts.host.includes(':') ? `[${parts.host}]` : parts.host
  const credentials = parts.username === '' ? '' : `${encodeURIComponent(parts.username)}@`
  const port = parts.port === '' ? '' : `:${parts.port}`
  return `postgresql://${credentials}${host}${port}/${encodeURIComponent(parts.database)}${parts.search}`
}

export function sanitizeConnectionSearch(search) {
  const params = new URLSearchParams(search)
  for (const key of params.keys()) {
    if (!SAFE_CONNECTION_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(`Unsupported PostgreSQL connection parameter: ${key}.`)
    }
  }
  const normalized = params.toString()
  return normalized === '' ? '' : `?${normalized}`
}

export function parseRestoreTarget(url) {
  let parts
  try {
    parts = parseConnectionParts(url)
  } catch {
    throw new Error('Invalid restore database URL.')
  }
  if (parts.search !== '') throw new Error('Restore drill refuses connection query parameters.')
  if (parts.hash !== '') throw new Error('Restore drill refuses connection fragments.')
  if (!RESTORE_ALLOWED_HOSTS.includes(parts.host)) {
    throw new Error('Restore drill refuses non-local database hosts.')
  }
  if (!parts.database.endsWith(RESTORE_DB_SUFFIX)) {
    throw new Error('Restore drill refuses databases not ending in _restore_test.')
  }
  const sanitizedUri = sanitizedConnectionUri({ ...parts, search: '' })
  return { databaseName: parts.database, host: parts.host, port: parts.port, username: parts.username, password: parts.password, sanitizedUri }
}

export function escapePgpassField(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

export async function writePgpassFile({ host, port, database, username, password }) {
  const entry = `${escapePgpassField(host)}:${escapePgpassField(port === '' ? '5432' : port)}:${escapePgpassField(database)}:${escapePgpassField(username)}:${escapePgpassField(password)}\n`
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const file = path.join(tmpdir(), `erp2-pgpass-${randomBytes(8).toString('hex')}`)
    try {
      await writeFile(file, entry, { mode: 0o600, flag: 'wx' })
      try {
        await chmod(file, 0o600)
      } catch (error) {
        await rm(file, { force: true }).catch(() => {})
        throw error
      }
      return file
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Could not allocate a unique PGPASSFILE.')
}

export async function removePgpassFile(file) {
  await rm(file, { force: true })
}

export function registerTemporaryFileCleanup(file) {
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await removePgpassFile(file).catch(() => {})
  }
  const onSignal = (signal) => {
    void cleanup().finally(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return async () => {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await cleanup()
  }
}

export function childEnvironment(baseEnv, pgpass = null) {
  const env = { ...baseEnv }
  for (const name of Object.keys(env)) {
    if (LIBPQ_DESTINATION_ENV.includes(name.toUpperCase())) delete env[name]
  }
  if (pgpass) env.PGPASSFILE = pgpass
  return env
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => {
      try {
        resolve(hash.digest('hex'))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function listMigrationFilenames(directory) {
  const entries = await readdir(directory)
  return entries.filter((name) => MIGRATION_FILENAME_PATTERN.test(name)).sort()
}

export function parseMigrationVersions(output) {
  const versions = String(output).split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (versions.length === 0) throw new Error('Restore drill could not verify migrations.')
  return versions
}

export function assertMigrationSet(actual, expected) {
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const duplicate = new Set(actual).size !== actual.length
  if (missing.length > 0 || unexpected.length > 0 || duplicate || actual.length !== expected.length) {
    throw new Error('Restore drill found an unexpected migration set.')
  }
}
