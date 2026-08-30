import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyMigrations } from './migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('PostgreSQL server integration', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  let pool: Pool

  beforeAll(async () => {
    const result = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (result.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
  })

  afterAll(async () => {
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('applies each migration once and records its checksum', async () => {
    const first = await applyMigrations(pool)
    const second = await applyMigrations(pool)

    expect(first.applied).toContain('001_initial.sql')
    expect(second.applied).toEqual([])
    const result = await pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    )
    expect(result.rows).toEqual([
      { filename: '001_initial.sql', checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ])
  }, 30_000)

  it('rolls back partial writes in a real transaction', async () => {
    const client = await pool.connect()
    const productId = randomUUID()

    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Rollback FC', 'Teste'])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    const result = await pool.query<{ count: string }>('SELECT count(*) FROM products WHERE id = $1', [productId])
    expect(result.rows[0]?.count).toBe('0')
  })
})
