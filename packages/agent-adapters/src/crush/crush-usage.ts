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

const USAGE_SQL = 'SELECT COUNT(*) AS sessions, COALESCE(SUM(prompt_tokens), 0) AS input, '
  + 'COALESCE(SUM(completion_tokens), 0) AS output, COALESCE(SUM(cost), 0) AS cost FROM sessions'

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
 * `undefined` when the reader, the database or a session row is missing.
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
    if (!row || Number(row['sessions']) === 0) return undefined
    return {
      inputTokens: Number(row['input']),
      outputTokens: Number(row['output']),
      costCents: Number(row['cost']) * 100,
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
