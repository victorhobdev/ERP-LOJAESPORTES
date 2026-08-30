import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'

const defaultMigrationsDirectory = fileURLToPath(new URL('../../../migrations/', import.meta.url))

export async function applyMigrations(pool: Pool, directory = defaultMigrationsDirectory) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort()
  const applied: string[] = []

  for (const filename of filenames) {
    const sql = await readFile(`${directory}/${filename}`, 'utf8')
    const checksum = createHash('sha256').update(sql, 'utf8').digest('hex')
    const existing = await pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE filename = $1',
      [filename],
    )

    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration checksum mismatch: ${filename}`)
      }
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      )
      await client.query('COMMIT')
      applied.push(filename)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return { applied }
}
