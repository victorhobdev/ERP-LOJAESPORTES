import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

type DirectoryItem = {
  id: string
  username: string
  displayName: string
  role: string
  active: boolean
  createdAt: string
}
type DirectoryBody = { items: DirectoryItem[]; total: number; page: number; limit: number }

describe('read-only user directory', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const adminId = randomUUID()
  const adminToken = randomUUID()
  const operatorId = randomUUID()
  const operatorToken = randomUUID()
  const managerId = randomUUID()
  const managerToken = randomUUID()
  const csrfToken = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  function authCookie(token: string): string {
    return `erp_session=${encodeURIComponent(token)}; erp_csrf=${encodeURIComponent(csrfToken)}`
  }

  function writeHeaders(token: string): Record<string, string> {
    return { cookie: authCookie(token), 'x-csrf-token': csrfToken }
  }

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') throw new Error('Integration tests refuse to run outside erp2_test.')
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await seed()
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('requires authentication and users:manage without leaking secrets', async () => {
    const anon = await app.inject({ method: 'GET', url: '/users?page=1&limit=20' })
    expect(anon.statusCode).toBe(401)
    expect(anon.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
    for (const token of [operatorToken, managerToken]) {
      const forbidden = await app.inject({
        method: 'GET',
        url: '/users?page=1&limit=20',
        headers: { cookie: `erp_session=${encodeURIComponent(token)}` },
      })
      expect(forbidden.statusCode).toBe(403)
      expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' })
      expect(JSON.stringify(forbidden.json())).not.toContain('password_hash')
    }
  })

  it('lists users with safe fields, deterministic order, search and pagination', async () => {
    const session = { cookie: `erp_session=${encodeURIComponent(adminToken)}` }
    const list = await app.inject({ method: 'GET', url: '/users?page=1&limit=20', headers: session })
    expect(list.statusCode).toBe(200)
    const body = list.json() as unknown as DirectoryBody
    expect(body.total).toBe(5)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(20)
    expect(body.items.map((item) => item.displayName)).toEqual([
      'Administradora Sintética',
      'Caixa Sintético',
      'Gestora Sintética',
      'Zebra Sintética',
      'Zulu Sintético',
    ])
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['active', 'createdAt', 'displayName', 'id', 'role', 'username'])
    }
    expect(JSON.stringify(body)).not.toContain('password_hash')
    expect(JSON.stringify(body)).not.toContain('permissions')
    expect(JSON.stringify(body)).not.toContain('token_hash')

    const search = await app.inject({ method: 'GET', url: '/users?search=ZEBRA&page=1&limit=20', headers: session })
    expect((search.json() as unknown as DirectoryBody).items.map((item) => item.username)).toEqual(['zebra.sintetica'])

    const second = await app.inject({ method: 'GET', url: '/users?page=2&limit=2', headers: session })
    const secondBody = second.json() as unknown as DirectoryBody
    expect(secondBody).toMatchObject({ total: 5, page: 2, limit: 2 })
    expect(secondBody.items.map((item) => item.displayName)).toEqual(['Gestora Sintética', 'Zebra Sintética'])
  })

  it('validates query and performs no writes', async () => {
    const session = { cookie: `erp_session=${encodeURIComponent(adminToken)}` }
    for (const url of ['/users?page=0&limit=20', '/users?page=1&limit=101', '/users?page=abc&limit=20', '/users?page=1000001&limit=20', '/users?page=9007199254740993&limit=20', '/users?unknown=1&limit=20']) {
      const invalid = await app.inject({ method: 'GET', url, headers: session })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    const before = await pool.query<{ users: string; audits: string }>(
      `SELECT (SELECT count(*) FROM users)::text AS users, (SELECT count(*) FROM audit_log)::text AS audits`,
    )
    await app.inject({ method: 'GET', url: '/users?search=sintet&page=1&limit=20', headers: session })
    const after = await pool.query<{ users: string; audits: string }>(
      `SELECT (SELECT count(*) FROM users)::text AS users, (SELECT count(*) FROM audit_log)::text AS audits`,
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  async function seed() {
    const roles = {
      operator: '00000000-0000-4000-8000-000000000001',
      manager: '00000000-0000-4000-8000-000000000003',
      administrator: '00000000-0000-4000-8000-000000000004',
    }
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id) VALUES
        ($1, 'admin.sintetica', 'Administradora Sintética', 'unused', $2),
        ($3, 'caixa.sintetico', 'Caixa Sintético', 'unused', $4),
        ($5, 'gestora.sintetica', 'Gestora Sintética', 'unused', $6),
        ($7, 'zebra.sintetica', 'Zebra Sintética', 'unused', $4),
        ($8, 'zulu.sintetico', 'Zulu Sintético', 'unused', $4)`,
      [adminId, roles.administrator, operatorId, roles.operator, managerId, roles.manager, randomUUID(), randomUUID()],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES
        ($1, $2, $3, $4, now() + interval '1 hour'),
        ($5, $6, $7, $4, now() + interval '1 hour'),
        ($8, $9, $10, $4, now() + interval '1 hour')`,
      [
        randomUUID(), adminId, hashSecret(adminToken), hashSecret(csrfToken),
        randomUUID(), operatorId, hashSecret(operatorToken),
        randomUUID(), managerId, hashSecret(managerToken),
      ],
    )
  }

  it('rejects writes without auth, permission or CSRF with no effects', async () => {
    const payload = { username: 'novo.sintetico', displayName: 'Novo Sintético', role: 'operator', password: 'Senha-Sintetica-12' }
    const anon = await app.inject({ method: 'POST', url: '/users', payload })
    expect(anon.statusCode).toBe(401)
    const forbidden = await app.inject({ method: 'POST', url: '/users', payload, headers: writeHeaders(operatorToken) })
    expect(forbidden.statusCode).toBe(403)
    const noCsrf = await app.inject({
      method: 'POST', url: '/users', payload,
      headers: { cookie: `erp_session=${encodeURIComponent(adminToken)}` },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json()).toMatchObject({ code: 'INVALID_CSRF' })
    const badCsrf = await app.inject({
      method: 'POST', url: '/users', payload,
      headers: { cookie: authCookie(adminToken), 'x-csrf-token': 'wrong' },
    })
    expect(badCsrf.statusCode).toBe(403)
    const state = await pool.query<{ users: string; audits: string }>(
      `SELECT (SELECT count(*) FROM users)::text AS users, (SELECT count(*) FROM audit_log)::text AS audits`,
    )
    expect(state.rows[0]).toEqual({ users: '5', audits: '0' })
  })

  it('creates users with safe response, persisted hash and audit', async () => {
    const create = await app.inject({
      method: 'POST', url: '/users',
      payload: { username: '  Novo.Sintetico ', displayName: 'Novo Sintético', role: 'operator', password: 'Senha-Sintetica-12' },
      headers: writeHeaders(adminToken),
    })
    expect(create.statusCode).toBe(201)
    const body = create.json() as unknown as DirectoryItem
    expect(Object.keys(body).sort()).toEqual(['active', 'createdAt', 'displayName', 'id', 'role', 'username'])
    expect(body).toMatchObject({ username: 'novo.sintetico', displayName: 'Novo Sintético', role: 'operator', active: true })
    expect(JSON.stringify(body)).not.toContain('hash')
    const stored = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [body.id])
    expect(stored.rows[0]!.password_hash).toMatch(/^scrypt\$/)
    expect(stored.rows[0]!.password_hash).not.toContain('Senha-Sintetica-12')
    const audit = await pool.query<{ action: string; after_data: unknown }>(
      `SELECT action, after_data FROM audit_log WHERE entity_id = $1::text`,
      [body.id],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.action).toBe('user.create')
    expect(JSON.stringify(audit.rows[0]!.after_data)).not.toContain('hash')
  })

  it('rejects duplicate usernames and invalid bodies', async () => {
    const duplicate = await app.inject({
      method: 'POST', url: '/users',
      payload: { username: 'CAIXA.sintetico', displayName: 'Outro', role: 'operator', password: 'Senha-Sintetica-12' },
      headers: writeHeaders(adminToken),
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ code: 'USERNAME_TAKEN' })
    for (const payload of [
      { username: 'curto.sintetico', displayName: 'Curto', role: 'operator', password: 'curta' },
      { username: 'sem.papel', displayName: 'Sem Papel', role: 'superuser', password: 'Senha-Sintetica-12' },
      { username: 'campo.extra', displayName: 'Extra', role: 'operator', password: 'Senha-Sintetica-12', active: false },
      { displayName: 'Sem Login', role: 'operator', password: 'Senha-Sintetica-12' },
    ]) {
      const invalid = await app.inject({ method: 'POST', url: '/users', payload, headers: writeHeaders(adminToken) })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    const missing = await app.inject({
      method: 'PATCH', url: `/users/${randomUUID()}`, payload: { displayName: 'Fantasma' }, headers: writeHeaders(adminToken),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'USER_NOT_FOUND' })
  })

  it('updates display, role and active with audit and session invalidation', async () => {
    const targetToken = randomUUID()
    const targetId = randomUUID()
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'alvo.sintetico', 'Alvo Sintético', 'unused', '00000000-0000-4000-8000-000000000001')`,
      [targetId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), targetId, hashSecret(targetToken), hashSecret(csrfToken)],
    )
    const update = await app.inject({
      method: 'PATCH', url: `/users/${targetId}`,
      payload: { displayName: 'Alvo Renomeado', role: 'manager', active: false },
      headers: writeHeaders(adminToken),
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({ id: targetId, displayName: 'Alvo Renomeado', role: 'manager', active: false })
    expect(Object.keys(update.json() as object).sort()).toEqual(['active', 'createdAt', 'displayName', 'id', 'role', 'username'])
    const audit = await pool.query<{ action: string; before_data: unknown; after_data: unknown }>(
      `SELECT action, before_data, after_data FROM audit_log WHERE entity_id = $1::text`,
      [targetId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.action).toBe('user.update')
    expect(audit.rows[0]!.before_data).toMatchObject({ displayName: 'Alvo Sintético', role: 'operator', active: true })
    expect(audit.rows[0]!.after_data).toMatchObject({ displayName: 'Alvo Renomeado', role: 'manager', active: false })
    expect(JSON.stringify(audit.rows)).not.toContain('hash')
    const sessions = await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [targetId])
    expect(sessions.rowCount).toBe(0)
  })

  it('denies a mutation whose session was revoked while serialized', async () => {
    const created = await app.inject({
      method: 'POST', url: '/users',
      payload: { username: 'corrida.admin', displayName: 'Corrida Admin', role: 'administrator', password: 'Senha-Sintetica-12' },
      headers: writeHeaders(adminToken),
    })
    expect(created.statusCode).toBe(201)
    const racerId = (created.json() as unknown as DirectoryItem).id
    const racerToken = randomUUID()
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), racerId, hashSecret(racerToken), hashSecret(csrfToken)],
    )
    const locker = await pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
      const pending = app.inject({
        method: 'POST', url: '/users',
        payload: { username: 'corrida.alvo', displayName: 'Corrida Alvo', role: 'operator', password: 'Senha-Sintetica-12' },
        headers: writeHeaders(racerToken),
      })
      let blocked = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await pool.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting FROM pg_stat_activity
           WHERE datname = 'erp2_test' AND wait_event_type = 'Lock' AND query ILIKE '%LOCK TABLE users%'`,
        )
        if (waiting.rows[0]!.waiting !== '0') {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(blocked).toBe(true)
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [racerId])
      await locker.query('ROLLBACK')
      const denied = await pending
      expect(denied.statusCode).toBe(401)
      expect(denied.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
      const state = await pool.query<{ users: string; target: string; audits: string }>(
        `SELECT (SELECT count(*) FROM users WHERE username = 'corrida.alvo')::text AS users,
                (SELECT count(*) FROM users WHERE id = $1)::text AS target,
                (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'user.update')::text AS audits`,
        [racerId],
      )
      expect(state.rows[0]).toEqual({ users: '0', target: '1', audits: '0' })
    } finally {
      locker.release()
    }
    const cleanup = await app.inject({
      method: 'PATCH', url: `/users/${racerId}`,
      payload: { active: false }, headers: writeHeaders(adminToken),
    })
    expect(cleanup.statusCode).toBe(200)
  }, 120_000)

  it('protects the current session and the last active administrator', async () => {
    const selfDemote = await app.inject({
      method: 'PATCH', url: `/users/${adminId}`,
      payload: { role: 'operator' }, headers: writeHeaders(adminToken),
    })
    expect(selfDemote.statusCode).toBe(409)
    expect(selfDemote.json()).toMatchObject({ code: 'SELF_PROTECTION' })
    const selfDeactivate = await app.inject({
      method: 'PATCH', url: `/users/${adminId}`,
      payload: { active: false }, headers: writeHeaders(adminToken),
    })
    expect(selfDeactivate.statusCode).toBe(409)
    expect(selfDeactivate.json()).toMatchObject({ code: 'SELF_PROTECTION' })
    const secondAdmin = await app.inject({
      method: 'POST', url: '/users',
      payload: { username: 'segundo.admin', displayName: 'Segundo Admin', role: 'administrator', password: 'Senha-Sintetica-12' },
      headers: writeHeaders(adminToken),
    })
    expect(secondAdmin.statusCode).toBe(201)
    const secondId = (secondAdmin.json() as unknown as DirectoryItem).id
    const demoteOther = await app.inject({
      method: 'PATCH', url: `/users/${secondId}`,
      payload: { role: 'manager' }, headers: writeHeaders(adminToken),
    })
    expect(demoteOther.statusCode).toBe(200)
    const otherAdmin = await app.inject({
      method: 'POST', url: '/users',
      payload: { username: 'terceiro.admin', displayName: 'Terceiro Admin', role: 'administrator', password: 'Senha-Sintetica-12' },
      headers: writeHeaders(adminToken),
    })
    expect(otherAdmin.statusCode).toBe(201)
    const thirdId = (otherAdmin.json() as unknown as DirectoryItem).id
    const thirdToken = randomUUID()
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), thirdId, hashSecret(thirdToken), hashSecret(csrfToken)],
    )
    const [first, second] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/users/${thirdId}`, payload: { role: 'manager' }, headers: writeHeaders(adminToken) }),
      app.inject({ method: 'PATCH', url: `/users/${adminId}`, payload: { role: 'manager' }, headers: writeHeaders(thirdToken) }),
    ])
    expect([first!.statusCode, second!.statusCode].sort()).toEqual([200, 403])
    const blocked = [first!, second!].find((response) => response.statusCode === 403)!
    expect(blocked.json()).toMatchObject({ code: 'FORBIDDEN' })
    expect(JSON.stringify(blocked.json())).not.toContain('hash')
    const remaining = await pool.query<{ admins: string }>(
      `SELECT count(*)::text AS admins FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'administrator' AND u.active = true`,
    )
    expect(remaining.rows[0]!.admins).toBe('1')
  })
})
