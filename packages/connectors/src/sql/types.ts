/**
 * Unified SQL connector types — combines query execution + schema discovery
 * into a single per-dialect connector for @dzupagent/connectors.
 *
 * Migrated from @nl2sql/core, @nl2sql/db-connectors, @nl2sql/schema-discovery.
 */

/** Supported SQL dialects */
export type SQLDialect =
  | 'postgresql'
  | 'mysql'
  | 'clickhouse'
  | 'snowflake'
  | 'bigquery'
  | 'sqlite'
  | 'sqlserver'
  | 'duckdb'
  | 'generic'

/** Database type (excludes 'generic' — used for config) */
export type DatabaseType = Exclude<SQLDialect, 'generic'>

/** TLS connection options for SSL-enabled databases */
export interface TlsOptions {
  rejectUnauthorized?: boolean
  ca?: string
  [key: string]: unknown
}

/** Connection configuration for any supported database */
export interface SQLConnectionConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
  ssl: boolean | TlsOptions
  /** When ssl=true (boolean), allow self-signed certificates (default: false) */
  sslAllowSelfSigned?: boolean
  /** PostgreSQL schema name (default: 'public') */
  schema?: string
  /** Snowflake account identifier */
  account?: string
  /** Snowflake warehouse */
  warehouse?: string
  /** Snowflake role */
  role?: string
  /** BigQuery project ID */
  projectId?: string
  /** BigQuery dataset */
  dataset?: string
  /** BigQuery service account JSON credentials */
  credentialsJson?: string
  /** SQLite file path */
  filePath?: string
  /** DuckDB file path (or ':memory:' for in-memory) */
  duckdbPath?: string
}

/** Options for query execution */
export interface QueryExecutionOptions {
  timeoutMs?: number
  maxRows?: number
}

/** Result of a SQL query execution */
export interface QueryResultData {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

/** Result of a connection test */
export interface ConnectionTestResult {
  ok: boolean
  error?: string
  latencyMs: number
}

/** Column metadata from schema discovery */
export interface ColumnInfo {
  columnName: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  defaultValue: string | null
  description: string | null
  maxLength: number | null
}

/** Foreign key constraint metadata */
export interface ForeignKey {
  constraintName: string
  columnName: string
  referencedTable: string
  referencedColumn: string
  referencedSchema: string
}

/** Table schema metadata */
export interface TableSchema {
  tableName: string
  schemaName: string
  columns: ColumnInfo[]
  foreignKeys: ForeignKey[]
  rowCountEstimate: number
  description: string | null
  sampleValues: Record<string, unknown[]>
}

/** Full database schema from discovery */
export interface DatabaseSchema {
  dialect: SQLDialect
  schemaName: string
  tables: TableSchema[]
  discoveredAt: Date
}

/** Options for schema discovery */
export interface SchemaDiscoveryOptions {
  schemaName?: string
  excludeTables?: string[]
  includeTables?: string[]
  sampleValueLimit?: number
}

/**
 * Unified SQL connector interface — each dialect implements this.
 * Combines ITargetDatabase + ISchemaDiscovery from the old @nl2sql packages.
 */
export interface SQLConnector {
  /** Get the SQL dialect this connector handles */
  getDialect(): SQLDialect

  /** Test database connectivity */
  testConnection(): Promise<ConnectionTestResult>

  /** Execute a SQL query with optional timeout and row limits */
  executeQuery(sql: string, options?: QueryExecutionOptions): Promise<QueryResultData>

  /** Discover the full database schema */
  discoverSchema(options?: SchemaDiscoveryOptions): Promise<DatabaseSchema>

  /** Generate DDL for a table */
  generateDDL(table: TableSchema): string

  /** Release resources (connection pools, etc.) */
  destroy(): Promise<void>
}
