import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasPermission } from '../../shared/auth/authorization.js'
import { csrfCookieName, hasValidCsrf, isAuthenticationDisabled, requirePermission, sendError, sessionCookieName } from '../../shared/auth/http.js'
import { hashPassword } from '../../shared/auth/password.js'
import { hashSecret, verifySecret } from '../../shared/auth/session.js'

const maxDirectoryPage = 1_000_000
const fixedRoles = ['operator', 'inventory', 'manager', 'administrator'] as const

const usersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().max(maxDirectoryPage).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}).strict()
const userCreateSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(120),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(fixedRoles),
  password: z.string().min(12).max(256),
}).strict()
const userUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(fixedRoles).optional(),
  active: z.boolean().optional(),
}).strict().refine(
  (value) => value.displayName !== undefined || value.role !== undefined || value.active !== undefined,
  { message: 'Informe ao menos um campo.' },
)
const userIdSchema = z.object({ id: z.string().uuid() })

type UserDirectoryRow = {
  id: string
  username: string
  displayName: string
  role: string
  active: boolean
  createdAt: string
}

type SafeUser = {
  id: string
  username: string
  displayName: string
  role: string
  active: boolean
  createdAt: string
}

function toSafeUser(row: { id: string; username: string; displayName: string; role: string; active: boolean; createdAt: string }): SafeUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

type WriteSession = { userId: string; permissions: string[]; csrfHash: string }

async function loadWriteSession(db: Pick<Pool, 'query'>, request: FastifyRequest): Promise<WriteSession | undefined> {
  if (isAuthenticationDisabled(request)) {
    const result = await db.query<{ user_id: string }>(
      `SELECT id AS user_id FROM users WHERE active = true
       ORDER BY (username = 'vitinho.local') DESC, created_at, id LIMIT 1`,
    )
    const row = result.rows[0]
    return row ? { userId: row.user_id, permissions: ['*'], csrfHash: '' } : undefined
  }
  const token = request.cookies[sessionCookieName]
  if (!token) return undefined
  const result = await db.query<{ user_id: string; permissions: string[]; csrf_hash: string }>(
    `SELECT u.id AS user_id, r.permissions, s.csrf_hash AS csrf_hash
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashSecret(token)],
  )
  const row = result.rows[0]
  if (!row) return undefined
  return { userId: row.user_id, permissions: row.permissions, csrfHash: row.csrf_hash }
}

function hasValidWriteCsrf(csrfHash: string, request: FastifyRequest): boolean {
  if (isAuthenticationDisabled(request)) return true
  const csrfCookie = request.cookies[csrfCookieName]
  const csrfHeader = request.headers['x-csrf-token']
  return typeof csrfCookie === 'string'
    && typeof csrfHeader === 'string'
    && verifySecret(csrfCookie, csrfHash)
    && verifySecret(csrfHeader, csrfHash)
}

export function registerUserRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/users', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'users:manage')) return
    const parsed = usersQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Filtros de usuário inválidos.')

    const conditions: string[] = []
    const params: unknown[] = []
    if (parsed.data.search) {
      const term = `%${parsed.data.search}%`
      params.push(term, term)
      conditions.push(`(u.username ILIKE $${params.length - 1} OR u.display_name ILIKE $${params.length})`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const counted = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM users u JOIN roles r ON r.id = u.role_id ${where}`,
      params,
    )
    const total = Number(counted.rows[0]?.total ?? 0)
    const offset = (parsed.data.page - 1) * parsed.data.limit
    const result = await pool.query<UserDirectoryRow>(
      `SELECT u.id, u.username, u.display_name AS "displayName", r.name AS role,
              u.active, u.created_at::text AS "createdAt"
       FROM users u JOIN roles r ON r.id = u.role_id
       ${where}
       ORDER BY lower(u.display_name), lower(u.username), u.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parsed.data.limit, offset],
    )
    return reply.send({ items: result.rows, total, page: parsed.data.page, limit: parsed.data.limit })
  })

  app.post('/users', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'users:manage')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = userCreateSchema.safeParse(request.body)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do usuário.')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
      const writer = await loadWriteSession(client, request)
      if (!writer) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')
      }
      if (!hasPermission(writer.permissions, 'users:manage')) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 403, 'FORBIDDEN', 'Você não tem permissão para realizar esta ação.')
      }
      if (!hasValidWriteCsrf(writer.csrfHash, request)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
      }
      const role = await client.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [parsed.data.role])
      if (!role.rows[0]) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Perfil inválido.')
      }
      const userId = randomUUID()
      let created: UserDirectoryRow
      try {
        const inserted = await client.query<UserDirectoryRow>(
          `INSERT INTO users (id, username, display_name, password_hash, role_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, username, display_name AS "displayName", $6 AS role, active, created_at::text AS "createdAt"`,
          [userId, parsed.data.username, parsed.data.displayName, await hashPassword(parsed.data.password), role.rows[0]!.id, parsed.data.role],
        )
        created = inserted.rows[0]!
      } catch (error) {
        await client.query('ROLLBACK')
        if (isUniqueViolation(error)) return sendError(reply, request, 409, 'USERNAME_TAKEN', 'Nome de usuário já cadastrado.')
        throw error
      }
      const response = toSafeUser(created)
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'user.create', 'user', $3, $4, $5)`,
        [randomUUID(), writer.userId, userId, request.id, JSON.stringify(response)],
      )
      await client.query('COMMIT')
      return reply.status(201).send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.patch('/users/:id', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'users:manage')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = userIdSchema.safeParse(request.params)
    const parsed = userUpdateSchema.safeParse(request.body)
    if (!params.success || !parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do usuário.')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
      const writer = await loadWriteSession(client, request)
      if (!writer) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')
      }
      if (!hasPermission(writer.permissions, 'users:manage')) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 403, 'FORBIDDEN', 'Você não tem permissão para realizar esta ação.')
      }
      if (!hasValidWriteCsrf(writer.csrfHash, request)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
      }
      const current = await client.query<UserDirectoryRow & { roleId: string }>(
        `SELECT u.id, u.username, u.display_name AS "displayName", r.name AS role,
                u.active, u.created_at::text AS "createdAt", u.role_id AS "roleId"
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 FOR UPDATE`,
        [params.data.id],
      )
      const target = current.rows[0]
      if (!target) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'USER_NOT_FOUND', 'Usuário não encontrado.')
      }
      const nextRole = parsed.data.role ?? target.role
      const nextActive = parsed.data.active ?? target.active
      if (target.id === writer.userId && (nextRole !== target.role || !nextActive)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'SELF_PROTECTION', 'A sessão atual não pode rebaixar ou desativar o próprio usuário.')
      }
      if ((target.role === 'administrator' && nextRole !== 'administrator') || (target.role === 'administrator' && !nextActive)) {
        const others = await client.query<{ remaining: string }>(
          `SELECT count(*)::text AS remaining FROM users u JOIN roles r ON r.id = u.role_id
           WHERE r.name = 'administrator' AND u.active = true AND u.id <> $1`,
          [target.id],
        )
        if (others.rows[0]!.remaining === '0') {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'LAST_ADMIN', 'A operação removeria o último administrador ativo.')
        }
      }
      let roleId = target.roleId
      if (parsed.data.role && parsed.data.role !== target.role) {
        const role = await client.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [parsed.data.role])
        if (!role.rows[0]) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Perfil inválido.')
        }
        roleId = role.rows[0]!.id
      }
      const nextDisplayName = parsed.data.displayName ?? target.displayName
      const updated = await client.query<UserDirectoryRow>(
        `UPDATE users SET display_name = $2, role_id = $3, active = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, username, display_name AS "displayName", $5 AS role, active, created_at::text AS "createdAt"`,
        [target.id, nextDisplayName, roleId, nextActive, nextRole],
      )
      const response = toSafeUser(updated.rows[0]!)
      const before = toSafeUser(target)
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, before_data, after_data)
         VALUES ($1, $2, 'user.update', 'user', $3, $4, $5, $6)`,
        [randomUUID(), writer.userId, target.id, request.id, JSON.stringify(before), JSON.stringify(response)],
      )
      if (!nextActive) {
        await client.query('DELETE FROM sessions WHERE user_id = $1', [target.id])
      }
      await client.query('COMMIT')
      return reply.send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
}
