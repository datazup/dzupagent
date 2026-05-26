/**
 * Database connector — shared type definitions.
 *
 * Public configuration/result contracts plus the internal driver-facing
 * interfaces (`PgPool`, `PgPoolClient`, `QueryExecutor`) shared across the
 * connection, query, and operations modules.
 */

// ---------------------------------------------------------------------------
// Public contracts
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
// Driver-facing interfaces (internal)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the pg.Pool interface that we depend on, so we do not
 * require a compile-time dependency on `@types/pg`.
 */
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[]
    rowCount: number | null
    fields: Array<{ name: string; dataTypeID: number }>
  }>
  connect?(): Promise<PgPoolClient>
  end(): Promise<void>
}

export interface PgPoolClient {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[]
    rowCount: number | null
    fields: Array<{ name: string; dataTypeID: number }>
  }>
  release(): void
}

/** Abstraction over a SQL execution backend (pg pool or custom query fn). */
export interface QueryExecutor {
  execute(sql: string, params?: unknown[]): Promise<QueryResult>
  executeReadOnly?(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): Promise<void>
}
