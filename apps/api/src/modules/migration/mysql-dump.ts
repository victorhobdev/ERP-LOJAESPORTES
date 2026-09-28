/**
 * Parser de dump MySQL (formato mysqldump --no-create-db) para linhas estruturadas.
 * Extrai colunas dos CREATE TABLE e tuplas dos INSERT, sem executar SQL e sem
 * conectar em MySQL — o dump é tratado somente como arquivo de leitura.
 */
export type MysqlDumpTable = {
  name: string
  columns: string[]
  rows: Array<Record<string, string | number | null>>
}

export function parseMysqlDump(sql: string): MysqlDumpTable[] {
  const tables = new Map<string, MysqlDumpTable>()
  for (const match of sql.matchAll(/CREATE TABLE `(\w+)` \(([\s\S]*?)\n\)[^;]*;/g)) {
    const name = match[1]!
    const columns = extractColumns(match[2]!)
    tables.set(name, { name, columns, rows: [] })
  }
  for (const match of sql.matchAll(/INSERT INTO `(\w+)` VALUES ([\s\S]*?);\r?\n/g)) {
    const table = tables.get(match[1]!)
    if (!table) continue
    for (const tuple of splitTuples(match[2]!)) {
      table.rows.push(zipRow(table.columns, tuple))
    }
  }
  return [...tables.values()]
}

function extractColumns(body: string): string[] {
  const columns: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const match = /^`(\w+)` /.exec(trimmed)
    if (match) columns.push(match[1]!)
  }
  return columns
}

function zipRow(columns: string[], tuple: Array<string | number | null>): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {}
  for (const [index, column] of columns.entries()) row[column] = tuple[index] ?? null
  return row
}

/** Divide a lista de valores em tuplas `(a,b),(c,d)` respeitando strings escapadas. */
function splitTuples(values: string): Array<Array<string | number | null>> {
  const tuples: Array<Array<string | number | null>> = []
  let depth = 0
  let inString = false
  let escaped = false
  let current = ''
  let tuple: Array<string | number | null> = []
  for (const char of values) {
    if (escaped) {
      escaped = false
      current += char
      continue
    }
    if (inString) {
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === "'") {
        inString = false
        continue
      }
      current += char
      continue
    }
    if (char === "'") {
      inString = true
      continue
    }
    if (char === '(') {
      depth = 1
      tuple = []
      current = ''
      continue
    }
    if (char === ',') {
      tuple.push(coerce(current.trim()))
      current = ''
      continue
    }
    if (char === ')') {
      tuple.push(coerce(current.trim()))
      tuples.push(tuple)
      depth = 0
      current = ''
      continue
    }
    if (depth > 0) current += char
  }
  return tuples
}

function coerce(raw: string): string | number | null {
  if (raw === 'NULL') return null
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  return raw
}

/**
 * Converte uma data/datetime legado (`YYYY-MM-DD[ HH:MM:SS]`) em datetime ISO com
 * offset neutro; o legado não carrega fuso e o PC da loja opera em America/Sao_Paulo.
 */
export function legacyTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/.exec(String(value))
  if (!match) return null
  return `${match[1]}T${match[2] ?? '12:00:00'}.000Z`
}
