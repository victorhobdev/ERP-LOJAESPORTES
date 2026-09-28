import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

await assertTestDatabaseUrl(databaseUrl)
await import('../src/server.js')
