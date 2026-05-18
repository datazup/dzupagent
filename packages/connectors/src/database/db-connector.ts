/**
 * Database connector — PostgreSQL-focused SQL query execution tools.
 *
 * Provides parameterized query execution, schema introspection, and health
 * checks against a PostgreSQL database. Uses `pg` as an optional peer
 * dependency via dynamic import with graceful failure.
 *
 * SAFETY: Only parameterized queries are allowed — no string interpolation
 * of user input into SQL. Read-only mode allows only read-safe statement
 * forms and rejects multi-statement/query-shape bypasses.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { filterTools } from '../connector-types.js'
import type { ConnectorToolkit } from '../connector-contract.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseConnectorConfig {
  /** Full connection string (takes precedence over individual fields) */
  connectionString?: string
  /** Database host (default: localhost) */
  host?: string
  /** Database port (default: 5432) */
  port?: number
  /** Database name */
  database?: string
  /** Database user */
  user?: string
  /** Database password */
  password?: string
  /** Enable SSL (default: false). Pass an object for fine-grained TLS options. */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string }
  /** When ssl=true (boolean), allow self-signed certificates (default: false) */
  sslAllowSelfSigned?: boolean
  /** Maximum pool connections (default: 5) */
  maxConnections?: number
  /** Query timeout in ms (default: 30_000) */
  queryTimeout?: number
  /** Maximum rows returned per query (default: 1000) */
  maxRows?: number
  /** Restrict to read-safe query shapes only (default: true) */
  readOnly?: boolean
  /** Human-readable database name for tool descriptions */
  databaseName?: string
  /** Subset of tools to expose */
  enabledTools?: string[]
  /**
   * Provide a custom query function instead of using pg.
   * When set, connectionString/host/port/etc. are ignored and no pg import
   * is attempted. Useful for testing or wrapping other drivers.
   */
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
  fields: { name: string; type: string }[]
  duration: number // ms
}

export interface TableInfo {
  name: string
  schema: string
  columns: ColumnInfo[]
  rowCount?: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue?: string
  isPrimaryKey: boolean
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const WRITE_ROOT_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'COPY',
])

const READ_ONLY_ROOT_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'VALUES',
])

const DATA_MODIFYING_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|MERGE|COPY)\b/i
const EXPLAIN_ANALYZE_RE = /\bANALYZE\b/i
const LIMIT_RE = /\bLIMIT\b/i

function readDollarQuoteTagAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  const end = sql.indexOf('$', index + 1)
  if (end === -1) return null
  const inner = sql.slice(index + 1, end)
  if (inner.length === 0) return '$$'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return null
  return `$${inner}$`
}

function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  let parenDepth = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarTag: string | null = null

  while (i < sql.length) {
    const ch = sql[i]!
    const next = i + 1 < sql.length ? sql[i + 1]! : ''

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      current += ch
      i += 1
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 2
        continue
      }
      if (ch === "'") inSingleQuote = false
      i += 1
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && next === '"') {
        current += next
        i += 2
        continue
      }
      if (ch === '"') inDoubleQuote = false
      i += 1
      continue
    }

    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      i += 1
      continue
    }

    if (blockCommentDepth > 0) {
      current += ch
      if (ch === '/' && next === '*') {
        blockCommentDepth += 1
        current += next
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        blockCommentDepth -= 1
        current += next
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (ch === '-' && next === '-') {
      current += ch + next
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      current += ch + next
      blockCommentDepth = 1
      i += 2
      continue
    }

    const tag = readDollarQuoteTagAt(sql, i)
    if (tag) {
      dollarTag = tag
      current += tag
      i += tag.length
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      current += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      current += ch
      i += 1
      continue
    }

    if (ch === '(') parenDepth += 1
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)

    if (ch === ';' && parenDepth === 0) {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(trimmed)
      current = ''
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  const trailing = current.trim()
  if (trailing.length > 0) statements.push(trailing)
  return statements
}

function maskSqlLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarTag: string | null = null

  while (i < sql.length) {
    const ch = sql[i]!
    const next = i + 1 < sql.length ? sql[i + 1]! : ''

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        out += ' '.repeat(dollarTag.length)
        i += dollarTag.length
        dollarTag = null
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      if (ch === "'") inSingleQuote = false
      i += 1
      continue
    }

    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      if (ch === '"') inDoubleQuote = false
      i += 1
      continue
    }

    if (inLineComment) {
      out += ch === '\n' ? '\n' : ' '
      if (ch === '\n') inLineComment = false
      i += 1
      continue
    }

    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '*') {
        blockCommentDepth += 1
        out += '  '
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        blockCommentDepth -= 1
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (ch === '-' && next === '-') {
      inLineComment = true
      out += '  '
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      blockCommentDepth = 1
      out += '  '
      i += 2
      continue
    }

    const tag = readDollarQuoteTagAt(sql, i)
    if (tag) {
      dollarTag = tag
      out += ' '.repeat(tag.length)
      i += tag.length
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      out += ' '
      i += 1
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      out += ' '
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return out
}

function leadingKeyword(sql: string): string | null {
  const match = sql.match(/^\s*([A-Za-z]+)/)
  return match ? match[1]!.toUpperCase() : null
}

function isDataModifyingWithStatement(maskedSql: string): boolean {
  return DATA_MODIFYING_KEYWORDS_RE.test(maskedSql)
}

function stripExplainPrefix(maskedSql: string): string {
  let rest = maskedSql.replace(/^\s*EXPLAIN\b/i, '').trimStart()
  if (!rest.startsWith('(')) return rest

  let i = 0
  let depth = 0
  while (i < rest.length) {
    const ch = rest[i]!
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
    i += 1
  }

  return rest.slice(i).trimStart()
}

function enforceReadOnlyStatement(sql: string): string {
  const statements = splitTopLevelStatements(sql)
  if (statements.length === 0) {
    throw new Error('Write operations not allowed (read-only mode). SQL query is empty.')
  }
  if (statements.length > 1) {
    throw new Error('Write operations not allowed (read-only mode). Multiple SQL statements are not permitted.')
  }

  const statement = statements[0]!
  const masked = maskSqlLiteralsAndComments(statement)
  const root = leadingKeyword(masked)
  if (!root || !READ_ONLY_ROOT_KEYWORDS.has(root)) {
    throw new Error(
      'Write operations not allowed (read-only mode). Only read-safe SELECT/WITH/SHOW/VALUES/EXPLAIN statements are permitted.',
    )
  }

  if (WRITE_ROOT_KEYWORDS.has(root)) {
    throw new Error('Write operations not allowed (read-only mode).')
  }

  if (root === 'WITH' && isDataModifyingWithStatement(masked)) {
    throw new Error('Write operations not allowed (read-only mode). Data-modifying CTEs are not permitted.')
  }

  if (root === 'EXPLAIN') {
    if (EXPLAIN_ANALYZE_RE.test(masked)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN ANALYZE is not permitted.')
    }
    const explainedStatement = stripExplainPrefix(masked)
    const explainedRoot = leadingKeyword(explainedStatement)
    if (explainedRoot && WRITE_ROOT_KEYWORDS.has(explainedRoot)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN of write statements is not permitted.')
    }
    if (explainedRoot === 'WITH' && isDataModifyingWithStatement(explainedStatement)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN of data-modifying CTEs is not permitted.')
    }
  }

  return statement
}

function shouldApplyAutoLimit(maskedSql: string): boolean {
  const root = leadingKeyword(maskedSql)
  if (!root) return false
  if (root === 'SHOW' || root === 'EXPLAIN') return false
  if (root === 'WITH' && isDataModifyingWithStatement(maskedSql)) return false
  return root === 'SELECT' || root === 'WITH' || root === 'VALUES'
}

/**
 * Minimal subset of the pg.Pool interface that we depend on, so we do not
 * require a compile-time dependency on `@types/pg`.
 */
interface PgPool {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[]
    rowCount: number | null
    fields: Array<{ name: string; dataTypeID: number }>
  }>
  connect?(): Promise<PgPoolClient>
  end(): Promise<void>
}

interface PgPoolClient {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[]
    rowCount: number | null
    fields: Array<{ name: string; dataTypeID: number }>
  }>
  release(): void
}

/** Data-type OID to human-readable name (PostgreSQL common types). */
const PG_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  2950: 'uuid',
  3802: 'jsonb',
}

function oidToName(oid: number): string {
  return PG_TYPE_MAP[oid] ?? `oid:${oid}`
}

/**
 * Create a pg Pool via dynamic import. Throws a clear message when `pg`
 * is not installed.
 */
async function createPool(config: DatabaseConnectorConfig): Promise<PgPool> {
  let PgPool: new (opts: Record<string, unknown>) => PgPool
  try {
    const pgModule = await import('pg') as { Pool: typeof PgPool; default?: { Pool: typeof PgPool } }
    // Handle both ESM default export and named export
    PgPool = pgModule.Pool ?? pgModule.default?.Pool ?? (pgModule as unknown as { Pool: typeof PgPool }).Pool
  } catch {
    throw new Error(
      'The "pg" package is required for the database connector. Install it with: npm install pg',
    )
  }

  const poolConfig: Record<string, unknown> = {
    max: config.maxConnections ?? 5,
    statement_timeout: config.queryTimeout ?? 30_000,
  }

  if (config.connectionString) {
    poolConfig['connectionString'] = config.connectionString
  } else {
    poolConfig['host'] = config.host ?? 'localhost'
    poolConfig['port'] = config.port ?? 5432
    if (config.database) poolConfig['database'] = config.database
    if (config.user) poolConfig['user'] = config.user
    if (config.password) poolConfig['password'] = config.password
  }

  if (config.ssl) {
    poolConfig['ssl'] = typeof config.ssl === 'object'
      ? config.ssl
      : { rejectUnauthorized: config.sslAllowSelfSigned !== true }
  }

  return new PgPool(poolConfig)
}

// ---------------------------------------------------------------------------
// Query executor abstraction
// ---------------------------------------------------------------------------

interface QueryExecutor {
  execute(sql: string, params?: unknown[]): Promise<QueryResult>
  executeReadOnly?(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): Promise<void>
}

function createCustomExecutor(
  queryFn: NonNullable<DatabaseConnectorConfig['query']>,
): QueryExecutor {
  return {
    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const start = Date.now()
      const result = await queryFn(sql, params)
      const rows = result.rows as Record<string, unknown>[]
      const firstRow = rows[0]
      const fields = firstRow
        ? Object.keys(firstRow).map(name => ({ name, type: 'unknown' }))
        : []
      return {
        rows,
        rowCount: result.rowCount,
        fields,
        duration: Date.now() - start,
      }
    },
    async close() {
      // nothing to close for a custom query fn
    },
  }
}

function createPgExecutor(pool: PgPool): QueryExecutor {
  function mapPgResult(
    result: {
      rows: Record<string, unknown>[]
      rowCount: number | null
      fields: Array<{ name: string; dataTypeID: number }>
    },
    start: number,
  ): QueryResult {
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map(f => ({ name: f.name, type: oidToName(f.dataTypeID) })),
      duration: Date.now() - start,
    }
  }

  return {
    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const start = Date.now()
      const result = await pool.query(sql, params)
      return mapPgResult(result, start)
    },
    async executeReadOnly(sql: string, params?: unknown[]): Promise<QueryResult> {
      if (typeof pool.connect !== 'function') {
        return this.execute(sql, params)
      }

      const client = await pool.connect()
      const start = Date.now()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL TRANSACTION READ ONLY')
        const result = await client.query(sql, params)
        await client.query('COMMIT')
        return mapPgResult(result, start)
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // ignore rollback failures; original error is more actionable
        }
        throw error
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

// ---------------------------------------------------------------------------
// Core operations (exposed for programmatic use)
// ---------------------------------------------------------------------------

export interface DatabaseOperations {
  /** Execute a parameterized SQL query. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  /** List all tables in a given schema (default: public). */
  listTables(schema?: string): Promise<TableInfo[]>
  /** Get detailed column info for a specific table. */
  describeTable(tableName: string, schema?: string): Promise<ColumnInfo[]>
  /** Full table info including columns and approximate row count. */
  getTableInfo(tableName: string, schema?: string): Promise<TableInfo>
  /** Connection health check. Returns true if the database is reachable. */
  healthCheck(): Promise<boolean>
  /** Close the underlying connection pool. */
  close(): Promise<void>
}

export function createDatabaseOperations(
  executor: QueryExecutor,
  config: Pick<DatabaseConnectorConfig, 'readOnly' | 'maxRows'>,
): DatabaseOperations {
  const readOnly = config.readOnly ?? true
  const maxRows = config.maxRows ?? 1000

  async function executeSql(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (readOnly && executor.executeReadOnly) {
      return executor.executeReadOnly(sql, params)
    }
    return executor.execute(sql, params)
  }

  return {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const candidateSql = readOnly ? enforceReadOnlyStatement(sql) : sql
      const maskedCandidate = maskSqlLiteralsAndComments(candidateSql)

      // Enforce row limit by wrapping SELECT-like queries
      let safeSql = candidateSql
      if (shouldApplyAutoLimit(maskedCandidate) && !LIMIT_RE.test(maskedCandidate)) {
        safeSql = `SELECT * FROM (${candidateSql}) AS __limited LIMIT ${maxRows}`
      }

      return executeSql(safeSql, params)
    },

    async listTables(schema = 'public'): Promise<TableInfo[]> {
      const result = await executeSql(
        `SELECT table_name, table_schema
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schema],
      )

      return result.rows.map(row => ({
        name: String(row['table_name']),
        schema: String(row['table_schema']),
        columns: [],
      }))
    },

    async describeTable(tableName: string, schema = 'public'): Promise<ColumnInfo[]> {
      const result = await executeSql(
        `SELECT
           c.column_name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_primary_key
         FROM information_schema.columns c
         LEFT JOIN information_schema.key_column_usage kcu
           ON c.table_name = kcu.table_name
           AND c.column_name = kcu.column_name
           AND c.table_schema = kcu.table_schema
         LEFT JOIN information_schema.table_constraints tc
           ON kcu.constraint_name = tc.constraint_name
           AND tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = c.table_schema
         WHERE c.table_name = $1
           AND c.table_schema = $2
         ORDER BY c.ordinal_position`,
        [tableName, schema],
      )

      return result.rows.map(row => {
        const defaultValue = row['column_default'] != null ? String(row['column_default']) : undefined
        return {
          name: String(row['column_name']),
          type: String(row['data_type']),
          nullable: row['is_nullable'] === 'YES',
          ...(defaultValue !== undefined ? { defaultValue } : {}),
          isPrimaryKey: row['is_primary_key'] === true || row['is_primary_key'] === 't',
        }
      })
    },

    async getTableInfo(tableName: string, schema = 'public'): Promise<TableInfo> {
      const columns = await this.describeTable(tableName, schema)

      // Approximate row count from pg_class (fast, no full scan)
      let rowCount: number | undefined
      try {
        const countResult = await executeSql(
          `SELECT reltuples::bigint AS estimate
           FROM pg_class
           WHERE relname = $1`,
          [tableName],
        )
        const estimate = countResult.rows[0]?.['estimate']
        if (estimate != null) rowCount = Number(estimate)
      } catch {
        // Non-critical — row count is optional
      }

      return { name: tableName, schema, columns, ...(rowCount !== undefined ? { rowCount } : {}) }
    },

    async healthCheck(): Promise<boolean> {
      try {
        await executeSql('SELECT 1 AS ok')
        return true
      } catch {
        return false
      }
    },

    async close(): Promise<void> {
      await executor.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------

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
