import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'

import { hasPermission } from './authorization.js'
import { hashSecret, verifySecret } from './session.js'

export const sessionCookieName = 'erp_session'
export const csrfCookieName = 'erp_csrf'

export type SessionContext = {
  session_id: string
  user_id: string
  username: string
  display_name: string
  role: string
  permissions: string[]
  csrf_hash: string
}

export function isAuthenticationDisabled(request: FastifyRequest): boolean {
  return (request.server as FastifyInstance & { authenticationDisabled?: boolean }).authenticationDisabled === true
}

export async function loadSession(pool: Pool, request: FastifyRequest): Promise<SessionContext | undefined> {
  if (isAuthenticationDisabled(request)) {
    const e2eUserId = process.env['E2E_USER_ID'] || null
    const result = await pool.query<SessionContext>(
      `SELECT 'authentication-disabled' AS session_id, '' AS csrf_hash,
              u.id AS user_id, u.username, u.display_name,
              'administrator' AS role, ARRAY['*']::text[] AS permissions
       FROM users u
       WHERE u.active = true AND ($1::uuid IS NULL OR u.id = $1::uuid)
       ORDER BY (u.username = 'vitinho.local') DESC, u.created_at, u.id
       LIMIT 1`,
      [e2eUserId],
    )
    return result.rows[0]
  }

  const token = request.cookies[sessionCookieName]
  if (!token) return undefined

  const result = await pool.query<SessionContext>(
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

export async function requirePermission(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string,
): Promise<SessionContext | undefined> {
  const session = await loadSession(pool, request)
  if (!session) {
    sendError(reply, request, 401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')
    return undefined
  }
  if (!hasPermission(session.permissions, permission)) {
    sendError(reply, request, 403, 'FORBIDDEN', 'Você não tem permissão para realizar esta ação.')
    return undefined
  }
  return session
}

export function hasValidCsrf(session: SessionContext, request: FastifyRequest): boolean {
  if (isAuthenticationDisabled(request)) return true
  const csrfCookie = request.cookies[csrfCookieName]
  const csrfHeader = request.headers['x-csrf-token']
  return typeof csrfCookie === 'string'
    && typeof csrfHeader === 'string'
    && verifySecret(csrfCookie, session.csrf_hash)
    && verifySecret(csrfHeader, session.csrf_hash)
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply.status(statusCode).send({ code, message, fieldErrors: null, requestId: request.id, ...(details === undefined ? {} : { details }) })
}
