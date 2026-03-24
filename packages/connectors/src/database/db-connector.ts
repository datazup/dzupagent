/**
 * Database connector — SQL query execution tool.
 *
 * Provides read-only or read-write SQL execution against a configured
 * database. Uses a generic query function that consumers provide
 * (e.g., via pg, mysql2, better-sqlite3).
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'

export interface DatabaseConnectorConfig {
  /** Execute a SQL query and return results */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  /** Restrict to SELECT queries only (default: true) */
  readOnly?: boolean
  /** Human-readable database name for tool descriptions */
  databaseName?: string
}

const WRITE_KEYWORDS = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)/i

export function createDatabaseConnector(config: DatabaseConnectorConfig): DynamicStructuredTool[] {
  const readOnly = config.readOnly ?? true
  const dbName = config.databaseName ?? 'database'

  return [
    new DynamicStructuredTool({
      name: 'db_query',
      description: `Execute a SQL query against ${dbName}. ${readOnly ? 'Read-only: only SELECT queries allowed.' : 'Read-write access.'}`,
      schema: z.object({
        sql: z.string().describe('SQL query to execute'),
        params: z.array(z.unknown()).optional().describe('Query parameters for parameterized queries'),
      }),
      func: async ({ sql, params }) => {
        if (readOnly && WRITE_KEYWORDS.test(sql)) {
          return `Error: Write operations not allowed (read-only mode). Only SELECT queries are permitted.`
        }

        try {
          const result = await config.query(sql, params ?? [])
          if (result.rows.length === 0) {
            return `Query returned 0 rows.`
          }
          // Format as readable table
          const header = Object.keys(result.rows[0] as Record<string, unknown>).join(' | ')
          const rows = result.rows.map(r =>
            Object.values(r as Record<string, unknown>).map(v => String(v ?? 'NULL')).join(' | '),
          )
          return `${header}\n${'-'.repeat(header.length)}\n${rows.join('\n')}\n\n(${result.rowCount} rows)`
        } catch (err) {
          return `Query error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'db_schema',
      description: `Get the database schema (tables, columns, types) from ${dbName}`,
      schema: z.object({
        table: z.string().optional().describe('Specific table name (omit for all tables)'),
      }),
      func: async ({ table }) => {
        try {
          const sql = table
            ? `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`
            : `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
          const params = table ? [table] : []
          const result = await config.query(sql, params)
          return JSON.stringify(result.rows, null, 2)
        } catch (err) {
          return `Schema query error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  ]
}
