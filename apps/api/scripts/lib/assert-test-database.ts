import { Pool } from 'pg'

export async function assertTestDatabaseUrl(databaseUrl: string): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    const result = await pool.query<{ name: string }>('SELECT current_database() AS name')
    const name = result.rows[0]?.name ?? ''
    if (!/_test$/.test(name)) {
      throw new Error(`Refusing to touch database "${name}": expected an explicit test database name ending in "_test".`)
    }
    return name
  } finally {
    await pool.end()
  }
}
