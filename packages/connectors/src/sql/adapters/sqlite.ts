/**
 * SQLite unified SQL connector.
 *
 * Combines query execution and schema discovery using better-sqlite3.
 * Opens the database in readonly mode to prevent writes. The synchronous
 * better-sqlite3 API is wrapped in async methods to match the connector
 * interface.
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

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement
  pragma(sql: string): unknown
  close(): void
}

type BetterSqlite3Ctor = new (
  filePath: string,
  options?: { readonly?: boolean },
) => BetterSqlite3Database

type BetterSqlite3Module = BetterSqlite3Ctor | { default?: BetterSqlite3Ctor }

const runtimeRequire = createRequire(import.meta.url)
const SQLITE_DRIVER_PACKAGE = 'better-sqlite3'

let sqliteModulePromise: Promise<BetterSqlite3Module> | null = null

function isMissingModuleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
  )
}

function assertSqliteDriverInstalled(): void {
  try {
    runtimeRequire.resolve(SQLITE_DRIVER_PACKAGE)
  } catch (error: unknown) {
    if (isMissingModuleError(error)) {
      throw new Error(
        `SQLiteConnector requires the optional dependency "${SQLITE_DRIVER_PACKAGE}". Install it with: yarn add ${SQLITE_DRIVER_PACKAGE}`,
      )
    }
    throw error
  }
}

async function loadBetterSqlite3(): Promise<BetterSqlite3Ctor> {
  if (!sqliteModulePromise) {
    assertSqliteDriverInstalled()
    sqliteModulePromise = Promise.resolve()
      .then(() => runtimeRequire(SQLITE_DRIVER_PACKAGE) as BetterSqlite3Module)
      .catch((error: unknown) => {
        if (isMissingModuleError(error)) {
          throw new Error(
            `SQLiteConnector requires the optional dependency "${SQLITE_DRIVER_PACKAGE}". Install it with: yarn add ${SQLITE_DRIVER_PACKAGE}`,
          )
        }
        throw error
      })
  }

  const sqlite = await sqliteModulePromise
  return (sqlite as { default?: BetterSqlite3Ctor }).default ?? (sqlite as BetterSqlite3Ctor)
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class SQLiteConnector extends BaseSQLConnector {
  private readonly dbPath: string
  private db: BetterSqlite3Database | null = null

  constructor(config: SQLConnectionConfig) {
    super(config)
    assertSqliteDriverInstalled()

    const dbPath = config.filePath ?? config.database
    if (!dbPath) {
      throw new Error('SQLite requires a filePath or database path')
    }

    this.dbPath = dbPath
  }

  getDialect(): SQLDialect {
    return 'sqlite'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      const db = await this.getDatabase()
      db.prepare('SELECT 1').get()
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

    const db = await this.getDatabase()
    const stmt = db.prepare(limitedSQL)
    const rows = stmt.all() as Record<string, unknown>[]
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

    return {
      columns,
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated: rows.length > maxRows,
    }
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return 'main'
  }

  protected async discoverTables(
    _schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const db = await this.getDatabase()
    const rows = db
      .prepare(
        `SELECT name AS tableName
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ tableName: string }>

    return rows.map((row) => ({
      tableName: row.tableName,
      schemaName: 'main',
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, _schemaName: string): Promise<ColumnInfo[]> {
    const escapedTable = this.escapeIdentifier(tableName)
    const db = await this.getDatabase()
    const rows = db
      .prepare(`PRAGMA table_info(${escapedTable})`)
      .all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>

    return rows.map((row) => ({
      columnName: row.name,
      dataType: row.type.toLowerCase() || 'text',
      isNullable: row.notnull === 0,
      isPrimaryKey: row.pk > 0,
      defaultValue: row.dflt_value,
      description: null,
      maxLength: null,
    }))
  }

  protected async discoverForeignKeys(
    tableName: string,
    _schemaName: string,
  ): Promise<ForeignKey[]> {
    const escapedTable = this.escapeIdentifier(tableName)
    const db = await this.getDatabase()
    const rows = db
      .prepare(`PRAGMA foreign_key_list(${escapedTable})`)
      .all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        to: string
      }>

    return rows.map((row) => ({
      constraintName: `fk_${tableName}_${row.from}_${String(row.id)}`,
      columnName: row.from,
      referencedTable: row.table,
      referencedColumn: row.to,
      referencedSchema: 'main',
    }))
  }

  protected async discoverRowCount(tableName: string, _schemaName: string): Promise<number> {
    const escapedTable = this.escapeIdentifier(tableName)
    const db = await this.getDatabase()
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${escapedTable}`)
      .get() as { cnt: number } | undefined

    return row?.cnt ?? 0
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    const escapedTable = this.escapeIdentifier(tableName)
    const escapedColumn = this.escapeIdentifier(columnName)
    const db = await this.getDatabase()

    const rows = db
      .prepare(
        `SELECT DISTINCT ${escapedColumn} AS val
         FROM ${escapedTable}
         WHERE ${escapedColumn} IS NOT NULL
         LIMIT ?`,
      )
      .all(limit) as Array<{ val: unknown }>

    return rows.map((r) => r.val)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Escape a SQLite identifier with double quotes. */
  private escapeIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"'
  }

  private async getDatabase(): Promise<BetterSqlite3Database> {
    if (this.db) return this.db

    const Database = await loadBetterSqlite3()

    this.db = new Database(this.dbPath, { readonly: true })

    // Enable WAL mode for better concurrent read performance.
    this.db.pragma('journal_mode = WAL')

    return this.db
  }
}
