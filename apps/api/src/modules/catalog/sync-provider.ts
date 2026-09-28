import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

export type CatalogSyncManifestItem = {
  /** Chave de negocio do produto logico: `Clube__Modelo`. */
  productKey: string
  fileName: string
  mimeType: string
  read: () => Promise<Buffer>
}

export type CatalogSyncProvider = {
  readonly name: string
  fetchManifest: () => Promise<CatalogSyncManifestItem[]>
}

const localFilePattern = /^(.+)__(.+)\.(jpe?g|png|webp)$/i

const mimeTypeByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

type ProviderError = Error & { code?: string }

/**
 * Provider local: imagens depositadas em um diretorio do PC, com nome
 * `Clube__Modelo.ext`. Nao depende de rede e nao e fonte primaria do cadastro;
 * produto nao encontrado vira erro de item, nunca falha de execucao.
 */
export class LocalDirectoryCatalogSyncProvider implements CatalogSyncProvider {
  readonly name = 'local'

  constructor(private readonly dir: string | undefined) {}

  async fetchManifest(): Promise<CatalogSyncManifestItem[]> {
    if (!this.dir) {
      const unconfigured: ProviderError = new Error('Diretório local de sincronização não configurado (CATALOG_SYNC_LOCAL_DIR).')
      unconfigured.code = 'provider_not_configured'
      throw unconfigured
    }
    let entries: Dirent[]
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const missing: ProviderError = new Error('Diretório local de sincronização configurado não existe.')
        missing.code = 'local_dir_missing'
        throw missing
      }
      throw error
    }
    return entries
      .filter((entry) => entry.isFile() && localFilePattern.test(entry.name))
      .map((entry) => {
        const match = localFilePattern.exec(entry.name)!
        return {
          productKey: `${match[1]}__${match[2]}`,
          fileName: entry.name,
          mimeType: mimeTypeByExtension[match[3]!.toLowerCase()]!,
          read: async () => {
            const { readFile } = await import('node:fs/promises')
            return readFile(path.join(this.dir!, entry.name))
          },
        }
      })
  }
}

/**
 * Adapter isolado do Google Drive. As credenciais chegam exclusivamente por
 * ambiente; nenhum valor real vive no codigo. Sem ambiente obrigatorio, a
 * falha e controlada (`provider_not_configured`) e o run e registrado como
 * `failed` sem afetar vendas, estoque ou leitura local.
 */
export class DriveCatalogSyncProvider implements CatalogSyncProvider {
  readonly name = 'google-drive'

  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async fetchManifest(): Promise<CatalogSyncManifestItem[]> {
    const folderId = this.env['CATALOG_SYNC_DRIVE_FOLDER_ID']
    const accessToken = this.env['CATALOG_SYNC_DRIVE_ACCESS_TOKEN']
    if (!folderId || !accessToken) {
      const error: ProviderError = new Error('Provedor Google Drive não configurado.')
      error.code = 'provider_not_configured'
      throw error
    }
    const listUrl = new URL('https://www.googleapis.com/drive/v3/files')
    listUrl.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`)
    listUrl.searchParams.set('fields', 'files(id,name,mimeType)')
    listUrl.searchParams.set('pageSize', '200')
    const listResponse = await fetch(listUrl, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!listResponse.ok) {
      const error: ProviderError = new Error('Provedor Google Drive indisponível.')
      error.code = 'provider_unavailable'
      throw error
    }
    const payload = await listResponse.json() as { files?: Array<{ id: string; name: string; mimeType: string }> }
    const files = Array.isArray(payload.files) ? payload.files : []
    return files
      .filter((file) => typeof file.id === 'string' && typeof file.name === 'string')
      .map((file) => ({
        productKey: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        mimeType: file.mimeType,
        read: async () => {
          const downloadUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`)
          downloadUrl.searchParams.set('alt', 'media')
          const downloadResponse = await fetch(downloadUrl, { headers: { authorization: `Bearer ${accessToken}` } })
          if (!downloadResponse.ok) {
            const error: ProviderError = new Error('Provedor Google Drive indisponível.')
            error.code = 'provider_unavailable'
            throw error
          }
          const declaredLength = Number(downloadResponse.headers.get('content-length') ?? '0')
          if (Number.isFinite(declaredLength) && declaredLength > 5_242_880) {
            const error: ProviderError = new Error('Imagem excede o limite permitido.')
            error.code = 'image_too_large'
            throw error
          }
          return Buffer.from(await downloadResponse.arrayBuffer())
        },
      }))
  }
}

export function catalogSyncProviderFromEnv(env: Record<string, string | undefined> = process.env): CatalogSyncProvider | undefined {
  const value = env['CATALOG_SYNC_PROVIDER'] ?? 'local'
  if (value === 'local') {
    // Sem diretório local configurado não há provedor utilizável: o sync responde
    // not_configured e registra run failed, em vez de concluir "com sucesso" vazio.
    if (!env['CATALOG_SYNC_LOCAL_DIR']) return undefined
    return new LocalDirectoryCatalogSyncProvider(env['CATALOG_SYNC_LOCAL_DIR'])
  }
  if (value === 'drive') return new DriveCatalogSyncProvider(env)
  return undefined
}
