/**
 * MySQL connector — unified query execution + schema discovery.
 *
 * Uses mysql2/promise connection pool. All information_schema queries
 * use parameterized bindings (?) to prevent SQL injection.
 */

import mysql from 'mysql2/promise'
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

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ROWS = 500

export class MySQLConnector extends BaseSQLConnector {
  private readonly pool: mysql.Pool

  constructor(config: SQLConnectionConfig) {
    super(config)
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
      connectionLimit: 5,
      idleTimeout: 30_000,
      enableKeepAlive: true,
    })
  }

  // ---------------------------------------------------------------------------
  // Core interface
  // ---------------------------------------------------------------------------

  getDialect(): SQLDialect {
    return 'mysql'
  }

  /**
   * Acquire a connection and set it to READ ONLY for the session.
   * Caller is responsible for releasing the connection.
   */
  private async getReadOnlyConnection(): Promise<mysql.PoolConnection> {
    const conn = await this.pool.getConnection()
    await conn.query('SET SESSION TRANSACTION READ ONLY')
    return conn
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = Date.now()
    let conn: mysql.PoolConnection | undefined
    try {
      conn = await this.getReadOnlyConnection()
      await conn.query('SELECT 1')
      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message, latencyMs: Date.now() - start }
    } finally {
      conn?.release()
    }
  }

  async executeQuery(
    sql: string,
    options?: QueryExecutionOptions,
  ): Promise<QueryResultData> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS

    const limited = this.wrapWithLimit(sql, maxRows)
    const timed = this.wrapWithTimeout(limited, timeoutMs)

    const conn = await this.getReadOnlyConnection()
    try {
      const [rawRows, rawFields] = await conn.query({ sql: timed, timeout: timeoutMs })

      // mysql2 returns an array of RowDataPacket[] for SELECT, or ResultSetHeader for DML.
      if (!Array.isArray(rawRows)) {
        return { columns: [], rows: [], rowCount: 0, truncated: false }
      }

      const fields = rawFields as mysql.FieldPacket[]
      const columns = fields.map((f) => f.name)
      const allRows = rawRows as Record<string, unknown>[]

      const truncated = allRows.length > maxRows
      const rows = truncated ? allRows.slice(0, maxRows) : allRows

      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
      }
    } finally {
      conn.release()
    }
  }

  async destroy(): Promise<void> {
    await this.pool.end()
  }

  // ---------------------------------------------------------------------------
  // Query helpers
  // ---------------------------------------------------------------------------

  /**
   * Add a MAX_EXECUTION_TIME optimizer hint for SELECT statements.
   * For non-SELECT statements the timeout is enforced at the driver level only.
   */
  private wrapWithTimeout(sql: string, timeoutMs: number): string {
    const trimmed = sql.trim()
    // Only SELECT supports the optimizer hint
    if (!/^SELECT\b/i.test(trimmed)) return trimmed

    // Already has a hint block — do not double-wrap
    if (/\/\*\+.*MAX_EXECUTION_TIME/i.test(trimmed)) return trimmed

    const hintMs = Math.max(1, Math.round(timeoutMs))
    return trimmed.replace(
      /^SELECT\b/i,
      `SELECT /*+ MAX_EXECUTION_TIME(${String(hintMs)}) */`,
    )
  }

  // ---------------------------------------------------------------------------
  // Schema discovery — abstract method implementations
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return this.config.database
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const sql = `
      SELECT TABLE_NAME  AS tableName,
             TABLE_COMMENT AS description
      FROM   information_schema.TABLES
      WHERE  TABLE_SCHEMA = ?
        AND  TABLE_TYPE   = 'BASE TABLE'
      ORDER  BY TABLE_NAME
    `

    const conn = await this.getReadOnlyConnection()
    try {
      const [rows] = await conn.query(sql, [schemaName])
      return (rows as Array<{ tableName: string; description: string | null }>).map(
        (row) => ({
          tableName: row.tableName,
          schemaName,
          columns: [],
          foreignKeys: [],
          rowCountEstimate: 0,
          description: row.description?.trim() || null,
          sampleValues: {},
        }),
      )
    } finally {
      conn.release()
    }
  }

  protected async discoverColumns(
    tableName: string,
    schemaName: string,
  ): Promise<ColumnInfo[]> {
    const sql = `
      SELECT
        c.COLUMN_NAME       AS columnName,
        c.COLUMN_TYPE       AS dataType,
        c.IS_NULLABLE       AS isNullable,
        c.COLUMN_DEFAULT    AS defaultValue,
        c.COLUMN_COMMENT    AS description,
        c.CHARACTER_MAXIMUM_LENGTH AS maxLength,
        CASE
          WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1
          ELSE 0
        END AS isPrimaryKey
      FROM information_schema.COLUMNS c
      LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON  kcu.TABLE_SCHEMA    = c.TABLE_SCHEMA
        AND kcu.TABLE_NAME      = c.TABLE_NAME
        AND kcu.COLUMN_NAME     = c.COLUMN_NAME
        AND kcu.CONSTRAINT_NAME = 'PRIMARY'
      WHERE c.TABLE_SCHEMA = ?
        AND c.TABLE_NAME   = ?
      ORDER BY c.ORDINAL_POSITION
    `

    const conn = await this.getReadOnlyConnection()
    try {
      const [rows] = await conn.query(sql, [schemaName, tableName])
      return (
        rows as Array<{
          columnName: string
          dataType: string
          isNullable: string
          defaultValue: string | null
          description: string | null
          maxLength: number | null
          isPrimaryKey: number
        }>
      ).map((row) => ({
        columnName: row.columnName,
        dataType: row.dataType,
        isNullable: row.isNullable === 'YES',
        isPrimaryKey: row.isPrimaryKey === 1,
        defaultValue: row.defaultValue,
        description: row.description?.trim() || null,
        maxLength: row.maxLength,
      }))
    } finally {
      conn.release()
    }
  }

  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    const sql = `
      SELECT
        kcu.CONSTRAINT_NAME        AS constraintName,
        kcu.COLUMN_NAME            AS columnName,
        kcu.REFERENCED_TABLE_NAME  AS referencedTable,
        kcu.REFERENCED_COLUMN_NAME AS referencedColumn,
        kcu.REFERENCED_TABLE_SCHEMA AS referencedSchema
      FROM information_schema.KEY_COLUMN_USAGE kcu
      INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON  rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.TABLE_NAME   = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `

    const conn = await this.getReadOnlyConnection()
    try {
      const [rows] = await conn.query(sql, [schemaName, tableName])
      return (
        rows as Array<{
          constraintName: string
          columnName: string
          referencedTable: string
          referencedColumn: string
          referencedSchema: string
        }>
      ).map((row) => ({
        constraintName: row.constraintName,
        columnName: row.columnName,
        referencedTable: row.referencedTable,
        referencedColumn: row.referencedColumn,
        referencedSchema: row.referencedSchema,
      }))
    } finally {
      conn.release()
    }
  }

  protected async discoverRowCount(
    tableName: string,
    schemaName: string,
  ): Promise<number> {
    const sql = `
      SELECT TABLE_ROWS AS rowCount
      FROM   information_schema.TABLES
      WHERE  TABLE_SCHEMA = ?
        AND  TABLE_NAME   = ?
    `

    const conn = await this.getReadOnlyConnection()
    try {
      const [rows] = await conn.query(sql, [schemaName, tableName])
      const result = rows as Array<{ rowCount: number | null }>
      return result[0]?.rowCount ?? 0
    } finally {
      conn.release()
    }
  }

  protected async discoverSampleValues(
    tableName: string,
    schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    // Use backtick-quoted identifiers to avoid reserved-word collisions.
    // Schema/table/column names are NOT user input — they come from
    // information_schema discovery — but we still quote them defensively.
    const quotedTable = `\`${schemaName.replace(/`/g, '``')}\`.\`${tableName.replace(/`/g, '``')}\``
    const quotedColumn = `\`${columnName.replace(/`/g, '``')}\``

    const sql = `SELECT DISTINCT ${quotedColumn} AS val FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL LIMIT ?`

    const conn = await this.getReadOnlyConnection()
    try {
      const [rows] = await conn.query(sql, [limit])
      return (rows as Array<{ val: unknown }>).map((r) => r.val)
    } finally {
      conn.release()
    }
  }
}
