/**
 * SQL Server unified SQL connector.
 *
 * Combines query execution and schema discovery using the mssql package
 * (tedious driver). Opens a connection pool (max 5) and sets READ UNCOMMITTED
 * isolation level for read-only behavior.
 *
 * T-SQL uses TOP N instead of LIMIT — the wrapWithLimit method is overridden
 * to inject `SELECT TOP N` syntax.
 */

// @ts-expect-error — mssql lacks bundled type declarations in this env
import mssql from 'mssql'
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

export class SQLServerConnector extends BaseSQLConnector {
  private readonly pool: mssql.ConnectionPool
  private poolConnected: Promise<mssql.ConnectionPool>

  constructor(config: SQLConnectionConfig) {
    super(config)

    const mssqlConfig: mssql.config = {
      server: config.host,
      port: config.port || 1433,
      database: config.database,
      user: config.username,
      password: config.password,
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30_000,
      },
      options: {
        encrypt: config.ssl,
        trustServerCertificate: true,
      },
    }

    this.pool = new mssql.ConnectionPool(mssqlConfig)
    this.poolConnected = this.pool.connect()
  }

  getDialect(): SQLDialect {
    return 'sqlserver'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      await this.poolConnected
      await this.pool.request().query('SELECT 1 AS ok')
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
    const timeoutMs = options?.timeoutMs ?? 30_000
    const maxRows = options?.maxRows ?? 500

    const limitedSQL = this.wrapWithLimit(sql, maxRows)

    await this.poolConnected
    const request = this.pool.request()
    request.timeout = timeoutMs

    // Set read-only isolation level to prevent accidental writes
    const fullSQL = `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${limitedSQL}`
    const result = await request.query(fullSQL)

    const recordset = result.recordset ?? []
    const columns = recordset.length > 0 ? Object.keys(recordset[0]!) : []

    return {
      columns,
      rows: recordset.slice(0, maxRows) as Record<string, unknown>[],
      rowCount: recordset.length,
      truncated: recordset.length > maxRows,
    }
  }

  async destroy(): Promise<void> {
    await this.pool.close()
  }

  // ---------------------------------------------------------------------------
  // T-SQL LIMIT override — uses TOP N instead of LIMIT
  // ---------------------------------------------------------------------------

  /**
   * T-SQL uses `SELECT TOP N ...` instead of `... LIMIT N`.
   * Injects TOP after SELECT (handles SELECT DISTINCT too).
   */
  protected override wrapWithLimit(sql: string, maxRows: number): string {
    const trimmed = sql.trim().replace(/;$/, '')
    // Already has TOP or LIMIT
    if (/\bTOP\s+\d+/i.test(trimmed) || /\bLIMIT\s+\d+/i.test(trimmed)) {
      return trimmed
    }
    // Inject TOP after SELECT (handles SELECT DISTINCT too)
    return trimmed.replace(
      /^(SELECT\s+(?:DISTINCT\s+)?)/i,
      `$1TOP ${String(maxRows + 1)} `,
    )
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return 'dbo'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    await this.poolConnected
    const result = await this.pool
      .request()
      .input('schemaName', mssql.VarChar, schemaName)
      .query(
        `SELECT TABLE_NAME AS tableName
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = @schemaName
           AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
      )

    return result.recordset.map((row: Record<string, unknown>) => ({
      tableName: row['tableName'] as string,
      schemaName,
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]> {
    await this.poolConnected
    const result = await this.pool
      .request()
      .input('schemaName', mssql.VarChar, schemaName)
      .input('tableName', mssql.VarChar, tableName)
      .query(
        `SELECT
           c.COLUMN_NAME AS columnName,
           c.DATA_TYPE AS dataType,
           c.IS_NULLABLE AS isNullable,
           c.COLUMN_DEFAULT AS defaultValue,
           c.CHARACTER_MAXIMUM_LENGTH AS maxLength,
           CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey
         FROM INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN (
           SELECT ku.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
             ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
             AND tc.TABLE_SCHEMA = @schemaName
             AND tc.TABLE_NAME = @tableName
         ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
         WHERE c.TABLE_SCHEMA = @schemaName
           AND c.TABLE_NAME = @tableName
         ORDER BY c.ORDINAL_POSITION`,
      )

    return result.recordset.map((row: Record<string, unknown>) => ({
      columnName: row['columnName'] as string,
      dataType: (row['dataType'] as string).toLowerCase(),
      isNullable: (row['isNullable'] as string) === 'YES',
      isPrimaryKey: (row['isPrimaryKey'] as number) === 1,
      defaultValue: row['defaultValue'] != null ? String(row['defaultValue']) : null,
      description: null,
      maxLength: row['maxLength'] != null ? Number(row['maxLength']) : null,
    }))
  }

  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    await this.poolConnected
    const result = await this.pool
      .request()
      .input('schemaName', mssql.VarChar, schemaName)
      .input('tableName', mssql.VarChar, tableName)
      .query(
        `SELECT
           fk.name AS constraintName,
           COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS columnName,
           OBJECT_NAME(fkc.referenced_object_id) AS referencedTable,
           COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referencedColumn,
           SCHEMA_NAME(rt.schema_id) AS referencedSchema
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc
           ON fk.object_id = fkc.constraint_object_id
         JOIN sys.tables rt
           ON fkc.referenced_object_id = rt.object_id
         WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = @schemaName
           AND OBJECT_NAME(fk.parent_object_id) = @tableName
         ORDER BY fk.name, fkc.constraint_column_id`,
      )

    return result.recordset.map((row: Record<string, unknown>) => ({
      constraintName: row['constraintName'] as string,
      columnName: row['columnName'] as string,
      referencedTable: row['referencedTable'] as string,
      referencedColumn: row['referencedColumn'] as string,
      referencedSchema: row['referencedSchema'] as string,
    }))
  }

  protected async discoverRowCount(tableName: string, schemaName: string): Promise<number> {
    await this.poolConnected
    const result = await this.pool
      .request()
      .input('schemaName', mssql.VarChar, schemaName)
      .input('tableName', mssql.VarChar, tableName)
      .query(
        `SELECT SUM(p.rows) AS rowCount
         FROM sys.partitions p
         JOIN sys.tables t ON p.object_id = t.object_id
         WHERE SCHEMA_NAME(t.schema_id) = @schemaName
           AND t.name = @tableName
           AND p.index_id IN (0, 1)`,
      )

    const row = result.recordset[0] as Record<string, unknown> | undefined
    return row ? Number(row['rowCount'] ?? 0) : 0
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    await this.poolConnected
    const escapedTable = this.escapeIdentifier(tableName)
    const escapedColumn = this.escapeIdentifier(columnName)

    const result = await this.pool.request().query(
      `SELECT DISTINCT TOP ${String(limit)} ${escapedColumn} AS val
       FROM ${escapedTable}
       WHERE ${escapedColumn} IS NOT NULL`,
    )

    return result.recordset.map((row: Record<string, unknown>) => row['val'])
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Escape a SQL Server identifier with bracket quoting. */
  private escapeIdentifier(identifier: string): string {
    return '[' + identifier.replace(/\]/g, ']]') + ']'
  }
}
