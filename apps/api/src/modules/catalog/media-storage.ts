import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

export class MediaStorageError extends Error {
  constructor(public readonly code: 'INVALID_STORAGE_KEY' | 'MEDIA_FILE_MISSING', message: string) {
    super(message)
    this.name = 'MediaStorageError'
  }
}

export type MediaFile = {
  stream: Readable
  size: number
}

export type MediaStorage = {
  write(key: string, bytes: Buffer): Promise<void>
  stat(key: string): Promise<{ size: number }>
  readStream(key: string): Promise<MediaFile>
  exists(key: string): Promise<boolean>
  remove(key: string): Promise<void>
}

const storageKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidStorageKey(key: string): boolean {
  return storageKeyPattern.test(key)
}

/**
 * Chave opaca: somente uuid gerado pelo servidor. O caminho absoluto nunca
 * deriva de entrada do cliente e a resolucao falha para qualquer chave fora
 * do padrao, impedindo traversal mesmo que um valor ruim chegue ao banco.
 */
export function createLocalMediaStorage(rootDir: string): MediaStorage {
  const root = path.resolve(rootDir)

  function resolveKey(key: string): string {
    if (!isValidStorageKey(key)) {
      throw new MediaStorageError('INVALID_STORAGE_KEY', 'Chave de armazenamento inválida.')
    }
    const resolved = path.resolve(root, key)
    if (!resolved.startsWith(root + path.sep)) {
      throw new MediaStorageError('INVALID_STORAGE_KEY', 'Chave de armazenamento inválida.')
    }
    return resolved
  }

  return {
    async write(key, bytes) {
      const finalPath = resolveKey(key)
      await mkdir(root, { recursive: true })
      const tempPath = path.join(root, `.${key}.${randomUUID()}.tmp`)
      const handle = await open(tempPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(tempPath, finalPath)
      } catch (error) {
        await rm(tempPath, { force: true })
        throw error
      }
    },

    async stat(key) {
      const finalPath = resolveKey(key)
      try {
        const info = await stat(finalPath)
        if (!info.isFile()) throw new Error('not a file')
        return { size: info.size }
      } catch {
        throw new MediaStorageError('MEDIA_FILE_MISSING', 'Arquivo de mídia não encontrado.')
      }
    },

    async readStream(key) {
      const finalPath = resolveKey(key)
      try {
        const info = await stat(finalPath)
        if (!info.isFile()) throw new Error('not a file')
        return { stream: createReadStream(finalPath), size: info.size }
      } catch {
        throw new MediaStorageError('MEDIA_FILE_MISSING', 'Arquivo de mídia não encontrado.')
      }
    },

    async exists(key) {
      const finalPath = resolveKey(key)
      try {
        const info = await stat(finalPath)
        return info.isFile()
      } catch {
        return false
      }
    },

    async remove(key) {
      const finalPath = resolveKey(key)
      await unlink(finalPath).catch(() => undefined)
    },
  }
}
