import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(255).optional(),
}).strict()
const customersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
})
const idempotencyAction = 'customers.create'

type IdempotencyRow = { request_hash: string; response_status: number | null; response_body: unknown }

export function registerCustomerRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/customers', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'customers:read')) return
    const parsed = customersQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Busca de clientes inválida.')

    const params: unknown[] = []
    const push = (value: unknown) => { params.push(value); return `$${params.length}` }
    const where = parsed.data.search
      ? `WHERE active = true AND (name ILIKE ${push(`%${parsed.data.search}%`)} OR contact ILIKE ${push(`%${parsed.data.search}%`)})`
      : 'WHERE active = true'
    const result = await pool.query<{ id: string; name: string; contact: string | null; total: string }>(
      `SELECT id, name, contact, count(*) OVER()::text AS total
       FROM customers ${where}
       ORDER BY name ASC, id ASC
       LIMIT $${params.length + 1}`,
      [...params, parsed.data.limit],
    )
    const total = Number(result.rows[0]?.total ?? 0)
    return reply.send({
      items: result.rows.map((row) => {
        const { total: _total, ...customer } = row
        void _total
        return customer
      }),
      total,
    })
  })

  app.post('/customers', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'customers:create')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = customerSchema.safeParse(request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!parsed.success || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do cliente e a chave de idempotência.')
    }

    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const idempotencyScope = `${idempotencyAction}:${session.user_id}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (id, scope, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [randomUUID(), idempotencyScope, idempotencyKey, requestHash],
      )
      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE`,
          [idempotencyScope, idempotencyKey],
        )
        const prior = existing.rows[0]
        if (!prior || prior.request_hash !== requestHash) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
        }
        if (prior.response_status && prior.response_body !== null) {
          await client.query('COMMIT')
          return reply.status(prior.response_status).send(prior.response_body)
        }
      }

      const customerId = randomUUID()
      await client.query(
        `INSERT INTO customers (id, name, contact) VALUES ($1, $2, $3)`,
        [customerId, parsed.data.name, parsed.data.contact ?? null],
      )
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'customer.create', 'customer', $3, $4, $5)`,
        [randomUUID(), session.user_id, customerId, request.id, JSON.stringify({ name: parsed.data.name })],
      )
      const response = { id: customerId, name: parsed.data.name, contact: parsed.data.contact ?? null }
      await client.query(
        `UPDATE idempotency_keys SET response_status = 201, response_body = $3, completed_at = now()
         WHERE scope = $1 AND key = $2`,
        [idempotencyScope, idempotencyKey, JSON.stringify(response)],
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
}
