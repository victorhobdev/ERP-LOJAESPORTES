import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import sharp from 'sharp'
import { attachImageToProduct } from '../src/modules/catalog/routes.js'
import { createLocalMediaStorage } from '../src/modules/catalog/media-storage.js'
import { sniffImageMime, validateImage } from '../src/modules/catalog/validation.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const connectionString = process.env['DATABASE_URL']
const storageDir = process.env['MEDIA_STORAGE_DIR']
if (!connectionString || !storageDir) throw new Error('DATABASE_URL e MEDIA_STORAGE_DIR obrigatorios')
await assertTestDatabaseUrl(connectionString)
const base = path.resolve(process.argv[2] ?? path.join(process.env['LOCALAPPDATA'] ?? '', 'ERP 2.0', 'data', 'catalogo'))
const decode = (s: string) => s.replace(/\\u([0-9a-f]{4})|\\(.)/gi, (_, hex: string | undefined, char: string) => hex ? String.fromCharCode(parseInt(hex, 16)) : char)
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()
const entries = (await readFile(path.join(base, 'imagens.properties'), 'latin1')).split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#')).map((line) => {
    const separator = line.indexOf('=')
    const [club = '', model = '', type = ''] = decode(line.slice(0, separator)).split('|')
    return { key: normalize(club) + '|' + normalize(model), type, file: decode(line.slice(separator + 1)) }
  }).sort((a, b) => Number(b.type === 'MASCULINO') - Number(a.type === 'MASCULINO'))
const pool = new Pool({ connectionString, max: 2 })
try {
  const actor = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'vitinho.local'")
  if (!actor.rows[0]) throw new Error('Execute prepare-local primeiro')
  const products = await pool.query<{ id: string; club: string; model: string }>('SELECT id, club, model FROM products ORDER BY club, model')
  const report = { imported: 0, reused: 0, missing: [] as string[] }
  const storage = createLocalMediaStorage(storageDir)
  for (const product of products.rows) {
    const entry = entries.find((candidate) => candidate.key === normalize(product.club) + '|' + normalize(product.model))
    if (!entry) { report.missing.push(product.club + ' ' + product.model); continue }
    if (path.basename(entry.file) !== entry.file) throw new Error('Caminho de imagem invalido')
    let bytes = await readFile(path.join(base, 'imagens', entry.file))
    let fileName = entry.file
    if (bytes.length > 5_242_880) {
      bytes = await sharp(bytes).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
      fileName = path.parse(entry.file).name + '.jpg'
    }
    const mimeType = sniffImageMime(bytes) ?? ''
    const validation = validateImage({ bytes, declaredMimeType: mimeType, fileName })
    if (!validation.ok) throw new Error(`${entry.file}: ${validation.code}`)
    const result = await attachImageToProduct(pool, storage, {
      productId: product.id, bytes, mimeType, fileName, userId: actor.rows[0].id,
      requestId: 'legacy-image-import', auditAction: 'catalog.legacy_image.import',
    })
    if (result.body['deduplicated']) report.reused++; else report.imported++
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await pool.end() }
