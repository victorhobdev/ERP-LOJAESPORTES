import { Pool } from 'pg'

import { buildApp } from './app.js'
import { applyMigrations } from './shared/db/migrate.js'

const port = Number(process.env['PORT'] ?? 3333)
const host = process.env['HOST'] ?? '127.0.0.1'
const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

const pool = new Pool({ connectionString: databaseUrl, max: 10 })
await applyMigrations(pool)

const app = buildApp({
  allowedOrigins: (process.env['CORS_ORIGINS'] ?? 'http://127.0.0.1:5173').split(',').map((origin) => origin.trim()),
  logger: {
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  },
  pool,
  secureCookies: process.env['NODE_ENV'] === 'production',
})
app.addHook('onClose', async () => pool.end())

try {
  await app.listen({ host, port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
