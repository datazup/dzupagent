/**
 * Creates DzipAgent-compatible LangChain tools from a SQLConnector.
 *
 * These tools can be passed directly to DzipAgent's `tools` config,
 * enabling agents to query databases, discover schemas, and describe tables.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { SQLConnector } from './types.js'
import { filterTools } from '../connector-types.js'

export interface SQLToolsConfig {
  /** The SQL connector to wrap as tools */
  connector: SQLConnector
  /** Maximum rows per query (default: 500) */
  maxRows?: number
  /** Query timeout in ms (default: 30000) */
  queryTimeout?: number
  /** Only expose these tool names (default: all) */
  enabledTools?: string[]
}

/**
 * Creates LangChain DynamicStructuredTools for SQL operations.
 *
 * Tools created:
 * - `sql-query` — Execute a read-only SQL query
 * - `sql-describe-table` — Get column info for a table
 * - `sql-list-tables` — List all tables in a schema
 * - `sql-discover-schema` — Full schema discovery with columns, FKs, sample values
 * - `sql-generate-ddl` — Generate DDL for discovered tables
 * - `sql-test-connection` — Test database connectivity
 */
export function createSQLTools(config: SQLToolsConfig): DynamicStructuredTool[] {
  const { connector, maxRows = 500, queryTimeout = 30_000 } = config

  const tools: DynamicStructuredTool[] = [
    new DynamicStructuredTool({
      name: 'sql-query',
      description:
        'Execute a read-only SQL query against the target database. Returns columns, rows, row count, and whether the result was truncated. Only SELECT/WITH statements are allowed.',
      schema: z.object({
        sql: z.string().describe('The SQL query to execute (SELECT/WITH only)'),
        maxRows: z.number().optional().describe('Maximum rows to return (default: 500)'),
        timeoutMs: z.number().optional().describe('Query timeout in milliseconds (default: 30000)'),
      }),
      func: async (input) => {
        try {
          const result = await connector.executeQuery(input.sql, {
            maxRows: input.maxRows ?? maxRows,
            timeoutMs: input.timeoutMs ?? queryTimeout,
          })
          return JSON.stringify(result)
        } catch (err: unknown) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'sql-list-tables',
      description:
        'List all tables in the database schema. Returns table names with descriptions.',
      schema: z.object({
        schemaName: z.string().optional().describe('Schema name (uses default if omitted)'),
      }),
      func: async (input) => {
        try {
          const schema = await connector.discoverSchema({
            schemaName: input.schemaName,
            sampleValueLimit: 0,
          })
          const tables = schema.tables.map((t) => ({
            tableName: t.tableName,
            schemaName: t.schemaName,
            description: t.description,
            rowCountEstimate: t.rowCountEstimate,
          }))
          return JSON.stringify({ dialect: schema.dialect, tables })
        } catch (err: unknown) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'sql-describe-table',
      description:
        'Get detailed column information for a specific table, including types, nullability, primary keys, foreign keys, and sample values.',
      schema: z.object({
        tableName: z.string().describe('The table to describe'),
        schemaName: z.string().optional().describe('Schema name (uses default if omitted)'),
        sampleValueLimit: z.number().optional().describe('Number of sample values per column (default: 5)'),
      }),
      func: async (input) => {
        try {
          const schema = await connector.discoverSchema({
            schemaName: input.schemaName,
            includeTables: [input.tableName],
            sampleValueLimit: input.sampleValueLimit ?? 5,
          })
          const table = schema.tables[0]
          if (!table) {
            return JSON.stringify({ error: `Table '${input.tableName}' not found` })
          }
          const ddl = connector.generateDDL(table)
          return JSON.stringify({ ...table, ddl })
        } catch (err: unknown) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'sql-discover-schema',
      description:
        'Discover the full database schema: all tables with columns, foreign keys, row counts, and sample values. Use sampleValueLimit=0 for a faster lightweight discovery.',
      schema: z.object({
        schemaName: z.string().optional().describe('Schema name (uses default if omitted)'),
        includeTables: z.array(z.string()).optional().describe('Only discover these tables'),
        excludeTables: z.array(z.string()).optional().describe('Skip these tables'),
        sampleValueLimit: z.number().optional().describe('Sample values per column (default: 5, use 0 for fast mode)'),
      }),
      func: async (input) => {
        try {
          const schema = await connector.discoverSchema({
            schemaName: input.schemaName,
            includeTables: input.includeTables,
            excludeTables: input.excludeTables,
            sampleValueLimit: input.sampleValueLimit,
          })
          return JSON.stringify(schema)
        } catch (err: unknown) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'sql-generate-ddl',
      description:
        'Generate CREATE TABLE DDL for a specific table. Useful for providing schema context to LLMs.',
      schema: z.object({
        tableName: z.string().describe('The table to generate DDL for'),
        schemaName: z.string().optional().describe('Schema name (uses default if omitted)'),
      }),
      func: async (input) => {
        try {
          const schema = await connector.discoverSchema({
            schemaName: input.schemaName,
            includeTables: [input.tableName],
            sampleValueLimit: 0,
          })
          const table = schema.tables[0]
          if (!table) {
            return JSON.stringify({ error: `Table '${input.tableName}' not found` })
          }
          return connector.generateDDL(table)
        } catch (err: unknown) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),

    new DynamicStructuredTool({
      name: 'sql-test-connection',
      description: 'Test database connectivity and measure latency.',
      schema: z.object({}),
      func: async () => {
        try {
          const result = await connector.testConnection()
          return JSON.stringify(result)
        } catch (err: unknown) {
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            latencyMs: -1,
          })
        }
      },
    }),
  ]

  return filterTools(tools, config.enabledTools)
}
