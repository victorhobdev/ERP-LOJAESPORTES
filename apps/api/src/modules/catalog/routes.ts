import { createHash, randomUUID } from 'node:crypto'

import multipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'
import { createLocalMediaStorage, type MediaStorage } from './media-storage.js'
import { catalogSyncProviderFromEnv, type CatalogSyncManifestItem, type CatalogSyncProvider } from './sync-provider.js'
import { maxImageBytes, sanitizeFileName, validateImage, type ImageValidationCode } from './validation.js'

export type CatalogRouteOptions = {
  mediaStorageDir?: string
  syncProvider?: CatalogSyncProvider | (() => CatalogSyncProvider | undefined)
  publisher?: CatalogPublisher
  rateLimits?: { uploadPerMinute?: number; syncPerMinute?: number }
}

export type CatalogPublishResult = {
  status: 'completed' | 'partial'
  created: number
  updated: number
  removed: number
  pendingWithoutImage: number
  errors: string[]
}

export type CatalogPublishPreviewItem = {
  productName: string
  club: string
  model: string
  type: string
  sizes: string
  status: 'OK' | 'DESATUALIZADO' | 'SEM_IMAGEM' | 'ORFAO'
  hasLocalImage: boolean
}

export type CatalogPublishProgress = {
  current: number
  total: number
  message: string
}

export type CatalogPublisher = {
  preview: () => Promise<{ items: CatalogPublishPreviewItem[] }>
  publish: (onProgress: (progress: CatalogPublishProgress) => void) => Promise<CatalogPublishResult>
}

type CatalogPublishJob = CatalogPublishProgress & {
  jobId: string
  status: 'running' | 'completed' | 'failed'
  result?: CatalogPublishResult
  error?: string
}

type MediaRow = {
  id: string
  storage_key: string
  mime_type: string
  original_name: string
  checksum_sha256: string
}

type IdempotencyRow = {
  request_hash: string
  response_status: number | null
  response_body: unknown
}

class ProductNotFoundError extends Error {
  readonly code = 'PRODUCT_NOT_FOUND'
}

class SyncItemError extends Error {
  constructor(public readonly code: ImageValidationCode | 'PRODUCT_NOT_FOUND' | 'INVALID_PRODUCT_KEY' | 'PROVIDER_READ_FAILED') {
    super(`sync item failed: ${code}`)
  }
}

function resolveStorage(options: CatalogRouteOptions): MediaStorage {
  const dir = options.mediaStorageDir ?? process.env['MEDIA_STORAGE_DIR']
  if (!dir) throw new Error('MEDIA_STORAGE_DIR is not configured.')
  return createLocalMediaStorage(dir)
}

function resolveProvider(options: CatalogRouteOptions): CatalogSyncProvider | undefined {
  if (typeof options.syncProvider === 'function') return options.syncProvider()
  if (options.syncProvider) return options.syncProvider
  return catalogSyncProviderFromEnv()
}

function publicMediaBody(row: {
  id: string
  product_id?: string
  productId?: string
  original_name: string
  mime_type: string
  byte_size: number
  checksum_sha256: string
  created_at?: string | null
  createdAt?: string | null
}, deduplicated: boolean) {
  const productId = row.productId ?? row.product_id!
  const createdAt = row.createdAt ?? row.created_at ?? null
  return {
    id: row.id,
    productId,
    url: `/catalog/media/${row.id}`,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    checksumSha256: row.checksum_sha256,
    createdAt,
    deduplicated,
  }
}

/**
 * Valida, grava o arquivo e a linha de mídia de forma coerente: a linha só é
 * confirmada depois que o arquivo existe no storage; falha de storage desfaz
 * a transação e o módulo de storage remove o temporário, sem órfãos.
 */
export async function attachImageToProduct(
  pool: Pool,
  storage: MediaStorage,
  input: {
    productId: string
    bytes: Buffer
    mimeType: string
    fileName: string
    userId: string
    requestId: string
    idempotencyScope?: string
    idempotencyKey?: string
    requestHash?: string
    auditAction: string
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const checksum = createHash('sha256').update(input.bytes).digest('hex')
  const client = await pool.connect()
  let committedFileKey: string | null = null
  try {
    await client.query('BEGIN')

    if (input.idempotencyKey && input.requestHash) {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (id, scope, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [randomUUID(), input.idempotencyScope, input.idempotencyKey, input.requestHash],
      )
      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE`,
          [input.idempotencyScope, input.idempotencyKey],
        )
        const prior = existing.rows[0]
        if (!prior || prior.request_hash !== input.requestHash) {
          await client.query('ROLLBACK')
          throw new ReplayConflictError()
        }
        if (prior.response_status && prior.response_body !== null) {
          await client.query('COMMIT')
          return { status: prior.response_status, body: prior.response_body as Record<string, unknown> }
        }
      }
    }

    const existing = await client.query<MediaRow & { byte_size: number; created_at: string; product_id: string }>(
      `SELECT id, product_id, original_name, mime_type, byte_size, checksum_sha256, created_at::text AS created_at
       FROM media
       WHERE product_id = $1 AND checksum_sha256 = $2 AND active = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.productId, checksum],
    )
    if (existing.rows[0]) {
      const body = publicMediaBody(existing.rows[0], true)
      if (input.idempotencyKey && input.requestHash) {
        await client.query(
          `UPDATE idempotency_keys SET response_status = 200, response_body = $3, completed_at = now()
           WHERE scope = $1 AND key = $2 AND response_body IS NULL`,
          [input.idempotencyScope, input.idempotencyKey, JSON.stringify(body)],
        )
      }
      await client.query('COMMIT')
      return { status: 200, body }
    }

    const product = await client.query('SELECT id FROM products WHERE id = $1', [input.productId])
    if (!product.rowCount) {
      await client.query('ROLLBACK')
      throw new ProductNotFoundError()
    }

    const mediaId = randomUUID()
    const storageKey = randomUUID()
    const inserted = await client.query<{ created_at: string }>(
      `INSERT INTO media (id, product_id, storage_key, original_name, mime_type, byte_size, checksum_sha256, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
       RETURNING created_at::text AS created_at`,
      [mediaId, input.productId, storageKey, input.fileName, input.mimeType, input.bytes.length, checksum, input.userId],
    )

    await storage.write(storageKey, input.bytes)
    committedFileKey = storageKey

    const body = publicMediaBody({
      id: mediaId,
      product_id: input.productId,
      original_name: input.fileName,
      mime_type: input.mimeType,
      byte_size: input.bytes.length,
      checksum_sha256: checksum,
      created_at: inserted.rows[0]!.created_at,
    }, false)

    await client.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
       VALUES ($1, $2, $3, 'media', $4, $5, $6)`,
      [randomUUID(), input.userId, input.auditAction, mediaId, input.requestId, JSON.stringify({
        productId: input.productId, mimeType: input.mimeType, byteSize: input.bytes.length, checksumSha256: checksum,
      })],
    )

    if (input.idempotencyKey && input.requestHash) {
      await client.query(
        `UPDATE idempotency_keys SET response_status = 201, response_body = $3, completed_at = now()
         WHERE scope = $1 AND key = $2 AND response_body IS NULL`,
        [input.idempotencyScope, input.idempotencyKey, JSON.stringify(body)],
      )
    }

    await client.query('COMMIT')
    return { status: 201, body }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (committedFileKey) await storage.remove(committedFileKey)
    throw error
  } finally {
    client.release()
  }
}

class ReplayConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED'
}

const validationStatusByCode: Record<ImageValidationCode, { status: number; message: string }> = {
  IMAGE_TYPE_NOT_SUPPORTED: { status: 415, message: 'Somente imagens JPEG, PNG e WebP são aceitas.' },
  IMAGE_EXTENSION_MISMATCH: { status: 400, message: 'A extensão do arquivo não corresponde ao tipo informado.' },
  IMAGE_CONTENT_INVALID: { status: 400, message: 'O conteúdo do arquivo não é uma imagem válida.' },
  IMAGE_EMPTY: { status: 400, message: 'O arquivo enviado está vazio.' },
  IMAGE_TOO_LARGE: { status: 413, message: 'A imagem excede o limite de 5 MB.' },
}

async function readUploadBytes(parts: { file: NodeJS.ReadableStream & { truncated?: boolean } }): Promise<{ bytes?: Buffer; truncated?: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of parts.file) {
    size += (chunk as Buffer).length
    if (size > maxImageBytes) return { truncated: true }
    chunks.push(chunk as Buffer)
  }
  if (parts.file.truncated === true) return { truncated: true }
  return { bytes: Buffer.concat(chunks) }
}

export function registerCatalogRoutes(app: FastifyInstance, pool: Pool, options: CatalogRouteOptions = {}) {
  const publishJobs = new Map<string, CatalogPublishJob>()
  let activePublishJobId: string | null = null

  void app.register(async (catalog) => {
    await catalog.register(multipart, {
      limits: { files: 1, fileSize: maxImageBytes, fields: 4, fieldSize: 4096 },
    })

    catalog.post('/catalog/images', {
      config: { rateLimit: { max: options.rateLimits?.uploadPerMinute ?? 20, timeWindow: '1 minute' } },
      bodyLimit: maxImageBytes + 1024 * 1024,
    }, async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

      let storage: MediaStorage
      try {
        storage = resolveStorage(options)
      } catch {
        return sendError(reply, request, 500, 'MEDIA_STORAGE_NOT_CONFIGURED', 'Armazenamento de mídia não configurado.')
      }

      const parsedProductId = z.object({ productId: z.string().uuid() }).safeParse(request.query)
      if (!parsedProductId.success) {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Produto inválido.')
      }

      let parts: Awaited<ReturnType<typeof request.file>>
      try {
        parts = await request.file()
      } catch {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Envie um arquivo de imagem em multipart/form-data.')
      }
      if (!parts) {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Envie um arquivo de imagem.')
      }

      const declaredMimeType = typeof parts.mimetype === 'string' ? parts.mimetype : ''
      const fileName = typeof parts.filename === 'string' ? parts.filename : 'imagem'
      const read = await readUploadBytes(parts)
      if (read.truncated || !read.bytes) {
        return sendError(reply, request, 413, 'IMAGE_TOO_LARGE', 'A imagem excede o limite de 5 MB.')
      }

      const validation = validateImage({ bytes: read.bytes, declaredMimeType, fileName })
      if (!validation.ok) {
        const { status, message } = validationStatusByCode[validation.code]
        return sendError(reply, request, status, validation.code, message)
      }

      const idempotencyKey = request.headers['idempotency-key']
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Chave de idempotência inválida.')
      }
      const requestHash = idempotencyKey
        ? createHash('sha256')
          .update(`${parsedProductId.data.productId}\n${validation.mimeType}\n${read.bytes.length}\n${createHash('sha256').update(read.bytes).digest('hex')}`)
          .digest('hex')
        : undefined

      try {
        const attached = await attachImageToProduct(pool, storage, {
          productId: parsedProductId.data.productId,
          bytes: read.bytes,
          mimeType: validation.mimeType,
          fileName,
          userId: session.user_id,
          requestId: request.id,
          auditAction: 'catalog.image.upload',
          ...(idempotencyKey === undefined ? {} : {
            idempotencyScope: `catalog.image.upload:${session.user_id}`,
            idempotencyKey,
            requestHash: requestHash!,
          }),
        })
        return reply.status(attached.status).send(attached.body)
      } catch (error) {
        if (error instanceof ProductNotFoundError) {
          return sendError(reply, request, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.')
        }
        if (error instanceof ReplayConflictError) {
          return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
        }
        request.log.error({ err: error }, 'Catalog image upload failed')
        return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação.')
      }
    })

    catalog.get('/catalog/media/:mediaId', async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'inventory:read')
      if (!session) return

      const parsed = z.object({ mediaId: z.string().uuid() }).safeParse(request.params)
      if (!parsed.success) {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Identificador de mídia inválido.')
      }

      const row = await pool.query<MediaRow>(
        `SELECT id, storage_key, mime_type, original_name, checksum_sha256
         FROM media WHERE id = $1 AND active = true`,
        [parsed.data.mediaId],
      )
      const media = row.rows[0]
      if (!media) {
        return sendError(reply, request, 404, 'MEDIA_NOT_FOUND', 'Imagem não encontrada.')
      }

      let storage: MediaStorage
      try {
        storage = resolveStorage(options)
      } catch {
        return sendError(reply, request, 500, 'MEDIA_STORAGE_NOT_CONFIGURED', 'Armazenamento de mídia não configurado.')
      }

      try {
        const etag = `"${media.checksum_sha256}"`
        if (request.headers['if-none-match'] === etag) {
          return reply.status(304).header('etag', etag).header('cache-control', 'private, max-age=300').send()
        }
        const file = await storage.readStream(media.storage_key)
        reply
          .header('etag', etag)
          .header('cache-control', 'private, max-age=300')
          .header('content-type', media.mime_type)
          .header('content-length', file.size)
          .header('content-disposition', `inline; filename="${sanitizeFileName(media.original_name)}"`)
        return reply.send(file.stream)
      } catch (error) {
        request.log.error({ err: error }, 'Catalog media file unavailable')
        return sendError(reply, request, 404, 'MEDIA_NOT_FOUND', 'Imagem não encontrada.')
      }
    })

    catalog.post('/catalog/sync', {
      config: { rateLimit: { max: options.rateLimits?.syncPerMinute ?? 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

      // Reconciliação best-effort de runs presas: uma run 'running' com mais de 30
      // minutos não pode mais estar executando (limite de 200 itens) — provavelmente
      // o processo caiu antes da finalização. Marcá-la 'failed' é seguro: runs são
      // registro informativo; os itens já anexados foram commitados por transação
      // própria e não são revertidos nem duplicados. Se a própria reconciliação
      // falhar (pool esgotado, queda de conexão), a falha é engolida: a requisição
      // segue e a run presa fica para a próxima passada de reconciliação.
      await reconcileStaleSyncRuns(pool)

      const idempotencyKey = request.headers['idempotency-key']
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
        return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Chave de idempotência inválida.')
      }

      const provider = resolveProvider(options)
      const requestHash = idempotencyKey
        ? createHash('sha256').update(`catalog.sync:${provider?.name ?? 'none'}`).digest('hex')
        : undefined
      const idempotencyScope = `catalog.sync:${session.user_id}`

      // Fase 1 — transação curta de abertura: idempotência e INSERT da run.
      // Nenhuma conexão fica presa durante executeSync, que abre transações
      // próprias por item; assim o sync funciona até com pool de 1 conexão.
      const client = await pool.connect()
      let runId: string
      let startedAt: string
      try {
        await client.query('BEGIN')
        if (idempotencyKey && requestHash) {
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
        }

        runId = randomUUID()
        const run = await client.query<{ started_at: string }>(
          `INSERT INTO catalog_sync_runs (id, status, started_by)
           VALUES ($1, 'running', $2)
           RETURNING started_at::text AS started_at`,
          [runId, session.user_id],
        )
        startedAt = run.rows[0]!.started_at
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        request.log.error({ err: error }, 'Catalog sync failed')
        return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação.')
      } finally {
        client.release()
      }

      // Fase 2 — execução fora de transação (cada item tem sua própria transação).
      let result: SyncOutcome
      try {
        result = await executeSync(pool, provider, runId, session.user_id, request.id, options)
      } catch (error) {
        request.log.error({ err: error }, 'Catalog sync execution failed')
        await markRunFailed(pool, runId, 'execution_failed')
        return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação.')
      }

      // O banco só aceita running/completed/partial/failed; ausência de provedor é registrada como failed controlado.
      const runStatus = result.status === 'not_configured' ? 'failed' : result.status
      const body = {
        runId,
        provider: result.provider,
        status: result.status,
        itemCount: result.itemCount,
        errorCount: result.errorCount,
        errors: result.errors,
        startedAt,
      }

      // Fase 3 — transação curta de finalização: run, auditoria e resposta idempotente.
      const finalizer = await pool.connect()
      try {
        await finalizer.query('BEGIN')
        const completed = await finalizer.query<{ completed_at: string }>(
          `UPDATE catalog_sync_runs
           SET status = $2, item_count = $3, error_count = $4, details = $5::jsonb, completed_at = now()
           WHERE id = $1
           RETURNING completed_at::text AS completed_at`,
          [runId, runStatus, result.itemCount, result.errorCount, JSON.stringify(result.details)],
        )

        await finalizer.query(
          `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
           VALUES ($1, $2, 'catalog.sync', 'catalog_sync_run', $3, $4, $5)`,
          [randomUUID(), session.user_id, runId, request.id, JSON.stringify({
            status: result.status, itemCount: result.itemCount, errorCount: result.errorCount, provider: result.provider,
          })],
        )

        if (idempotencyKey && requestHash) {
          await finalizer.query(
            `UPDATE idempotency_keys SET response_status = 200, response_body = $3, completed_at = now()
             WHERE scope = $1 AND key = $2 AND response_body IS NULL`,
            [idempotencyScope, idempotencyKey, JSON.stringify({ ...body, completedAt: completed.rows[0]!.completed_at })],
          )
        }

        await finalizer.query('COMMIT')
        return reply.status(200).send({ ...body, completedAt: completed.rows[0]!.completed_at })
      } catch (error) {
        await finalizer.query('ROLLBACK').catch(() => undefined)
        request.log.error({ err: error }, 'Catalog sync finalization failed')
        // Compensação: a run nunca pode ficar presa em 'running' se a finalização falhar.
        await markRunFailed(pool, runId, 'finalization_failed')
        return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação.')
      } finally {
        finalizer.release()
      }
    })

    catalog.post('/catalog/publish', {
      config: { rateLimit: { max: options.rateLimits?.syncPerMinute ?? 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
      if (!options.publisher) {
        return sendError(reply, request, 503, 'CATALOG_PUBLISH_NOT_CONFIGURED', 'Publicação no Google Drive não configurada.')
      }

      try {
        return reply.status(200).send(await options.publisher.publish(() => undefined))
      } catch (error) {
        request.log.error({ err: error }, 'Catalog publish failed')
        return sendError(reply, request, 500, 'CATALOG_PUBLISH_FAILED', 'Não foi possível sincronizar o catálogo com o Google Drive.')
      }
    })

    catalog.get('/catalog/publish/preview', async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      if (!options.publisher) {
        return sendError(reply, request, 503, 'CATALOG_PUBLISH_NOT_CONFIGURED', 'Publicação no Google Drive não configurada.')
      }

      try {
        return reply.status(200).send(await options.publisher.preview())
      } catch (error) {
        request.log.error({ err: error }, 'Catalog publish preview failed')
        return sendError(reply, request, 502, 'CATALOG_PREVIEW_FAILED', 'Não foi possível comparar o catálogo com o Google Drive.')
      }
    })

    catalog.post('/catalog/publish/jobs', {
      config: { rateLimit: { max: options.rateLimits?.syncPerMinute ?? 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
      if (!options.publisher) {
        return sendError(reply, request, 503, 'CATALOG_PUBLISH_NOT_CONFIGURED', 'Publicação no Google Drive não configurada.')
      }
      if (activePublishJobId && publishJobs.get(activePublishJobId)?.status === 'running') {
        return sendError(reply, request, 409, 'CATALOG_PUBLISH_IN_PROGRESS', 'Já existe uma sincronização em andamento.')
      }

      const job: CatalogPublishJob = {
        jobId: randomUUID(),
        status: 'running',
        current: 0,
        total: 1,
        message: 'Preparando sincronização…',
      }
      publishJobs.set(job.jobId, job)
      activePublishJobId = job.jobId
      const log = request.log

      void options.publisher.publish((progress) => {
        if (job.status !== 'running') return
        job.current = progress.current
        job.total = Math.max(progress.total, 1)
        job.message = progress.message
      }).then((result) => {
        job.status = 'completed'
        job.current = Math.max(job.total, 1)
        job.message = result.status === 'completed' ? 'Sincronização concluída.' : 'Sincronização concluída com pendências.'
        job.result = result
      }).catch((error: unknown) => {
        log.error({ err: error }, 'Catalog publish job failed')
        job.status = 'failed'
        job.message = 'Não foi possível sincronizar o catálogo com o Google Drive.'
        job.error = job.message
      }).finally(() => {
        if (activePublishJobId === job.jobId) activePublishJobId = null
      })

      return reply.status(202).send(job)
    })

    catalog.get('/catalog/publish/jobs/:jobId', async (request, reply) => {
      const session = await requirePermission(pool, request, reply, 'catalog:write')
      if (!session) return
      const parsed = z.object({ jobId: z.string().uuid() }).safeParse(request.params)
      if (!parsed.success) return sendError(reply, request, 404, 'CATALOG_PUBLISH_JOB_NOT_FOUND', 'Sincronização não encontrada.')
      const job = publishJobs.get(parsed.data.jobId)
      if (!job) return sendError(reply, request, 404, 'CATALOG_PUBLISH_JOB_NOT_FOUND', 'Sincronização não encontrada.')
      return reply.status(200).send(job)
    })
  })
}

type SyncOutcome = {
  status: 'completed' | 'partial' | 'failed' | 'not_configured'
  provider: string
  itemCount: number
  errorCount: number
  errors: Array<{ productKey: string; reason: string }>
  details: Record<string, unknown>
}

const syncItemLimit = 200

/**
 * Compensação best-effort: run nunca deve permanecer 'running' após falha fora da
 * fase de abertura. Se este UPDATE falhar, a exceção é engolida de propósito — a
 * resposta de erro já foi decidida e a run presa será reconciliada pela próxima
 * chamada de sync (threshold de 30 minutos) ou por verificação manual.
 */
async function markRunFailed(pool: Pool, runId: string, reason: string): Promise<void> {
  await pool
    .query(
      `UPDATE catalog_sync_runs
       SET status = 'failed', details = $2::jsonb, completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [runId, JSON.stringify({ reason })],
    )
    .catch(() => undefined)
}

const staleSyncRunThreshold = '30 minutes'

/**
 * Reconcilia runs presas em 'running' antes de abrir uma nova run. Best-effort:
 * se o UPDATE falhar, a exceção é engolida de propósito — o sync segue e as runs
 * presas ficam para a próxima passada (repetível: cada chamada de sync tenta de novo).
 */
async function reconcileStaleSyncRuns(pool: Pool): Promise<void> {
  await pool
    .query(
      `UPDATE catalog_sync_runs
       SET status = 'failed', details = jsonb_build_object('reason', 'stale_reconciled'), completed_at = now()
       WHERE status = 'running' AND started_at < now() - interval '${staleSyncRunThreshold}'`,
    )
    .catch(() => undefined)
}

async function executeSync(
  pool: Pool,
  provider: CatalogSyncProvider | undefined,
  runId: string,
  userId: string,
  requestId: string,
  options: CatalogRouteOptions,
): Promise<SyncOutcome> {
  if (!provider) {
    return {
      status: 'not_configured', provider: 'none', itemCount: 0, errorCount: 0, errors: [],
      details: { reason: 'provider_not_configured', runId },
    }
  }

  let manifest: CatalogSyncManifestItem[]
  try {
    manifest = await provider.fetchManifest()
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'provider_not_configured') {
      return {
        status: 'not_configured', provider: provider.name, itemCount: 0, errorCount: 0, errors: [],
        details: { reason: 'provider_not_configured', runId },
      }
    }
    return {
      status: 'failed', provider: provider.name, itemCount: 0, errorCount: 0, errors: [],
      details: { reason: code === 'local_dir_missing' ? 'local_dir_missing' : 'provider_failure', runId },
    }
  }
  if (!Array.isArray(manifest)) {
    return { status: 'failed', provider: provider.name, itemCount: 0, errorCount: 0, errors: [], details: { reason: 'provider_failure', runId } }
  }

  const items = manifest.slice(0, syncItemLimit)
  const errors: Array<{ productKey: string; reason: string }> = []
  let attached = 0
  let storage: MediaStorage | undefined
  try {
    storage = resolveStorage(options)
  } catch {
    return {
      status: 'failed', provider: provider.name, itemCount: items.length, errorCount: items.length,
      errors: items.map((item) => ({ productKey: item.productKey, reason: 'MEDIA_STORAGE_NOT_CONFIGURED' })),
      details: { reason: 'storage_not_configured', runId },
    }
  }

  for (const item of items) {
    try {
      await syncItem(pool, storage, item, userId, requestId)
      attached += 1
    } catch (error) {
      if (error instanceof SyncItemError) {
        errors.push({ productKey: item.productKey, reason: error.code })
      } else {
        errors.push({ productKey: item.productKey, reason: 'SYNC_ITEM_FAILED' })
      }
    }
  }

  const status = errors.length === 0 ? 'completed' : attached > 0 ? 'partial' : 'failed'
  return {
    status,
    provider: provider.name,
    itemCount: items.length,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
    details: { provider: provider.name, runId, truncated: manifest.length > syncItemLimit },
  }
}

async function syncItem(
  pool: Pool,
  storage: MediaStorage,
  item: CatalogSyncManifestItem,
  userId: string,
  requestId: string,
) {
  const separator = item.productKey.indexOf('__')
  if (separator <= 0 || separator === item.productKey.length - 2) {
    throw new SyncItemError('INVALID_PRODUCT_KEY')
  }
  const club = item.productKey.slice(0, separator)
  const model = item.productKey.slice(separator + 2)
  if (club.trim() === '' || model.trim() === '') {
    throw new SyncItemError('INVALID_PRODUCT_KEY')
  }

  const product = await pool.query<{ id: string }>(
    `SELECT id FROM products WHERE lower(club) = lower($1) AND lower(model) = lower($2)`,
    [club.trim(), model.trim()],
  )
  if (!product.rows[0]) {
    throw new SyncItemError('PRODUCT_NOT_FOUND')
  }

  let bytes: Buffer
  try {
    bytes = await item.read()
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'image_too_large') {
      throw new SyncItemError('IMAGE_TOO_LARGE')
    }
    throw new SyncItemError('PROVIDER_READ_FAILED')
  }

  const validation = validateImage({ bytes, declaredMimeType: item.mimeType, fileName: item.fileName })
  if (!validation.ok) {
    throw new SyncItemError(validation.code)
  }

  try {
    await attachImageToProduct(pool, storage, {
      productId: product.rows[0].id,
      bytes,
      mimeType: validation.mimeType,
      fileName: item.fileName,
      userId,
      requestId,
      auditAction: 'catalog.image.sync',
    })
  } catch (error) {
    if (error instanceof ProductNotFoundError) {
      throw new SyncItemError('PRODUCT_NOT_FOUND')
    }
    throw error
  }
}
