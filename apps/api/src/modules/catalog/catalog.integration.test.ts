import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type PoolClient, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'
import type { CatalogSyncProvider, CatalogSyncManifestItem } from './sync-provider.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x10), Buffer.from([0xff, 0xd9])])
const maxImageBytes = 5_242_880

function multipartBody(fields: Array<{ name: string; value: string }>, file: { name: string; fileName: string; mimeType: string; bytes: Buffer }) {
  const boundary = `erp2test${randomUUID().replaceAll('-', '')}`
  const parts: Buffer[] = []
  for (const field of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`))
  parts.push(file.bytes)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('catalog media HTTP flow', () => {
  /** Pool cujos clientes falham só no UPDATE de finalização da run; compensação usa pool.query (real). */
  function failingFinalizationPool(base: Pool): Pool {
    return {
      connect: async () => {
        const client = await base.connect()
        const wrapped = {
          query: async (...args: unknown[]) => {
            const text = String(args[0])
            if (text.includes('UPDATE catalog_sync_runs')) throw new Error('falha sintética de finalização')
            return (client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args)
          },
          release: () => client.release(),
        }
        return wrapped as unknown as PoolClient
      },
      query: base.query.bind(base),
    } as unknown as Pool
  }

  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const managerToken = randomUUID()
  const managerCsrf = randomUUID()
  const managerId = randomUUID()
  const operatorToken = randomUUID()
  const operatorCsrf = randomUUID()
  const operatorId = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>
  let storageDir: string
  const providerHolder: { current: CatalogSyncProvider | undefined } = { current: undefined }

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'gestor.catalogo', 'Gestor Catalogo', 'unused-in-this-test', '00000000-0000-4000-8000-000000000003'),
              ($2, 'operador.catalogo', 'Operador Catalogo', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [managerId, operatorId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour'),
              ($5, $6, $7, $8, now() + interval '1 hour')`,
      [randomUUID(), managerId, hashSecret(managerToken), hashSecret(managerCsrf), randomUUID(), operatorId, hashSecret(operatorToken), hashSecret(operatorCsrf)],
    )
    storageDir = await mkdtemp(path.join(tmpdir(), 'erp2-media-int-'))
    app = buildApp({
      pool, logger: false, secureCookies: false, mediaStorageDir: storageDir,
      catalogSyncProvider: () => providerHolder.current,
      catalogPublisher: {
        preview: async () => ({
          items: [
            { productName: 'FLAMENGO I 2026 Masculina', club: 'FLAMENGO', model: 'I 2026', type: 'Masculina', sizes: 'M, G', status: 'OK', hasLocalImage: true },
            { productName: 'REAL MADRID PLAYER Masculina', club: 'REAL MADRID', model: 'PLAYER', type: 'Masculina', sizes: '2GG', status: 'DESATUALIZADO', hasLocalImage: true },
          ],
        }),
        publish: async (onProgress) => {
          onProgress({ current: 1, total: 2, message: 'Processando FLAMENGO I 2026' })
          await new Promise((resolve) => setTimeout(resolve, 30))
          onProgress({ current: 2, total: 2, message: 'Processando REAL MADRID PLAYER' })
          return { status: 'completed', created: 2, updated: 3, removed: 1, pendingWithoutImage: 4, errors: [] }
        },
      },
      catalogRateLimits: { uploadPerMinute: 10_000, syncPerMinute: 10_000 },
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    await rm(storageDir, { recursive: true, force: true })
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  function managerHeaders(extra: Record<string, string> = {}) {
    return { cookie: `erp_session=${managerToken}; erp_csrf=${managerCsrf}`, 'x-csrf-token': managerCsrf, ...extra }
  }
  function operatorHeaders() {
    return { cookie: `erp_session=${operatorToken}; erp_csrf=${operatorCsrf}`, 'x-csrf-token': operatorCsrf }
  }

  it('publica o catálogo atual no Google Drive pelo publicador configurado', async () => {
    const response = await app.inject({ method: 'POST', url: '/catalog/publish', headers: managerHeaders() })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'completed', created: 2, updated: 3, removed: 1, pendingWithoutImage: 4, errors: [],
    })
  })

  it('mostra a prévia do Drive antes de executar a publicação', async () => {
    const response = await app.inject({ method: 'GET', url: '/catalog/publish/preview', headers: managerHeaders() })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [
        { productName: 'FLAMENGO I 2026 Masculina', club: 'FLAMENGO', model: 'I 2026', type: 'Masculina', sizes: 'M, G', status: 'OK', hasLocalImage: true },
        { productName: 'REAL MADRID PLAYER Masculina', club: 'REAL MADRID', model: 'PLAYER', type: 'Masculina', sizes: '2GG', status: 'DESATUALIZADO', hasLocalImage: true },
      ],
    })
  })

  it('expõe progresso real enquanto a publicação roda', async () => {
    const started = await app.inject({ method: 'POST', url: '/catalog/publish/jobs', headers: managerHeaders() })
    expect(started.statusCode).toBe(202)
    const { jobId } = started.json() as { jobId: string }

    const running = await app.inject({ method: 'GET', url: `/catalog/publish/jobs/${jobId}`, headers: managerHeaders() })
    expect(running.statusCode).toBe(200)
    expect(running.json()).toMatchObject({ status: 'running', current: 1, total: 2, message: 'Processando FLAMENGO I 2026' })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const completed = await app.inject({ method: 'GET', url: `/catalog/publish/jobs/${jobId}`, headers: managerHeaders() })
    expect(completed.statusCode).toBe(200)
    expect(completed.json()).toMatchObject({
      status: 'completed', current: 2, total: 2,
      result: { created: 2, updated: 3, removed: 1, pendingWithoutImage: 4, errors: [] },
    })
  })

  async function createProduct(club: string, model: string) {
    const created = await app.inject({
      method: 'POST', url: '/products', headers: managerHeaders(),
      payload: { club, model, variants: [{ type: 'Masculina', size: 'M', sku: `${club.slice(0, 3).toUpperCase()}-${randomUUID().slice(0, 6)}`, salePrice: '150.00', currentCost: '80.00', lowStockThreshold: 2 }] },
    })
    expect(created.statusCode).toBe(201)
    return created.json() as { id: string }
  }

  async function uploadImage(productId: string, bytes: Buffer, fileName: string, mimeType: string, headers: Record<string, string> = managerHeaders()) {
    const body = multipartBody([], { name: 'file', fileName, mimeType, bytes })
    return app.inject({
      method: 'POST', url: `/catalog/images?productId=${productId}`, payload: body.payload,
      headers: { ...headers, 'content-type': body.contentType },
    })
  }

  async function countFiles() {
    return (await readdir(storageDir)).length
  }

  it('exige sessão, permissão catalog:write e CSRF para upload e sync', async () => {
    const productId = (await createProduct('Auth FC', 'Titular')).id

    const anonymous = await app.inject({ method: 'POST', url: `/catalog/images?productId=${productId}`, payload: Buffer.alloc(0) })
    expect(anonymous.statusCode).toBe(401)
    const anonymousSync = await app.inject({ method: 'POST', url: '/catalog/sync', payload: {} })
    expect(anonymousSync.statusCode).toBe(401)

    const operator = await uploadImage(productId, pngBytes, 'x.png', 'image/png', operatorHeaders())
    expect(operator.statusCode).toBe(403)
    expect(operator.json()).toMatchObject({ code: 'FORBIDDEN' })

    const badCsrf = await uploadImage(productId, pngBytes, 'x.png', 'image/png', { cookie: `erp_session=${managerToken}; erp_csrf=${managerCsrf}`, 'x-csrf-token': 'invalido' })
    expect(badCsrf.statusCode).toBe(403)
    expect(badCsrf.json()).toMatchObject({ code: 'INVALID_CSRF' })

    const operatorSync = await app.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: operatorHeaders() })
    expect(operatorSync.statusCode).toBe(403)
    const badSyncCsrf = await app.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: { cookie: `erp_session=${managerToken}; erp_csrf=${managerCsrf}`, 'x-csrf-token': 'invalido' } })
    expect(badSyncCsrf.statusCode).toBe(403)

    const mediaAnonymous = await app.inject({ method: 'GET', url: `/catalog/media/${randomUUID()}` })
    expect(mediaAnonymous.statusCode).toBe(401)
  })

  it('faz upload válido, grava arquivo e metadados, e resposta é sanitizada', async () => {
    const product = await createProduct('Upload FC', 'Home')
    const response = await uploadImage(product.id, pngBytes, 'escudo.png', 'image/png')
    expect(response.statusCode).toBe(201)
    const body = response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      productId: product.id, originalName: 'escudo.png', mimeType: 'image/png',
      byteSize: pngBytes.length, checksumSha256: createHash('sha256').update(pngBytes).digest('hex'), deduplicated: false,
    })
    expect(body.url).toBe(`/catalog/media/${body.id}`)
    expect(response.body).not.toContain('storage')
    expect(response.body).not.toContain(storageDir)
    expect(response.body).not.toContain('\\')
    expect(typeof body.id).toBe('string')

    const rows = await pool.query('SELECT storage_key, byte_size, checksum_sha256, active FROM media WHERE product_id = $1', [product.id])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({ byte_size: pngBytes.length, active: true, checksum_sha256: createHash('sha256').update(pngBytes).digest('hex') })
    const stored = await stat(path.join(storageDir, rows.rows[0]!.storage_key))
    expect(stored.isFile()).toBe(true)
    expect(await countFiles()).toBe(1)

    const audit = await pool.query(`SELECT action, entity_type FROM audit_log WHERE entity_id = $1`, [body.id])
    expect(audit.rows[0]).toMatchObject({ action: 'catalog.image.upload', entity_type: 'media' })
  })

  it('repetição do mesmo arquivo para o mesmo produto é idempotente e não duplica arquivo nem linha', async () => {
    const product = await createProduct('Idem FC', 'Away')
    const filesBefore = await countFiles()
    const first = await uploadImage(product.id, jpegBytes, 'torcida.jpg', 'image/jpeg')
    expect(first.statusCode).toBe(201)

    const sameWithoutKey = await uploadImage(product.id, jpegBytes, 'torcida.jpg', 'image/jpeg')
    expect(sameWithoutKey.statusCode).toBe(200)
    expect(sameWithoutKey.json()).toMatchObject({ id: first.json().id, deduplicated: true })

    const key = randomUUID()
    const replayFirst = await uploadImage(product.id, jpegBytes, 'torcida-replay.jpg', 'image/jpeg', { ...managerHeaders(), 'idempotency-key': key })
    expect([200, 201]).toContain(replayFirst.statusCode)
    const replaySecond = await uploadImage(product.id, jpegBytes, 'torcida-replay.jpg', 'image/jpeg', { ...managerHeaders(), 'idempotency-key': key })
    expect(replaySecond.statusCode).toBe(replayFirst.statusCode)
    expect(replaySecond.json()).toEqual(replayFirst.json())

    const rows = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
    expect(rows.rows[0]?.total).toBe(1)
    expect(await countFiles()).toBe(filesBefore + 1)
  })

  it('mesmo conteúdo para outro produto cria mídia própria', async () => {
    const productA = await createProduct('Cruzeiro FC', 'Away')
    const productB = await createProduct('Santos FC', 'Away')
    await uploadImage(productA.id, pngBytes, 'escudo.png', 'image/png')
    const second = await uploadImage(productB.id, pngBytes, 'escudo.png', 'image/png')
    expect(second.statusCode).toBe(201)
    expect(second.json()).toMatchObject({ productId: productB.id, deduplicated: false })
  })

  it('rejeita produto inexistente sem deixar arquivo nem linha', async () => {
    const before = await countFiles()
    const rowsBefore = await pool.query('SELECT count(*)::int AS total FROM media')
    const response = await uploadImage(randomUUID(), pngBytes, 'x.png', 'image/png')
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' })
    expect(await countFiles()).toBe(before)
    const rowsAfter = await pool.query('SELECT count(*)::int AS total FROM media')
    expect(rowsAfter.rows[0]?.total).toBe(rowsBefore.rows[0]?.total)
  })

  it('rejeita productId inválido, arquivo ausente e conteúdo proibido sem órfãos', async () => {
    const product = await createProduct('Valid FC', 'Away')
    const before = await countFiles()

    const badIdBody = multipartBody([], { name: 'file', fileName: 'x.png', mimeType: 'image/png', bytes: pngBytes })
    const badId = await app.inject({
      method: 'POST', url: '/catalog/images?productId=nao-uuid', payload: badIdBody.payload,
      headers: { ...managerHeaders(), 'content-type': badIdBody.contentType },
    })
    expect(badId.statusCode).toBe(400)

    const noFile = await app.inject({ method: 'POST', url: `/catalog/images?productId=${product.id}`, payload: '', headers: managerHeaders() })
    expect(noFile.statusCode).toBe(400)
    const fieldOnly = multipartBody([{ name: 'productId', value: product.id }], { name: 'file', fileName: '', mimeType: 'application/octet-stream', bytes: Buffer.alloc(0) })
    const noFilePart = await app.inject({ method: 'POST', url: `/catalog/images?productId=${product.id}`, payload: fieldOnly.payload, headers: { ...managerHeaders(), 'content-type': fieldOnly.contentType } })
    expect(noFilePart.statusCode).toBe(415)

    const cases: Array<{ bytes: Buffer; fileName: string; mimeType: string; code: string; status: number }> = [
      { bytes: Buffer.from('GIF89a-x'), fileName: 'x.png', mimeType: 'image/gif', code: 'IMAGE_TYPE_NOT_SUPPORTED', status: 415 },
      { bytes: pngBytes, fileName: 'x.jpg', mimeType: 'image/png', code: 'IMAGE_EXTENSION_MISMATCH', status: 400 },
      { bytes: Buffer.from('conteudo-texto'), fileName: 'x.png', mimeType: 'image/png', code: 'IMAGE_CONTENT_INVALID', status: 400 },
      { bytes: Buffer.alloc(0), fileName: 'x.png', mimeType: 'image/png', code: 'IMAGE_EMPTY', status: 400 },
      { bytes: pngBytes, fileName: 'x.png', mimeType: 'image/jpeg', code: 'IMAGE_EXTENSION_MISMATCH', status: 400 },
    ]
    for (const item of cases) {
      const response = await uploadImage(product.id, item.bytes, item.fileName, item.mimeType)
      expect(response.statusCode).toBe(item.status)
      expect(response.json()).toMatchObject({ code: item.code })
    }

    const rows = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
    expect(rows.rows[0]?.total).toBe(0)
    expect(await countFiles()).toBe(before)
  })

  it('rejeita imagem acima de 5 MiB sem órfãos', async () => {
    const product = await createProduct('Grande FC', 'Away')
    const before = await countFiles()
    const huge = Buffer.concat([pngBytes, Buffer.alloc(maxImageBytes + 1024)])
    const response = await uploadImage(product.id, huge, 'grande.png', 'image/png')
    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    const rows = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
    expect(rows.rows[0]?.total).toBe(0)
    expect(await countFiles()).toBe(before)
  })

  it('serve a mídia apenas por id válido, com tipo, etag e 304; sem traversal', async () => {
    const product = await createProduct('Leitura FC', 'Home')
    const uploaded = await uploadImage(product.id, pngBytes, 'escudo.png', 'image/png')
    const mediaId = (uploaded.json() as { id: string }).id

    const bad = await app.inject({ method: 'GET', url: '/catalog/media/nao-uuid', headers: operatorHeaders() })
    expect(bad.statusCode).toBe(400)
    const unknown = await app.inject({ method: 'GET', url: `/catalog/media/${randomUUID()}`, headers: operatorHeaders() })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 'MEDIA_NOT_FOUND' })

    const ok = await app.inject({ method: 'GET', url: `/catalog/media/${mediaId}`, headers: operatorHeaders() })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toBe('image/png')
    expect(ok.headers['etag']).toBe(`"${createHash('sha256').update(pngBytes).digest('hex')}"`)
    expect(String(ok.headers['content-disposition'])).not.toMatch(/[\r\n]/)
    expect(ok.rawPayload).toEqual(pngBytes)

    const cached = await app.inject({ method: 'GET', url: `/catalog/media/${mediaId}`, headers: { ...operatorHeaders(), 'if-none-match': ok.headers['etag'] as string } })
    expect(cached.statusCode).toBe(304)

    const traversal = await app.inject({ method: 'GET', url: `/catalog/media/..%2F..%2Fetc%2Fpasswd`, headers: operatorHeaders() })
    expect([400, 404]).toContain(traversal.statusCode)
  })

  it('falha de integridade (linha sem arquivo) responde 404 sanitizado', async () => {
    const product = await createProduct('Integridade FC', 'Home')
    const uploaded = await uploadImage(product.id, pngBytes, 'x.png', 'image/png')
    const mediaId = (uploaded.json() as { id: string }).id
    const row = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media WHERE id = $1', [mediaId])
    await rm(path.join(storageDir, row.rows[0]!.storage_key))

    const response = await app.inject({ method: 'GET', url: `/catalog/media/${mediaId}`, headers: operatorHeaders() })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'MEDIA_NOT_FOUND' })
    expect(response.body).not.toContain(storageDir)
  })

  it('lista produtos com mediaId após upload e sem imagem quando ausente', async () => {
    const withImage = await createProduct('Listagem FC', 'Com Imagem')
    const withoutImage = await createProduct('Listagem FC', 'Sem Imagem')
    const uploaded = await uploadImage(withImage.id, pngBytes, 'x.png', 'image/png')
    const mediaId = (uploaded.json() as { id: string }).id

    const listed = await app.inject({ method: 'GET', url: '/products?search=Listagem FC', headers: operatorHeaders() })
    expect(listed.statusCode).toBe(200)
    const items = listed.json().items as Array<{ id: string; mediaId: string | null }>
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get(withImage.id)?.mediaId).toBe(mediaId)
    expect(byId.get(withoutImage.id)?.mediaId).toBeNull()
  })

  it('GET /catalog expõe a listagem canônica com autorização, filtros, paginação e mediaId', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/catalog' })
    expect(anonymous.statusCode).toBe(401)

    const product = await createProduct('CatalogRoute FC', 'Titular')
    await uploadImage(product.id, pngBytes, 't.png', 'image/png')

    const withImage = await app.inject({
      method: 'GET', url: '/catalog?search=CatalogRoute&image=with&page=1&limit=10', headers: operatorHeaders(),
    })
    expect(withImage.statusCode).toBe(200)
    const withBody = withImage.json() as {
      items: Array<{ id: string; mediaId: string | null; currentCost?: string; variants: Array<{ currentCost?: string }> }>
      total: number; page: number; limit: number
    }
    expect(withBody.page).toBe(1)
    expect(withBody.limit).toBe(10)
    expect(withBody.total).toBeGreaterThanOrEqual(1)
    const match = withBody.items.find((item) => item.id === product.id)
    expect(match?.mediaId).toBeTruthy()
    expect(match?.variants[0]?.currentCost).toBeUndefined()

    const withoutMatch = await app.inject({
      method: 'GET', url: '/catalog?search=NuncaCriadoXYZ&image=without', headers: operatorHeaders(),
    })
    expect(withoutMatch.statusCode).toBe(200)
    expect((withoutMatch.json() as { total: number }).total).toBe(0)

    const term = encodeURIComponent('CatalogRoute FC')
    const viaCatalog = await app.inject({ method: 'GET', url: `/catalog?search=${term}`, headers: operatorHeaders() })
    const viaProducts = await app.inject({ method: 'GET', url: `/products?search=${term}`, headers: operatorHeaders() })
    expect(viaCatalog.statusCode).toBe(200)
    expect(viaCatalog.json()).toEqual(viaProducts.json())
  })

  describe('POST /catalog/sync', () => {
    function syncRequest(headers: Record<string, string> = managerHeaders(), key?: string) {
      return app.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: key ? { ...headers, 'idempotency-key': key } : headers })
    }

    it('completa com provedor fake válido, audita e anexa imagens reais', async () => {
      const product = await createProduct('Sync FC', 'Titular')
      providerHolder.current = {
        name: 'fake',
        fetchManifest: async () => [
          { productKey: 'Sync FC__Titular', fileName: 't.png', mimeType: 'image/png', read: async () => pngBytes },
        ],
      }
      const response = await syncRequest()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'completed', itemCount: 1, errorCount: 0, provider: 'fake' })
      const runId = (response.json() as { runId: string }).runId

      const run = await pool.query(`SELECT status, item_count, error_count FROM catalog_sync_runs WHERE id = $1`, [runId])
      expect(run.rows[0]).toMatchObject({ status: 'completed', item_count: 1, error_count: 0 })
      const media = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
      expect(media.rows[0]?.total).toBe(1)
      const audit = await pool.query(`SELECT action, entity_type FROM audit_log WHERE entity_id = $1`, [runId])
      expect(audit.rows[0]).toMatchObject({ action: 'catalog.sync', entity_type: 'catalog_sync_run' })
    })

    it('item desconhecido produz status partial com erro tipado e não interrompe os demais', async () => {
      const product = await createProduct('Partial FC', 'Titular')
      providerHolder.current = {
        name: 'fake',
        fetchManifest: async () => [
          { productKey: 'Ninguem__Nada', fileName: 'x.png', mimeType: 'image/png', read: async () => pngBytes },
          { productKey: 'Partial FC__Titular', fileName: 't.png', mimeType: 'image/png', read: async () => pngBytes },
        ],
      }
      const response = await syncRequest()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        status: 'partial', itemCount: 2, errorCount: 1,
        errors: [{ productKey: 'Ninguem__Nada', reason: 'PRODUCT_NOT_FOUND' }],
      })
      const media = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
      expect(media.rows[0]?.total).toBe(1)
    })

    it('conteúdo inválido no manifest é rejeitado como erro de item, sem arquivo órfão', async () => {
      const before = await countFiles()
      providerHolder.current = {
        name: 'fake',
        fetchManifest: async () => [
          { productKey: 'Sync FC__Titular', fileName: 'ruim.gif', mimeType: 'image/gif', read: async () => Buffer.from('GIF89a') },
          { productKey: 'Sync FC__Titular', fileName: 'gigante.png', mimeType: 'image/png', read: async () => Buffer.concat([pngBytes, Buffer.alloc(maxImageBytes + 10)]) },
        ],
      }
      const response = await syncRequest()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'failed', itemCount: 2, errorCount: 2 })
      expect((response.json() as { errors: Array<{ reason: string }> }).errors.map((item) => item.reason).sort())
        .toEqual(['IMAGE_TOO_LARGE', 'IMAGE_TYPE_NOT_SUPPORTED'])
      expect(await countFiles()).toBe(before)
    })

    it('falha do provedor registra run failed e não derruba leitura local', async () => {
      providerHolder.current = {
        name: 'fake',
        fetchManifest: async () => { throw new Error('conexão externa recusada') },
      }
      const response = await syncRequest()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'failed', provider: 'fake' })
      const body = response.json() as { runId: string }
      const run = await pool.query(`SELECT status FROM catalog_sync_runs WHERE id = $1`, [body.runId])
      expect(run.rows[0]).toMatchObject({ status: 'failed' })

      const stillUp = await app.inject({ method: 'GET', url: '/products?limit=1', headers: operatorHeaders() })
      expect(stillUp.statusCode).toBe(200)
      const mediaStillUp = await app.inject({ method: 'GET', url: `/catalog/media/${randomUUID()}`, headers: operatorHeaders() })
      expect(mediaStillUp.statusCode).toBe(404)
    })

    it('provedor ausente responde not_configured com run registrada como failed controlado', async () => {
      providerHolder.current = undefined
      const response = await syncRequest()
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'not_configured' })
      const runId = (response.json() as { runId: string }).runId
      const run = await pool.query(`SELECT status FROM catalog_sync_runs WHERE id = $1`, [runId])
      expect(run.rows[0]).toMatchObject({ status: 'failed' })
    })

    it('repetição de sync com a mesma chave de idempotência devolve a mesma resposta sem nova run', async () => {
      const product = await createProduct('Replay FC', 'Titular')
      const manifest: CatalogSyncManifestItem[] = [
        { productKey: 'Replay FC__Titular', fileName: 't.png', mimeType: 'image/png', read: async () => pngBytes },
      ]
      providerHolder.current = { name: 'fake', fetchManifest: async () => manifest }
      const runsBefore = await pool.query('SELECT count(*)::int AS total FROM catalog_sync_runs')
      const key = randomUUID()
      const first = await syncRequest(managerHeaders(), key)
      expect(first.statusCode).toBe(200)
      const second = await syncRequest(managerHeaders(), key)
      expect(second.statusCode).toBe(200)
      expect(second.json()).toEqual(first.json())

      const runs = await pool.query('SELECT count(*)::int AS total FROM catalog_sync_runs')
      expect(runs.rows[0]?.total).toBe((runsBefore.rows[0]?.total ?? 0) + 1)
      const media = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
      expect(media.rows[0]?.total).toBe(1)
    })

    function withEnv(provider: string | undefined, localDir: string | undefined, run: () => Promise<void>) {
      const previousProvider = process.env['CATALOG_SYNC_PROVIDER']
      const previousDir = process.env['CATALOG_SYNC_LOCAL_DIR']
      if (provider === undefined) delete process.env['CATALOG_SYNC_PROVIDER']; else process.env['CATALOG_SYNC_PROVIDER'] = provider
      if (localDir === undefined) delete process.env['CATALOG_SYNC_LOCAL_DIR']; else process.env['CATALOG_SYNC_LOCAL_DIR'] = localDir
      return run().finally(() => {
        if (previousProvider === undefined) delete process.env['CATALOG_SYNC_PROVIDER']; else process.env['CATALOG_SYNC_PROVIDER'] = previousProvider
        if (previousDir === undefined) delete process.env['CATALOG_SYNC_LOCAL_DIR']; else process.env['CATALOG_SYNC_LOCAL_DIR'] = previousDir
      })
    }

    /** App dedicado que resolve o provider pelo ambiente real (sem injeção). */
    async function buildEnvApp() {
      const envApp = buildApp({
        pool, logger: false, secureCookies: false, mediaStorageDir: storageDir,
        catalogRateLimits: { uploadPerMinute: 10_000, syncPerMinute: 10_000 },
      })
      await envApp.ready()
      return envApp
    }

    function envSyncRequest(envApp: Awaited<ReturnType<typeof buildApp>>) {
      return envApp.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: managerHeaders() })
    }

    it('reconcilia runs presas em running antigas e preserva runs recentes', async () => {
      const staleId = randomUUID()
      const recentId = randomUUID()
      await pool.query(
        `INSERT INTO catalog_sync_runs (id, status, started_by, started_at)
         VALUES ($1, 'running', $2, now() - interval '1 hour'),
                ($3, 'running', $2, now())`,
        [staleId, managerId, recentId],
      )
      const envApp = await buildEnvApp()
      try {
        await withEnv(undefined, undefined, async () => {
          const response = await envSyncRequest(envApp)
          expect(response.statusCode).toBe(200)
        })
      } finally {
        await envApp.close()
      }
      const runs = await pool.query<{ id: string; status: string; reason: string | null }>(
        `SELECT id, status, details->>'reason' AS reason FROM catalog_sync_runs WHERE id = ANY($1::uuid[])`,
        [[staleId, recentId]],
      )
      const byId = new Map(runs.rows.map((row) => [row.id, row]))
      expect(byId.get(staleId)).toMatchObject({ status: 'failed', reason: 'stale_reconciled' })
      expect(byId.get(recentId)).toMatchObject({ status: 'running', reason: null })
    })

    it('falha da reconciliação é best-effort: sync segue e run presa fica para a próxima passada', async () => {
      const staleId = randomUUID()
      await pool.query(
        `INSERT INTO catalog_sync_runs (id, status, started_by, started_at)
         VALUES ($1, 'running', $2, now() - interval '1 hour')`,
        [staleId, managerId],
      )
      const brokenReconciliationPool = {
        connect: pool.connect.bind(pool),
        query: (sql: unknown, ...rest: unknown[]) => {
          const text = String(sql)
          if (text.includes("'stale_reconciled'")) return Promise.reject(new Error('falha sintética de reconciliação'))
          return (pool.query as (...queryArgs: unknown[]) => Promise<unknown>)(sql, ...rest)
        },
      } as unknown as Pool
      const brokenApp = buildApp({
        pool: brokenReconciliationPool, logger: false, secureCookies: false, mediaStorageDir: storageDir,
        catalogRateLimits: { uploadPerMinute: 10_000, syncPerMinute: 10_000 },
      })
      await brokenApp.ready()
      try {
        await withEnv(undefined, undefined, async () => {
          const response = await brokenApp.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: managerHeaders() })
          expect(response.statusCode).toBe(200)
          expect(response.json()).toMatchObject({ status: 'not_configured', provider: 'none' })
          const runId = (response.json() as { runId: string }).runId
          const runs = await pool.query<{ id: string; status: string; reason: string | null }>(
            `SELECT id, status, details->>'reason' AS reason FROM catalog_sync_runs WHERE id = ANY($1::uuid[])`,
            [[staleId, runId]],
          )
          const byId = new Map(runs.rows.map((row) => [row.id, row]))
          expect(byId.get(runId)).toMatchObject({ status: 'failed', reason: 'provider_not_configured' })
          expect(byId.get(staleId)).toMatchObject({ status: 'running', reason: null })
        })
      } finally {
        await brokenApp.close()
      }
    })

    it('resolução real por ambiente: local sem diretório responde not_configured e registra run failed', async () => {
      const envApp = await buildEnvApp()
      try {
        await withEnv(undefined, undefined, async () => {
          const response = await envSyncRequest(envApp)
          expect(response.statusCode).toBe(200)
          expect(response.json()).toMatchObject({ status: 'not_configured', provider: 'none' })
          const runId = (response.json() as { runId: string }).runId
          const run = await pool.query(
            `SELECT status, details->>'reason' AS reason FROM catalog_sync_runs WHERE id = $1`, [runId],
          )
          expect(run.rows[0]).toMatchObject({ status: 'failed', reason: 'provider_not_configured' })
        })
      } finally {
        await envApp.close()
      }
    })

    it('resolução real por ambiente: diretório configurado inexistente falha de forma determinística', async () => {
      const envApp = await buildEnvApp()
      try {
        await withEnv('local', path.join(tmpdir(), `erp2-missing-${randomUUID()}`), async () => {
          const response = await envSyncRequest(envApp)
          expect(response.statusCode).toBe(200)
          expect(response.json()).toMatchObject({ status: 'failed', provider: 'local' })
          const runId = (response.json() as { runId: string }).runId
          const run = await pool.query(
            `SELECT status, details->>'reason' AS reason FROM catalog_sync_runs WHERE id = $1`, [runId],
          )
          expect(run.rows[0]).toMatchObject({ status: 'failed', reason: 'local_dir_missing' })
        })
      } finally {
        await envApp.close()
      }
    })

    it('resolução real por ambiente: diretório válido com imagens conclui a sincronização', async () => {
      const product = await createProduct('Env FC', 'Titular')
      const dir = await mkdtemp(path.join(tmpdir(), 'erp2-sync-env-'))
      await writeFile(path.join(dir, 'Env FC__Titular.png'), pngBytes)
      await writeFile(path.join(dir, 'leia-me.txt'), Buffer.from('ignore'))
      const envApp = await buildEnvApp()
      try {
        await withEnv('local', dir, async () => {
          const response = await envSyncRequest(envApp)
          expect(response.statusCode).toBe(200)
          expect(response.json()).toMatchObject({ status: 'completed', provider: 'local', itemCount: 1, errorCount: 0 })
          const media = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
          expect(media.rows[0]?.total).toBe(1)
        })
      } finally {
        await envApp.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('sync com pool de uma única conexão não trava e finaliza a run', async () => {
      const product = await createProduct('SingleConn FC', 'Titular')
      const singlePool = new Pool({ connectionString, max: 1, options: `-c search_path=${schema}` })
      const singleApp = buildApp({
        pool: singlePool, logger: false, secureCookies: false, mediaStorageDir: storageDir,
        catalogSyncProvider: () => ({
          name: 'fake',
          fetchManifest: async () => [
            { productKey: 'SingleConn FC__Titular', fileName: 't.png', mimeType: 'image/png', read: async () => pngBytes },
          ],
        }),
        catalogRateLimits: { uploadPerMinute: 10_000, syncPerMinute: 10_000 },
      })
      await singleApp.ready()
      try {
        const response = await singleApp.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: managerHeaders() })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ status: 'completed', itemCount: 1, errorCount: 0 })
        const runId = (response.json() as { runId: string }).runId
        const run = await pool.query(`SELECT status FROM catalog_sync_runs WHERE id = $1`, [runId])
        expect(run.rows[0]).toMatchObject({ status: 'completed' })
        const media = await pool.query('SELECT count(*)::int AS total FROM media WHERE product_id = $1', [product.id])
        expect(media.rows[0]?.total).toBe(1)
      } finally {
        await singleApp.close()
        await singlePool.end()
      }
    }, 20_000)

    it('falha na finalização responde 500 e a run não fica presa em running', async () => {
      await createProduct('Finalize FC', 'Titular')
      providerHolder.current = {
        name: 'fake',
        fetchManifest: async () => [
          { productKey: 'Finalize FC__Titular', fileName: 't.png', mimeType: 'image/png', read: async () => pngBytes },
        ],
      }
      const failApp = buildApp({
        pool: failingFinalizationPool(pool), logger: false, secureCookies: false, mediaStorageDir: storageDir,
        catalogRateLimits: { uploadPerMinute: 10_000, syncPerMinute: 10_000 },
      })
      await failApp.ready()
      try {
        const response = await failApp.inject({ method: 'POST', url: '/catalog/sync', payload: {}, headers: managerHeaders() })
        expect(response.statusCode).toBe(500)
        expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR' })
        const runs = await pool.query(
          `SELECT status, details->>'reason' AS reason FROM catalog_sync_runs WHERE details->>'reason' = 'finalization_failed'`,
        )
        expect(runs.rows).toHaveLength(1)
        expect(runs.rows[0]).toMatchObject({ status: 'failed', reason: 'finalization_failed' })
      } finally {
        await failApp.close()
      }
    })
  })
})
