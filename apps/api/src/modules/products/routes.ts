import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)
const productSchema = z.object({
  club: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  variants: z.array(z.object({
    type: z.enum(['Masculina', 'Feminina', 'Infantil']),
    size: z.string().trim().min(1).max(30),
    sku: z.string().trim().min(1).max(120),
    salePrice: money,
    currentCost: money,
    lowStockThreshold: z.number().int().min(0),
  })).min(1).max(100),
})

type ProductRow = {
  id: string
  club: string
  model: string
  description: string | null
  variants: VariantRow[]
}

type VariantRow = {
  id: string
  type: string
  size: string
  sku: string
  salePrice: string
  currentCost: string
  stockQuantity: number
  lowStockThreshold: number
}

export function registerProductRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/products', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'inventory:read')) return

    const result = await pool.query<ProductRow>(productSelect('', 'ORDER BY p.club, p.model'))
    return reply.send({ items: result.rows })
  })

  app.get('/products/:id', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'inventory:read')) return
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Produto inválido.')

    const result = await pool.query<ProductRow>(productSelect('WHERE p.id = $1'), [parsed.data.id])
    const product = result.rows[0]
    if (!product) return sendError(reply, request, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.')
    return reply.send(product)
  })

  app.post('/products', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'products:write')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = productSchema.safeParse(request.body)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do produto.')

    const productId = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO products (id, club, model, description) VALUES ($1, $2, $3, $4)`,
        [productId, parsed.data.club, parsed.data.model, parsed.data.description ?? null],
      )
      for (const variant of parsed.data.variants) {
        await client.query(
          `INSERT INTO product_variants
             (id, product_id, type, size, sku, sale_price, current_cost, low_stock_threshold)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [randomUUID(), productId, variant.type, variant.size, variant.sku, variant.salePrice, variant.currentCost, variant.lowStockThreshold],
        )
      }
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id)
         VALUES ($1, $2, 'product.create', 'product', $3, $4)`,
        [randomUUID(), session.user_id, productId, request.id],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if (isUniqueViolation(error)) {
        return sendError(reply, request, 409, 'PRODUCT_ALREADY_EXISTS', 'Produto ou variante já cadastrado.')
      }
      throw error
    } finally {
      client.release()
    }

    const created = await loadProduct(pool, productId)
    return reply.status(201).send(created)
  })
}

function productSelect(whereClause: string, orderClause = '') {
  return `SELECT p.id, p.club, p.model, p.description,
          coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'type', v.type, 'size', v.size, 'sku', v.sku,
            'salePrice', v.sale_price::text, 'currentCost', v.current_cost::text,
            'stockQuantity', v.stock_quantity, 'lowStockThreshold', v.low_stock_threshold
          ) ORDER BY v.type, v.size) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
   FROM products p
   LEFT JOIN product_variants v ON v.product_id = p.id
   ${whereClause}
   GROUP BY p.id
   ${orderClause}`
}

async function loadProduct(queryable: Pick<Pool, 'query'>, id: string): Promise<ProductRow | undefined> {
  const result = await queryable.query<ProductRow>(productSelect('WHERE p.id = $1'), [id])
  return result.rows[0]
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
