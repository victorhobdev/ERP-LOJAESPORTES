import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasPermission } from '../../shared/auth/authorization.js'
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

const productPatchSchema = z.object({
  club: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  variants: z.array(z.object({
    id: z.string().uuid(),
    salePrice: money.optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
  }).strict()).min(1).max(100).optional(),
}).strict().refine((value) => value.club !== undefined || value.model !== undefined || value.description !== undefined || value.variants !== undefined, {
  message: 'Informe ao menos um campo.',
})
const productsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  club: z.string().trim().max(120).optional(),
  type: z.enum(['Masculina', 'Feminina', 'Infantil']).optional(),
  size: z.string().trim().max(30).optional(),
  availability: z.enum(['all', 'in_stock', 'out_of_stock', 'low']).default('all'),
  image: z.enum(['all', 'with', 'without']).default('all'),
  sort: z.enum(['club', 'model', 'stock', 'movement']).default('club'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
})

type ProductRow = {
  id: string
  club: string
  model: string
  description: string | null
  totalStock: number
  lastMovementAt: string | null
  hasImage: boolean
  mediaId: string | null
  variants: VariantRow[]
}

type PublicVariantRow = Omit<VariantRow, 'currentCost'> & { currentCost?: string }

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

function withoutUnitCost(row: ProductRow): Omit<ProductRow, 'variants'> & { variants: PublicVariantRow[] } {
  return {
    ...row,
    variants: row.variants.map((variant) => {
      const { currentCost: _removed, ...rest } = variant
      void _removed
      return rest
    }),
  }
}

export function registerProductRoutes(app: FastifyInstance, pool: Pool) {
  // GET /catalog é o contrato canônico do catálogo e reutiliza exatamente a
  // mesma listagem, autorização (inventory:read), filtros, paginação, mediaId
  // e redação de custo de GET /products — sem duplicação de consulta.
  const listProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requirePermission(pool, request, reply, 'inventory:read')
    if (!session) return
    const parsed = productsQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Filtros de produto inválidos.')
    const { where, params, variantCondition } = productFilters(parsed.data)
    const counted = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM products p WHERE ${where}`,
      params,
    )
    const total = Number(counted.rows[0]?.total ?? 0)
    const offset = (parsed.data.page - 1) * parsed.data.limit
    const result = await pool.query<ProductRow>(
      `${productPageQuery(where, variantCondition, productOrderBy(parsed.data.sort, parsed.data.order))}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parsed.data.limit, offset],
    )
    const includeCost = hasPermission(session.permissions, 'products:write')
    return reply.send({
      items: result.rows.map((row) => includeCost ? row : withoutUnitCost(row)),
      total, page: parsed.data.page, limit: parsed.data.limit,
    })
  }

  app.get('/products', listProducts)
  app.get('/catalog', listProducts)

  app.get('/products/:id', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'inventory:read')
    if (!session) return
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Produto inválido.')

    const product = await loadProduct(pool, parsed.data.id)
    if (!product) return sendError(reply, request, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.')
    if (hasPermission(session.permissions, 'products:write')) return reply.send(product)
    return reply.send(withoutUnitCost(product))
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
  app.patch('/products/:id', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'products:write')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    const parsed = productPatchSchema.safeParse(request.body)
    if (!params.success || !parsed.success) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do produto.')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await loadProduct(client, params.data.id)
      if (!before) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.')
      }
      if (parsed.data.variants) {
        const owned = new Set(before.variants.map((variant) => variant.id))
        if (!parsed.data.variants.every((variant) => owned.has(variant.id))) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Uma das variações não pertence ao produto.')
        }
      }

      await client.query(
        `UPDATE products
         SET club = coalesce($2, club), model = coalesce($3, model), description = coalesce($4, description), updated_at = now()
         WHERE id = $1`,
        [params.data.id, parsed.data.club ?? null, parsed.data.model ?? null, parsed.data.description ?? null],
      )
      for (const variant of parsed.data.variants ?? []) {
        await client.query(
          `UPDATE product_variants
           SET sale_price = coalesce($2, sale_price), low_stock_threshold = coalesce($3, low_stock_threshold), updated_at = now()
           WHERE id = $1`,
          [variant.id, variant.salePrice ?? null, variant.lowStockThreshold ?? null],
        )
      }
      const after = await loadProduct(client, params.data.id)
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, before_data, after_data)
         VALUES ($1, $2, 'product.update', 'product', $3, $4, $5, $6)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify(before), JSON.stringify(after)],
      )
      await client.query('COMMIT')
      return reply.send(after!)
    } catch (error) {
      await client.query('ROLLBACK')
      if (isUniqueViolation(error)) {
        return sendError(reply, request, 409, 'PRODUCT_ALREADY_EXISTS', 'Produto ou variante já cadastrado.')
      }
      throw error
    } finally {
      client.release()
    }
  })
}

type ProductFilters = z.infer<typeof productsQuerySchema>

function productFilters(query: ProductFilters): { where: string; params: unknown[]; variantCondition: string } {
  const conditions: string[] = []
  const params: unknown[] = []
  const push = (value: unknown) => { params.push(value); return `$${params.length}` }

  if (query.search) {
    const term = `%${query.search}%`
    conditions.push(`(p.club ILIKE ${push(term)} OR p.model ILIKE ${push(term)} OR EXISTS (
      SELECT 1 FROM product_variants w WHERE w.product_id = p.id AND w.sku ILIKE ${push(term)}
    ))`)
  }
  if (query.club) conditions.push(`p.club ILIKE ${push(`%${query.club}%`)}`)

  const variantClauses: string[] = []
  if (query.type) variantClauses.push(`v.type = ${push(query.type)}`)
  if (query.size) variantClauses.push(`v.size ILIKE ${push(`%${query.size}%`)}`)
  if (query.availability === 'in_stock') variantClauses.push('v.stock_quantity > 0')
  if (query.availability === 'out_of_stock') variantClauses.push('v.stock_quantity = 0')
  if (query.availability === 'low') variantClauses.push('v.stock_quantity <= v.low_stock_threshold')
  if (variantClauses.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM product_variants w WHERE w.product_id = p.id AND ${variantClauses.map((clause) => clause.replaceAll('v.', 'w.')).join(' AND ')}
    )`)
  }
  if (query.image === 'with') conditions.push('EXISTS(SELECT 1 FROM media d WHERE d.product_id = p.id AND d.active)')
  if (query.image === 'without') conditions.push('NOT EXISTS(SELECT 1 FROM media d WHERE d.product_id = p.id AND d.active)')

  return {
    where: conditions.length > 0 ? conditions.join(' AND ') : 'TRUE',
    params,
    variantCondition: variantClauses.length > 0 ? variantClauses.join(' AND ') : 'TRUE',
  }
}

function productOrderBy(sort: ProductFilters['sort'], order: ProductFilters['order']): string {
  const direction = order === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST'
  const column = { club: 'b.club', model: 'b.model', stock: 'b.total_stock', movement: 'b.last_movement_at' }[sort]
  return `ORDER BY ${column} ${direction}, b.club ASC, b.model ASC, b.id ASC`
}

function productPageQuery(whereClause: string, variantCondition = 'TRUE', orderClause = 'ORDER BY b.club, b.model') {
  return `WITH base AS (
            SELECT p.id, p.club, p.model, p.description,
              (SELECT coalesce(sum(v.stock_quantity), 0)::int
               FROM product_variants v WHERE v.product_id = p.id) AS total_stock,
              (SELECT max(m.created_at)::text
               FROM inventory_movements m
               JOIN product_variants v ON v.id = m.variant_id
               WHERE v.product_id = p.id) AS last_movement_at,
              EXISTS(SELECT 1 FROM media d WHERE d.product_id = p.id AND d.active) AS has_image,
              (SELECT d.id::text FROM media d WHERE d.product_id = p.id AND d.active ORDER BY d.created_at DESC LIMIT 1) AS media_id
            FROM products p
            WHERE ${whereClause}
          )
          SELECT b.id, b.club, b.model, b.description,
            b.total_stock AS "totalStock", b.last_movement_at AS "lastMovementAt", b.has_image AS "hasImage", b.media_id AS "mediaId",
            coalesce((SELECT jsonb_agg(jsonb_build_object(
              'id', v.id, 'type', v.type, 'size', v.size, 'sku', v.sku,
              'salePrice', v.sale_price::text, 'currentCost', v.current_cost::text,
              'stockQuantity', v.stock_quantity, 'lowStockThreshold', v.low_stock_threshold
            ) ORDER BY v.type, v.size)
            FROM product_variants v WHERE v.product_id = b.id AND (${variantCondition})), '[]'::jsonb) AS variants
          FROM base b
          ${orderClause}`
}

async function loadProduct(queryable: Pick<Pool, 'query'>, id: string): Promise<ProductRow | undefined> {
  const result = await queryable.query<ProductRow>(productPageQuery('p.id = $1'), [id])
  return result.rows[0]
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
