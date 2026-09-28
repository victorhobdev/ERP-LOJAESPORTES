import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { hashPassword } from '../src/shared/auth/password.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL obrigatoria.')
await assertTestDatabaseUrl(connectionString)
const pool = new Pool({ connectionString, max: 1 })
try {
  const existing = await pool.query("SELECT id FROM users WHERE username = 'vitinho.local'")
  if (existing.rowCount) {
    console.log('Login de homologação existente: vitinho.local (senha preservada).')
  } else {
    const password = randomBytes(12).toString('base64url') + '!a1'
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'vitinho.local', 'Vitinho — homologação', $2, '00000000-0000-4000-8000-000000000004')`,
      [randomUUID(), await hashPassword(password)],
    )
    console.log(`Login de homologação: vitinho.local\nSenha inicial: ${password}`)
  }
} finally {
  await pool.end()
}
