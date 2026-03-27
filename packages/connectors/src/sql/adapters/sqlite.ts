/**
 * SQLite unified SQL connector.
 *
 * Combines query execution and schema discovery using better-sqlite3.
 * Opens the database in readonly mode to prevent writes. The synchronous
 * better-sqlite3 API is wrapped in async methods to match the connector
 * interface.
 */

import Database from 'better-sqlite3'
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

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class SQLiteConnector extends BaseSQLConnector {
  private readonly db: Database.Database

  constructor(config: SQLConnectionConfig) {
    super(config)

    const dbPath = config.filePath ?? config.database
    if (!dbPath) {
      throw new Error('SQLite requires a filePath or database path')
    }

    this.db = new Database(dbPath, { readonly: true })

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL')
  }

  getDialect(): SQLDialect {
    return 'sqlite'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      this.db.prepare('SELECT 1').get()
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

    const stmt = this.db.prepare(limitedSQL)
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
    this.db.close()
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
    const rows = this.db
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
    const rows = this.db
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
    const rows = this.db
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
    const row = this.db
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

    const rows = this.db
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
}
