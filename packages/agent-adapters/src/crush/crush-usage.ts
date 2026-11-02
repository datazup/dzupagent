/**
 * Token usage and cost of one Crush run, read from the run's private database.
 *
 * `crush run` prints only assistant text. It records each session's
 * `prompt_tokens`, `completion_tokens` and `cost` (USD) in `crush.db` inside
 * the `--data-dir` the adapter projects for the run, which exists until the
 * run is cleaned up. The reader is Node's built-in `node:sqlite`, loaded
 * without an import so the package keeps working on runtimes that lack it:
 * there, and on any read failure, usage is simply absent.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { TokenUsage } from '../types.js'

/** The slice of `node:sqlite` this reader uses (the package's Node typings predate it). */
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(): Record<string, unknown> | undefined }
    close(): void
  }
}

// Validate each measurement before aggregation: SUM ignores NULL and coerces text,
// and a positive total alone cannot reveal a negative session hidden in the sum.
const USAGE_SQL = `SELECT COUNT(*) AS sessions, ${[
  ['prompt_tokens', 'input'],
  ['completion_tokens', 'output'],
  ['cost', 'cost'],
].map(([column, alias]) => {
  const valid = `typeof(${column}) IN ('integer', 'real') AND ${column} >= 0 AND ${column} <= 1.7976931348623157e308`
  return `SUM(CASE WHEN ${valid} THEN 1 ELSE 0 END) AS ${alias}_count, `
    + `SUM(CASE WHEN ${valid} THEN CAST(${column} AS REAL) END) AS ${alias}`
}).join(', ')} FROM sessions`

function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function loadSqlite(): SqliteModule | undefined {
  try {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const loaded = typeof getBuiltinModule === 'function' ? getBuiltinModule('node:sqlite') : undefined
    return loaded && typeof (loaded as Partial<SqliteModule>).DatabaseSync === 'function'
      ? loaded as SqliteModule
      : undefined
  } catch {
    return undefined
  }
}

/** Whether this runtime can read a Crush run's usage at all. */
export function isCrushUsageReaderAvailable(): boolean {
  return loadSqlite() !== undefined
}

/**
 * Sum usage over every session in `<dataDir>/crush.db` (the main session plus
 * any title or sub-agent sessions, all of which were billed). Returns
 * `undefined` when the reader, database or any required token measurement is
 * missing or invalid. Cost is optional and included only when fully measured.
 */
export function readCrushUsage(dataDir: string | undefined): TokenUsage | undefined {
  if (!dataDir) return undefined
  const file = join(dataDir, 'crush.db')
  const sqlite = loadSqlite()
  if (!sqlite || !existsSync(file)) return undefined
  let db: InstanceType<SqliteModule['DatabaseSync']> | undefined
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const row = db.prepare(USAGE_SQL).get()
    if (!row || !Number.isSafeInteger(row['sessions']) || (row['sessions'] as number) <= 0) return undefined
    const input = row['input']
    const output = row['output']
    if (row['input_count'] !== row['sessions'] || row['output_count'] !== row['sessions']
      || !isMeasurement(input) || !isMeasurement(output)) return undefined
    const cost = row['cost']
    const costCents = isMeasurement(cost) ? cost * 100 : undefined
    return {
      inputTokens: input,
      outputTokens: output,
      ...(row['cost_count'] === row['sessions'] && isMeasurement(costCents) ? { costCents } : {}),
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
