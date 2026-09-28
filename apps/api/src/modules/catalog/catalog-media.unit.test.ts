import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createLocalMediaStorage } from './media-storage.js'
import { sanitizeFileName, sniffImageMime, validateImage } from './validation.js'
import {
  DriveCatalogSyncProvider,
  LocalDirectoryCatalogSyncProvider,
  catalogSyncProviderFromEnv,
} from './sync-provider.js'

const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])])
const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR'), Buffer.alloc(64, 0x22), Buffer.from('IEND'),
])
const webpBytes = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(24, 0x33),
])

const storageRoots: string[] = []

async function makeStorageRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'erp2-media-'))
  storageRoots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(storageRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('armazenamento local de mídia', () => {
  it('grava atomicamente sem deixar temporários e lê o mesmo conteúdo', async () => {
    const root = await makeStorageRoot()
    const storage = createLocalMediaStorage(root)
    const key = '0f0e0d0c-1111-4222-8333-444455556666'

    await storage.write(key, pngBytes)

    expect(await readFile(path.join(root, key))).toEqual(pngBytes)
    const entries = await readdir(root)
    expect(entries).toEqual([key])
    expect((await storage.stat(key)).size).toBe(pngBytes.length)
    expect(await storage.exists(key)).toBe(true)
    const readable = await storage.readStream(key)
    const chunks: Buffer[] = []
    for await (const chunk of readable.stream) chunks.push(Buffer.from(chunk as Uint8Array))
    expect(Buffer.concat(chunks)).toEqual(pngBytes)
  })

  it('falha na gravação não deixa temporário nem arquivo final (renomeia sobre diretório existente)', async () => {
    const root = await makeStorageRoot()
    const storage = createLocalMediaStorage(root)
    const key = 'aa0e0d0c-1111-4222-8333-444455556666'
    await mkdir(path.join(root, key))

    await expect(storage.write(key, pngBytes)).rejects.toThrow()
    expect(await readdir(root)).toEqual([key])
  })

  it('rejeita chaves que não são uuid opaco, incluindo traversal', async () => {
    const root = await makeStorageRoot()
    const storage = createLocalMediaStorage(root)
    for (const key of ['../../etc/passwd', 'a/b', 'a\\b', '..', '', '.hidden', '00000000-0000-0000-0000-000000000000/extra']) {
      await expect(storage.write(key, pngBytes)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
      await expect(storage.stat(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
      await expect(storage.exists(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
      await expect(storage.remove(key)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
    }
    expect(await readdir(root)).toEqual([])
  })

  it('remove o arquivo e reporta ausência sem erro', async () => {
    const root = await makeStorageRoot()
    const storage = createLocalMediaStorage(root)
    const key = 'bb0e0d0c-1111-4222-8333-444455556666'
    await storage.write(key, jpegBytes)
    await storage.remove(key)
    expect(await storage.exists(key)).toBe(false)
    await storage.remove(key)
  })

  it('stat/readStream de arquivo ausente falha com MEDIA_FILE_MISSING', async () => {
    const root = await makeStorageRoot()
    const storage = createLocalMediaStorage(root)
    const key = 'cc0e0d0c-1111-4222-8333-444455556666'
    await expect(storage.stat(key)).rejects.toMatchObject({ code: 'MEDIA_FILE_MISSING' })
    await expect(storage.readStream(key)).rejects.toMatchObject({ code: 'MEDIA_FILE_MISSING' })
  })
})

describe('validação de imagem enviada', () => {
  it('reconhece assinaturas JPEG, PNG e WebP pelos bytes', () => {
    expect(sniffImageMime(jpegBytes)).toBe('image/jpeg')
    expect(sniffImageMime(pngBytes)).toBe('image/png')
    expect(sniffImageMime(webpBytes)).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeNull()
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull()
  })

  it('aceita quando extensão, MIME declarado e conteúdo coincidem', () => {
    expect(validateImage({ bytes: pngBytes, declaredMimeType: 'image/png', fileName: 'flamengo.png' })).toEqual({ ok: true, mimeType: 'image/png' })
    expect(validateImage({ bytes: jpegBytes, declaredMimeType: 'image/jpeg', fileName: 'flamengo.JPG' })).toEqual({ ok: true, mimeType: 'image/jpeg' })
    expect(validateImage({ bytes: webpBytes, declaredMimeType: 'image/webp', fileName: 'flamengo.webp' })).toEqual({ ok: true, mimeType: 'image/webp' })
  })

  it('rejeita MIME não suportado mesmo com conteúdo válido', () => {
    expect(validateImage({ bytes: pngBytes, declaredMimeType: 'image/gif', fileName: 'x.png' }))
      .toEqual({ ok: false, code: 'IMAGE_TYPE_NOT_SUPPORTED' })
  })

  it('rejeita extensão ausente ou divergente do MIME declarado', () => {
    expect(validateImage({ bytes: pngBytes, declaredMimeType: 'image/png', fileName: 'sem-extensao' }))
      .toEqual({ ok: false, code: 'IMAGE_EXTENSION_MISMATCH' })
    expect(validateImage({ bytes: pngBytes, declaredMimeType: 'image/png', fileName: 'x.jpg' }))
      .toEqual({ ok: false, code: 'IMAGE_EXTENSION_MISMATCH' })
  })

  it('rejeita conteúdo cujos magic bytes divergem do MIME declarado', () => {
    expect(validateImage({ bytes: pngBytes, declaredMimeType: 'image/jpeg', fileName: 'x.jpg' }))
      .toEqual({ ok: false, code: 'IMAGE_CONTENT_INVALID' })
    expect(validateImage({ bytes: Buffer.from('<script>'), declaredMimeType: 'image/png', fileName: 'x.png' }))
      .toEqual({ ok: false, code: 'IMAGE_CONTENT_INVALID' })
  })

  it('rejeita arquivo vazio e acima de 5 MiB', () => {
    expect(validateImage({ bytes: Buffer.alloc(0), declaredMimeType: 'image/png', fileName: 'x.png' }))
      .toEqual({ ok: false, code: 'IMAGE_EMPTY' })
    expect(validateImage({ bytes: Buffer.concat([pngBytes, Buffer.alloc(5_242_881)]), declaredMimeType: 'image/png', fileName: 'x.png' }))
      .toEqual({ ok: false, code: 'IMAGE_TOO_LARGE' })
  })

  it('sanitiza nome original para cabeçalho sem injetar caracteres', () => {
    expect(sanitizeFileName('foto da torcida (1).png')).toBe('foto da torcida (1).png')
    expect(sanitizeFileName('ru"im\nagem.png')).not.toMatch(/["\r\n]/)
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/')
    expect(sanitizeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(100)
    expect(sanitizeFileName('')).toBe('imagem')
    expect(sanitizeFileName('***')).toBe('imagem')
  })
})

describe('provedores de sincronização de catálogo', () => {
  it('provedor de diretório local monta manifest com chave clube__modelo e ignora não imagens', async () => {
    const dir = await makeStorageRoot()
    await writeFile(path.join(dir, 'Flamengo__Home 24.png'), pngBytes)
    await writeFile(path.join(dir, 'brasil__Away.JPG'), jpegBytes)
    await writeFile(path.join(dir, 'leia-me.txt'), Buffer.from('ignore'))
    await mkdir(path.join(dir, 'subdir'))
    await writeFile(path.join(dir, 'subdir', 'x.png'), pngBytes)

    const provider = new LocalDirectoryCatalogSyncProvider(dir)
    expect(provider.name).toBe('local')
    const manifest = await provider.fetchManifest()
    expect(manifest).toHaveLength(2)
    const flamengo = manifest.find((item) => item.productKey === 'Flamengo__Home 24')
    expect(flamengo).toMatchObject({ fileName: 'Flamengo__Home 24.png', mimeType: 'image/png' })
    expect(await flamengo!.read()).toEqual(pngBytes)
    const brasil = manifest.find((item) => item.productKey === 'brasil__Away')
    expect(brasil).toMatchObject({ mimeType: 'image/jpeg' })
  })

  it('provedor local sem diretório configurado falha de forma controlada (provider_not_configured)', async () => {
    const provider = new LocalDirectoryCatalogSyncProvider(undefined)
    await expect(provider.fetchManifest()).rejects.toMatchObject({ code: 'provider_not_configured' })
  })

  it('provedor local com diretório configurado inexistente falha de forma determinística (local_dir_missing)', async () => {
    const dir = await makeStorageRoot()
    const provider = new LocalDirectoryCatalogSyncProvider(path.join(dir, 'nao-existe'))
    await expect(provider.fetchManifest()).rejects.toMatchObject({ code: 'local_dir_missing' })
  })

  it('adaptador Google Drive sem ambiente necessário falha de forma controlada, sem credencial', async () => {
    const provider = new DriveCatalogSyncProvider({})
    await expect(provider.fetchManifest()).rejects.toMatchObject({ code: 'provider_not_configured' })
  })

  it('adaptador Google Drive configurado monta manifest sem chamada externa real (fetch simulado)', async () => {
    const env = { CATALOG_SYNC_DRIVE_FOLDER_ID: 'folder-123', CATALOG_SYNC_DRIVE_ACCESS_TOKEN: 'token-sintetico' }
    const provider = new DriveCatalogSyncProvider(env)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [
        { id: 'file-1', name: 'Flamengo__Home.png', mimeType: 'image/png' },
        { id: 'file-2', name: 'sem-chave-valida.png', mimeType: 'image/png' },
      ] }), { status: 200 }))
      .mockImplementation(async () => new Response(pngBytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const manifest = await provider.fetchManifest()
      expect(manifest).toHaveLength(2)
      expect(manifest[0]).toMatchObject({ productKey: 'Flamengo__Home', fileName: 'Flamengo__Home.png', mimeType: 'image/png' })
      expect(await manifest[0]!.read()).toEqual(pngBytes)
      const [listCall, downloadCall] = fetchMock.mock.calls
      expect(String(listCall![0])).toContain('https://www.googleapis.com/drive/v3/files')
      expect(String(listCall![0])).toContain("q=%27folder-123%27+in+parents")
      expect((listCall![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer token-sintetico' })
      expect(String(downloadCall![0])).toContain('https://www.googleapis.com/drive/v3/files/file-1?alt=media')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('seleção de provedor por ambiente: local sem diretório não configura provedor, drive quando configurado, desconhecido sem provedor', () => {
    expect(catalogSyncProviderFromEnv({})).toBeUndefined()
    expect(catalogSyncProviderFromEnv({ CATALOG_SYNC_PROVIDER: 'local' })).toBeUndefined()
    expect(catalogSyncProviderFromEnv({ CATALOG_SYNC_PROVIDER: 'local', CATALOG_SYNC_LOCAL_DIR: '/tmp/x' })?.name).toBe('local')
    expect(catalogSyncProviderFromEnv({ CATALOG_SYNC_PROVIDER: 'drive', CATALOG_SYNC_DRIVE_FOLDER_ID: 'f', CATALOG_SYNC_DRIVE_ACCESS_TOKEN: 't' })?.name).toBe('google-drive')
    expect(catalogSyncProviderFromEnv({ CATALOG_SYNC_PROVIDER: 'ftp' })).toBeUndefined()
  })
})
