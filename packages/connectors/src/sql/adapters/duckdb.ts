/**
 * DuckDB unified SQL connector.
 *
 * Combines query execution and schema discovery using the duckdb npm package.
 * Supports both in-memory (':memory:') and file-based databases. File-based
 * databases are opened in read-only mode for safety.
 *
 * DuckDB does not support query-level timeouts — timeout enforcement is not
 * available through the Node.js driver.
 */

import { createRequire } from 'node:module'
import { BaseSQLConnector } from '../base-sql-connector.js'
import type {
  SQLDialect,
  SQLConnectionConfig,
  QueryExecutionOptions,
  QueryResultData,
  ConnectionTestResult,
  TableSchema,
  ColumnInfo,
  ForeignKey,
  SchemaDiscoveryOptions,
} from '../types.js'

import type * as DuckDBPkg from 'duckdb'

type DuckDBModule = typeof DuckDBPkg
type DuckDBRuntimeModule = DuckDBModule | { default: DuckDBModule }

const runtimeRequire = createRequire(import.meta.url)
const DUCKDB_DRIVER_PACKAGE = 'duckdb'

let duckdbModulePromise: Promise<DuckDBRuntimeModule> | null = null

function isMissingModuleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
  )
}

function assertDuckDBDriverInstalled(): void {
  try {
    runtimeRequire.resolve(DUCKDB_DRIVER_PACKAGE)
  } catch (error: unknown) {
    if (isMissingModuleError(error)) {
      throw new Error(
        `DuckDBConnector requires the optional dependency "${DUCKDB_DRIVER_PACKAGE}". Install it with: yarn add ${DUCKDB_DRIVER_PACKAGE}`,
      )
    }
    throw error
  }
}

async function loadDuckDBModule(): Promise<DuckDBModule> {
  if (!duckdbModulePromise) {
    assertDuckDBDriverInstalled()
    duckdbModulePromise = import('duckdb')
      .then((module) => module as DuckDBRuntimeModule)
      .catch((error: unknown) => {
        if (isMissingModuleError(error)) {
          throw new Error(
            `DuckDBConnector requires the optional dependency "${DUCKDB_DRIVER_PACKAGE}". Install it with: yarn add ${DUCKDB_DRIVER_PACKAGE}`,
          )
        }
        throw error
      })
  }

  const duckdb = await duckdbModulePromise
  return 'default' in duckdb ? duckdb.default : duckdb
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class DuckDBConnector extends BaseSQLConnector {
  private readonly dbPath: string
  private db: DuckDBPkg.Database | null = null
  private conn: DuckDBPkg.Connection | null = null

  constructor(config: SQLConnectionConfig) {
    super(config)
    assertDuckDBDriverInstalled()

    this.dbPath = config.duckdbPath ?? ':memory:'
  }

  getDialect(): SQLDialect {
    return 'duckdb'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      await this.query('SELECT 1 AS ok')
      return { ok: true, latencyMs: Math.round(performance.now() - start) }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Math.round(performance.now() - start),
      }
    }
  }

  async executeQuery(sql: string, options?: QueryExecutionOptions): Promise<QueryResultData> {
    const maxRows = options?.maxRows ?? 500

    const limitedSQL = this.wrapWithLimit(sql, maxRows)

    const rows = (await this.query(limitedSQL)) as Record<string, unknown>[]
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

    return {
      columns,
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated: rows.length > maxRows,
    }
  }

  async destroy(): Promise<void> {
    if (!this.db) return

    await new Promise<void>((resolve, reject) => {
      this.db!.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    this.db = null
    this.conn = null
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return 'main'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const rows = (await this.query(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = '${this.escape(schemaName)}'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    )) as Array<{ tableName: string }>

    return rows.map((row) => ({
      tableName: row.tableName,
      schemaName,
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]> {
    const rows = (await this.query(
      `SELECT
         column_name AS columnName,
         data_type AS dataType,
         is_nullable AS isNullable,
         column_default AS defaultValue,
         character_maximum_length AS maxLength
       FROM information_schema.columns
       WHERE table_schema = '${this.escape(schemaName)}'
         AND table_name = '${this.escape(tableName)}'
       ORDER BY ordinal_position`,
    )) as Array<{
      columnName: string
      dataType: string
      isNullable: string
      defaultValue: string | null
      maxLength: number | null
    }>

    // Discover primary key columns via duckdb_constraints()
    const pkRows = await this.query(
      `SELECT unnest(constraint_column_names) AS col_name
       FROM duckdb_constraints()
       WHERE table_name = '${this.escape(tableName)}'
         AND schema_name = '${this.escape(schemaName)}'
         AND constraint_type = 'PRIMARY KEY'`,
    ).catch(() => [] as Array<{ col_name: string }>) as Array<{ col_name: string }>

    const pkCols = new Set(pkRows.map((r) => r.col_name))

    return rows.map((row) => ({
      columnName: row.columnName,
      dataType: row.dataType.toLowerCase(),
      isNullable: row.isNullable === 'YES',
      isPrimaryKey: pkCols.has(row.columnName),
      defaultValue: row.defaultValue,
      description: null,
      maxLength: row.maxLength != null ? Number(row.maxLength) : null,
    }))
  }

  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    const rows = await this.query(
      `SELECT
         constraint_column_names AS columnNames
       FROM duckdb_constraints()
       WHERE table_name = '${this.escape(tableName)}'
         AND schema_name = '${this.escape(schemaName)}'
         AND constraint_type = 'FOREIGN KEY'`,
    ).catch(() => []) as Array<Record<string, unknown>>

    // DuckDB's constraint metadata is limited — return what we can extract
    return rows.map((row, idx) => ({
      constraintName: `fk_${tableName}_${String(idx)}`,
      columnName: Array.isArray(row['columnNames']) ? String(row['columnNames'][0]) : '',
      referencedTable: '',
      referencedColumn: '',
      referencedSchema: schemaName,
    }))
  }

  protected async discoverRowCount(tableName: string, schemaName: string): Promise<number> {
    const rows = await this.query(
      `SELECT estimated_size AS cnt
       FROM duckdb_tables()
       WHERE table_name = '${this.escape(tableName)}'
         AND schema_name = '${this.escape(schemaName)}'`,
    ).catch(() => []) as Array<{ cnt: number }>

    return rows.length > 0 ? Number(rows[0]!.cnt ?? 0) : 0
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    const escapedTable = this.escapeIdentifier(tableName)
    const escapedColumn = this.escapeIdentifier(columnName)

    const rows = (await this.query(
      `SELECT DISTINCT ${escapedColumn} AS val
       FROM ${escapedTable}
       WHERE ${escapedColumn} IS NOT NULL
       LIMIT ${String(limit)}`,
    )) as Array<{ val: unknown }>

    return rows.map((r) => r.val)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Execute a SQL query via the DuckDB connection (callback-based, promisified). */
  private query(sql: string): Promise<unknown[]> {
    return this.withConnection((conn) =>
      new Promise((resolve, reject) => {
        conn.all(sql, (err: Error | null, rows: unknown[]) => {
          if (err) reject(err)
          else resolve(rows)
        })
      }),
    )
  }

  private async withConnection<T>(run: (conn: DuckDBPkg.Connection) => Promise<T>): Promise<T> {
    const conn = await this.getConnection()
    return run(conn)
  }

  private async getConnection(): Promise<DuckDBPkg.Connection> {
    if (this.conn) return this.conn

    assertDuckDBDriverInstalled()
    const duckdb = await loadDuckDBModule()

    if (!this.db) {
      this.db = new duckdb.Database(this.dbPath)
    }

    this.conn = new duckdb.Connection(this.db)

    // Set read-only mode for file-based databases to prevent accidental writes.
    if (this.dbPath !== ':memory:') {
      this.conn.run("SET access_mode = 'read_only'")
    }

    return this.conn
  }

  /** Escape a string value for use in SQL (single-quote doubling). */
  private escape(value: string): string {
    return value.replace(/'/g, "''")
  }

  /** Escape a DuckDB identifier with double quotes. */
  private escapeIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"'
  }
}
