import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hashPassword, verifyPassword } from '../../shared/auth/password.js'
import { createSessionSecrets, hashSecret, verifySecret } from '../../shared/auth/session.js'

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(256),
})
const dummyHash = hashPassword('credencial sintética para comparação constante')
const sessionCookieName = 'erp_session'
const csrfCookieName = 'erp_csrf'
const sessionDurationMs = 8 * 60 * 60 * 1000

type SessionRow = {
  session_id: string
  user_id: string
  username: string
  display_name: string
  role: string
  permissions: string[]
  csrf_hash: string
}

export function registerAuthRoutes(app: FastifyInstance, pool: Pool, options: { secureCookies: boolean }) {
  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise as credenciais informadas.')

    const result = await pool.query<{
      id: string
      username: string
      display_name: string
      password_hash: string
      role: string
      permissions: string[]
    }>(
      `SELECT u.id, u.username, u.display_name, u.password_hash, r.name AS role, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE lower(u.username) = lower($1) AND u.active = true`,
      [parsed.data.username],
    )
    const user = result.rows[0]
    const passwordMatches = await verifyPassword(parsed.data.password, user?.password_hash ?? await dummyHash)

    if (!user || !passwordMatches) {
      await pool.query(
        `INSERT INTO audit_log (id, action, entity_type, request_id, after_data)
         VALUES ($1, 'auth.login_failed', 'session', $2, $3)`,
        [randomUUID(), request.id, JSON.stringify({ usernameHash: hashSecret(parsed.data.username.toLowerCase()) })],
      )
      return sendError(reply, request, 401, 'INVALID_CREDENTIALS', 'Usuário ou senha inválidos.')
    }

    const session = createSessionSecrets()
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + sessionDurationMs)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, user.id, session.tokenHash, session.csrfHash, expiresAt],
      )
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id)
         VALUES ($1, $2, 'auth.login', 'session', $3, $4)`,
        [randomUUID(), user.id, sessionId, request.id],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    setAuthCookies(reply, session.token, session.csrfToken, expiresAt, options.secureCookies)
    return reply.send({
      user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
      permissions: user.permissions,
    })
  })

  app.get('/auth/session', async (request, reply) => {
    const session = await loadSession(pool, request)
    if (!session) return sendError(reply, request, 401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')

    return reply.send({
      user: {
        id: session.user_id,
        username: session.username,
        displayName: session.display_name,
        role: session.role,
      },
      permissions: session.permissions,
    })
  })

  app.post('/auth/logout', async (request, reply) => {
    const session = await loadSession(pool, request)
    if (!session) return sendError(reply, request, 401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')

    const csrfCookie = request.cookies[csrfCookieName]
    const csrfHeader = request.headers['x-csrf-token']
    if (
      typeof csrfCookie !== 'string'
      || typeof csrfHeader !== 'string'
      || !verifySecret(csrfCookie, session.csrf_hash)
      || !verifySecret(csrfHeader, session.csrf_hash)
    ) {
      return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM sessions WHERE id = $1', [session.session_id])
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id)
         VALUES ($1, $2, 'auth.logout', 'session', $3, $4)`,
        [randomUUID(), session.user_id, session.session_id, request.id],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    clearAuthCookies(reply, options.secureCookies)
    return reply.status(204).send()
  })
}

async function loadSession(pool: Pool, request: FastifyRequest): Promise<SessionRow | undefined> {
  const token = request.cookies[sessionCookieName]
  if (!token) return undefined

  const result = await pool.query<SessionRow>(
    `SELECT s.id AS session_id, s.csrf_hash, u.id AS user_id, u.username, u.display_name,
            r.name AS role, r.permissions
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashSecret(token)],
  )
  return result.rows[0]
}

function setAuthCookies(reply: FastifyReply, token: string, csrfToken: string, expires: Date, secure: boolean) {
  const shared = { expires, path: '/', sameSite: 'strict' as const, secure }
  reply.setCookie(sessionCookieName, token, { ...shared, httpOnly: true })
  reply.setCookie(csrfCookieName, csrfToken, { ...shared, httpOnly: false })
}

function clearAuthCookies(reply: FastifyReply, secure: boolean) {
  const shared = { path: '/', sameSite: 'strict' as const, secure }
  reply.clearCookie(sessionCookieName, { ...shared, httpOnly: true })
  reply.clearCookie(csrfCookieName, { ...shared, httpOnly: false })
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
) {
  return reply.status(statusCode).send({ code, message, fieldErrors: null, requestId: request.id })
}
