/**
 * Creates DzupAgent-compatible LangChain tools from a SQLConnector.
 *
 * These tools can be passed directly to DzupAgent's `tools` config,
 * enabling agents to query databases, discover schemas, and describe tables.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import nodeSqlParser from 'node-sql-parser'

const { Parser } = nodeSqlParser
import { z } from 'zod'
import type { SQLConnector } from './types.js'
import { filterTools } from '../connector-types.js'

const sqlParser = new Parser()

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

const READ_ONLY_SQL_ERROR =
  'Only read-only queries are allowed. Statement must start with SELECT or WITH.'

function stripLeadingComments(sql: string): string {
  let out = sql.trimStart()

  while (out.length > 0) {
    // SQL line comments: -- comment
    if (out.startsWith('--')) {
      const nl = out.indexOf('\n')
      out = nl === -1 ? '' : out.slice(nl + 1).trimStart()
      continue
    }

    // SQL block comments: /* comment */
    if (out.startsWith('/*')) {
      const end = out.indexOf('*/')
      if (end === -1) return ''
      out = out.slice(end + 2).trimStart()
      continue
    }

    break
  }

  return out
}

/**
 * Remove all SQL comments and string literals from a query, replacing each
 * with a single space.  This prevents DML keywords hidden inside comments
 * or string literals from being treated as real DML by the keyword scanner.
 *
 * Handles:
 *  - "--" line comments
 *  - "/ * ... * /" block comments (non-nested)
 *  - single-quoted and double-quoted string literals with escaped-quote sequences
 */
function stripCommentsAndLiterals(sql: string): string {
  const result: string[] = []
  let i = 0

  while (i < sql.length) {
    // Line comment: -- …
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2)
      result.push(' ')
      i = nl === -1 ? sql.length : nl + 1
      continue
    }

    // Block comment: /* … */
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      result.push(' ')
      i = end === -1 ? sql.length : end + 2
      continue
    }

    // String literal: '…' or "…" (allow '' / "" escape sequences)
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]
      result.push(' ')
      i++
      while (i < sql.length) {
        if (sql[i] === quote) {
          // doubled-quote escape: '' or ""
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++ // consume closing quote
          break
        }
        if (sql[i] === '\\') i++ // backslash escape
        i++
      }
      continue
    }

    result.push(sql[i]!)
    i++
  }

  return result.join('')
}

/**
 * Checks if a SQL statement is read-only using AST-based parsing.
 *
 * Parses the SQL with node-sql-parser and verifies that every statement
 * in the query is a SELECT. This catches:
 * - Data modification CTEs: WITH … INSERT/UPDATE/DELETE/MERGE
 * - Multi-statement injections: SELECT 1; DROP TABLE t
 * - Any DML/DDL regardless of comment or string-literal obfuscation
 *
 * Unparseable SQL is rejected (returns false) as a safe default.
 */
function isReadOnlySQL(sql: string): boolean {
  try {
    const ast = sqlParser.astify(sql)
    if (Array.isArray(ast)) {
      return ast.length > 0 && ast.every((node) => node.type === 'select')
    }
    return ast.type === 'select'
  } catch {
    // Parse failure → reject as unsafe
    return false
  }
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
          if (!isReadOnlySQL(input.sql)) {
            return JSON.stringify({ error: READ_ONLY_SQL_ERROR })
          }

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

export const __sqlToolsInternals = {
  isReadOnlySQL,
  stripLeadingComments,
  stripCommentsAndLiterals,
  READ_ONLY_SQL_ERROR,
}
