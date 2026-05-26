/**
 * Database connector — LangChain tool creation.
 *
 * Wires the executors and operations into LangChain-compatible
 * {@link DynamicStructuredTool}s and the unified {@link ConnectorToolkit}.
 *
 * If `config.query` is provided, it is used directly (no pg import needed).
 * Otherwise, a pg Pool is created lazily on first tool invocation.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { filterTools } from '../connector-types.js'
import type { ConnectorToolkit } from '../connector-contract.js'
import { createPool } from './db-connection.js'
import { createDatabaseOperations } from './db-operations.js'
import type { DatabaseOperations } from './db-operations.js'
import { createCustomExecutor, createPgExecutor } from './db-query.js'
import type { DatabaseConnectorConfig, QueryExecutor } from './db-types.js'

function formatRows(rows: Record<string, unknown>[], rowCount: number): string {
  if (rows.length === 0) {
    return 'Query returned 0 rows.'
  }
  const firstRow = rows[0]!
  const header = Object.keys(firstRow).join(' | ')
  const formattedRows = rows.map(r =>
    Object.values(r).map(v => String(v ?? 'NULL')).join(' | '),
  )
  return `${header}\n${'-'.repeat(header.length)}\n${formattedRows.join('\n')}\n\n(${rowCount} rows)`
}

/**
 * Create LangChain-compatible tools for database interaction.
 *
 * If `config.query` is provided, it is used directly (no pg import needed).
 * Otherwise, a pg Pool is created lazily on first tool invocation.
 */
export function createDatabaseConnector(config: DatabaseConnectorConfig): DynamicStructuredTool[] {
  const readOnly = config.readOnly ?? true
  const maxRows = config.maxRows ?? 1000
  const dbName = config.databaseName ?? 'database'

  // Lazily initialised
  let ops: DatabaseOperations | undefined

  async function getOps(): Promise<DatabaseOperations> {
    if (ops) return ops

    let executor: QueryExecutor
    if (config.query) {
      executor = createCustomExecutor(config.query)
    } else {
      const pool = await createPool(config)
      executor = createPgExecutor(pool)
    }

    ops = createDatabaseOperations(executor, { readOnly, maxRows })
    return ops
  }

  const all: DynamicStructuredTool[] = [
    // ── db-query ──────────────────────────────────────────
    new DynamicStructuredTool({
      name: 'db-query',
      description: `Execute a parameterized SQL query against ${dbName}. ${readOnly ? 'Read-only: allows SELECT/WITH/SHOW/VALUES and safe EXPLAIN only; blocks multi-statement and data-modifying CTE/query shapes.' : 'Read-write access.'} Results limited to ${maxRows} rows.`,
      schema: z.object({
        sql: z.string().describe('Parameterized SQL query (use $1, $2... for parameters)'),
        params: z.array(z.unknown()).optional().describe('Parameter values for $1, $2, etc.'),
      }),
      func: async ({ sql, params }) => {
        try {
          const db = await getOps()
          const result = await db.query(sql, params ?? [])
          const meta = `(${result.rowCount} rows, ${result.duration}ms)`
          return `${formatRows(result.rows, result.rowCount)}\n${meta}`
        } catch (err) {
          return `Query error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    // ── db-list-tables ────────────────────────────────────
    new DynamicStructuredTool({
      name: 'db-list-tables',
      description: `List all tables in ${dbName}. Returns table names and schemas.`,
      schema: z.object({
        schema: z.string().optional().describe('Schema to list tables from (default: public)'),
      }),
      func: async ({ schema }) => {
        try {
          const db = await getOps()
          const tables = await db.listTables(schema ?? 'public')
          if (tables.length === 0) {
            return `No tables found in schema "${schema ?? 'public'}".`
          }
          return tables.map(t => `${t.schema}.${t.name}`).join('\n')
        } catch (err) {
          return `Error listing tables: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    // ── db-describe-table ─────────────────────────────────
    new DynamicStructuredTool({
      name: 'db-describe-table',
      description: `Get detailed column information for a table in ${dbName}. Shows column names, types, nullability, defaults, and primary keys.`,
      schema: z.object({
        table: z.string().describe('Table name to describe'),
        schema: z.string().optional().describe('Schema name (default: public)'),
      }),
      func: async ({ table, schema }) => {
        try {
          const db = await getOps()
          const info = await db.getTableInfo(table, schema ?? 'public')

          if (info.columns.length === 0) {
            return `Table "${table}" not found or has no columns.`
          }

          const lines = info.columns.map(col => {
            const parts = [
              col.name,
              col.type,
              col.nullable ? 'NULL' : 'NOT NULL',
            ]
            if (col.isPrimaryKey) parts.push('PK')
            if (col.defaultValue) parts.push(`DEFAULT ${col.defaultValue}`)
            return parts.join(' | ')
          })

          const header = `Table: ${info.schema}.${info.name}`
          const rowEstimate = info.rowCount != null ? `Estimated rows: ${info.rowCount}` : ''
          return [header, rowEstimate, '', 'Column | Type | Nullable | Constraints', '-'.repeat(50), ...lines].filter(Boolean).join('\n')
        } catch (err) {
          return `Error describing table: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  ]

  return filterTools(all, config.enabledTools)
}

/**
 * Create a ConnectorToolkit for database operations.
 * Wraps `createDatabaseConnector` in the unified toolkit pattern.
 */
export function createDatabaseConnectorToolkit(config: DatabaseConnectorConfig): ConnectorToolkit {
  return {
    name: 'database',
    tools: createDatabaseConnector(config),
    enabledTools: config.enabledTools,
  }
}
