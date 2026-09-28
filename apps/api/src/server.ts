import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Pool } from 'pg'

import { buildApp } from './app.js'
import type {
  CatalogPublishPreviewItem,
  CatalogPublishProgress,
  CatalogPublishResult,
  CatalogPublisher,
} from './modules/catalog/routes.js'
import { applyMigrations } from './shared/db/migrate.js'

const execFileAsync = promisify(execFile)

const port = Number(process.env['PORT'] ?? 3333)
const host = process.env['HOST'] ?? '127.0.0.1'
const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) throw new Error('DATABASE_URL is required.')
const mediaStorageDir = process.env['MEDIA_STORAGE_DIR']
if (!mediaStorageDir) throw new Error('MEDIA_STORAGE_DIR is required.')
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))

const catalogSyncScript = path.join(projectRoot, 'scripts', 'sync-catalog-drive.ps1')
const catalogSyncEnvironment = {
  ...process.env,
  CATALOG_SYNC_DATABASE_URL: databaseUrl,
  CATALOG_SYNC_MEDIA_STORAGE_DIR: mediaStorageDir,
}

function catalogSyncArgs(...args: string[]) {
  return ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', catalogSyncScript, ...args]
}

function decodeCatalogField(value: string | undefined): string {
  return value ? Buffer.from(value, 'base64url').toString('utf8') : ''
}

async function previewCatalogDrive(): Promise<{ items: CatalogPublishPreviewItem[] }> {
  const { stdout } = await execFileAsync('powershell.exe', catalogSyncArgs('--preview'), {
    cwd: projectRoot,
    encoding: 'utf8',
    env: catalogSyncEnvironment,
    maxBuffer: 1_048_576,
    timeout: 5 * 60_000,
    windowsHide: true,
  })
  const validStatuses = new Set<CatalogPublishPreviewItem['status']>(['OK', 'DESATUALIZADO', 'SEM_IMAGEM', 'ORFAO'])
  const items = stdout.split(/\r?\n/).flatMap((line): CatalogPublishPreviewItem[] => {
    if (!line.startsWith('catalog_preview_item ')) return []
    const fields = Object.fromEntries(line.slice('catalog_preview_item '.length).split(' ').map((field) => {
      const separator = field.indexOf('=')
      return separator < 0 ? [field, ''] : [field.slice(0, separator), field.slice(separator + 1)]
    }))
    const status = fields['status'] as CatalogPublishPreviewItem['status'] | undefined
    if (!status || !validStatuses.has(status)) throw new Error('O sincronizador retornou um estado de catálogo inválido.')
    return [{
      productName: decodeCatalogField(fields['name_b64']),
      club: decodeCatalogField(fields['club_b64']),
      model: decodeCatalogField(fields['model_b64']),
      type: decodeCatalogField(fields['type_b64']),
      sizes: decodeCatalogField(fields['sizes_b64']),
      status,
      hasLocalImage: fields['has_local_image'] === 'true',
    }]
  })
  if (!/catalog_preview_done count=\d+/.test(stdout)) throw new Error('O sincronizador não retornou uma prévia válida.')
  return { items }
}

function publishCatalogToDrive(onProgress: (progress: CatalogPublishProgress) => void): Promise<CatalogPublishResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', catalogSyncArgs(), {
      cwd: projectRoot,
      env: catalogSyncEnvironment,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    const errors: string[] = []
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      settled = true
      reject(new Error('A sincronização excedeu o limite de 15 minutos.'))
    }, 15 * 60_000)

    const consumeStdoutLine = (line: string) => {
      const progress = /catalog_progress current=(\d+) total=(\d+) message_b64=(\S*)/.exec(line)
      if (progress) {
        onProgress({
          current: Number(progress[1]),
          total: Number(progress[2]),
          message: decodeCatalogField(progress[3]),
        })
      }
    }
    const consumeStderrLine = (line: string) => {
      if (line.startsWith('catalog_sync_error=')) errors.push(line.slice('catalog_sync_error='.length))
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      lines.forEach(consumeStdoutLine)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      chunk.split(/\r?\n/).forEach(consumeStderrLine)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (stdoutBuffer) consumeStdoutLine(stdoutBuffer)
      const summary = /catalog_sync source=postgres created=(\d+) updated=(\d+) removed=(\d+) pending_without_image=(\d+) errors=(\d+)/.exec(stdout)
      if (!summary || (code !== 0 && code !== 2)) {
        reject(new Error(stderr.trim() || 'O sincronizador não retornou um resumo válido.'))
        return
      }
      const errorCount = Number(summary[5])
      resolve({
        status: errorCount === 0 ? 'completed' : 'partial',
        created: Number(summary[1]),
        updated: Number(summary[2]),
        removed: Number(summary[3]),
        pendingWithoutImage: Number(summary[4]),
        errors,
      })
    })
  })
}

const catalogPublisher: CatalogPublisher = { preview: previewCatalogDrive, publish: publishCatalogToDrive }

const pool = new Pool({ connectionString: databaseUrl, max: 10 })
await applyMigrations(pool)

const app = buildApp({
  allowedOrigins: (process.env['CORS_ORIGINS'] ?? 'http://127.0.0.1:5173').split(',').map((origin) => origin.trim()),
  logger: {
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  },
  pool,
  secureCookies: process.env['NODE_ENV'] === 'production',
  authenticationDisabled: true,
  mediaStorageDir,
  catalogPublisher,
})
app.addHook('onClose', async () => pool.end())

try {
  await app.listen({ host, port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
