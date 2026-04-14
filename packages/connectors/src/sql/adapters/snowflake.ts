/**
 * Snowflake unified SQL connector.
 *
 * Combines query execution and schema discovery into a single connector
 * using the official snowflake-sdk (callback-based, promisified here).
 *
 * Uses a lazy single connection that is reused across queries.
 * Read-only enforcement relies on the SQL safety validator blocking DML
 * at the application level. Timeout is enforced via ALTER SESSION.
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

import type * as SnowflakePkg from 'snowflake-sdk'

type SnowflakeSDK = typeof SnowflakePkg
type SnowflakeConnection = ReturnType<SnowflakeSDK['createConnection']>

const runtimeRequire = createRequire(import.meta.url)
const SNOWFLAKE_DRIVER_PACKAGE = 'snowflake-sdk'

let snowflakeModulePromise: Promise<SnowflakeSDK> | null = null

function isMissingModuleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
  )
}

function assertSnowflakeDriverInstalled(): void {
  try {
    runtimeRequire.resolve(SNOWFLAKE_DRIVER_PACKAGE)
  } catch (error: unknown) {
    if (isMissingModuleError(error)) {
      throw new Error(
        `SnowflakeConnector requires the optional dependency "${SNOWFLAKE_DRIVER_PACKAGE}". Install it with: yarn add ${SNOWFLAKE_DRIVER_PACKAGE}`,
      )
    }
    throw error
  }
}

async function loadSnowflakeSDK(): Promise<SnowflakeSDK> {
  if (!snowflakeModulePromise) {
    assertSnowflakeDriverInstalled()
    snowflakeModulePromise = import('snowflake-sdk')
      .then((mod) => {
        const loaded = mod as SnowflakeSDK & { default?: SnowflakeSDK }
        const snowflake = loaded.default ?? loaded

        // Suppress noisy OCSP logging in non-production environments.
        snowflake.configure({ logLevel: 'WARN' })
        return snowflake
      })
      .catch((error: unknown) => {
        if (isMissingModuleError(error)) {
          throw new Error(
            `SnowflakeConnector requires the optional dependency "${SNOWFLAKE_DRIVER_PACKAGE}". Install it with: yarn add ${SNOWFLAKE_DRIVER_PACKAGE}`,
          )
        }
        throw error
      })
  }

  return snowflakeModulePromise
}

// ---------------------------------------------------------------------------
// Row shapes for INFORMATION_SCHEMA queries
// ---------------------------------------------------------------------------

interface InfoSchemaTableRow {
  TABLE_NAME: string
  TABLE_TYPE: string
  COMMENT: string | null
}

interface InfoSchemaColumnRow {
  COLUMN_NAME: string
  DATA_TYPE: string
  IS_NULLABLE: string
  COLUMN_DEFAULT: string | null
  ORDINAL_POSITION: number
  CHARACTER_MAXIMUM_LENGTH: number | null
  COMMENT: string | null
}

interface InfoSchemaForeignKeyRow {
  CONSTRAINT_NAME: string
  COLUMN_NAME: string
  REFERENCED_TABLE: string
  REFERENCED_COLUMN: string
  REFERENCED_SCHEMA: string
}

interface InfoSchemaRowCountRow {
  ROW_COUNT: number
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class SnowflakeConnector extends BaseSQLConnector {
  private connection: SnowflakeConnection | null = null
  private connecting: Promise<SnowflakeConnection> | null = null

  constructor(config: SQLConnectionConfig) {
    super(config)
    assertSnowflakeDriverInstalled()
  }

  getDialect(): SQLDialect {
    return 'snowflake'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      await this.query('SELECT 1 AS test')
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

    // Set session-level timeout before executing the user query
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
    await this.query(
      `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${String(timeoutSeconds)}`,
    )

    const wrappedSQL = this.wrapWithLimit(sql, maxRows)
    const rows = await this.query<Record<string, unknown>>(wrappedSQL)

    const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
    const truncated = rows.length > maxRows

    return {
      columns,
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated,
    }
  }

  async destroy(): Promise<void> {
    if (this.connection) {
      await new Promise<void>((resolve, reject) => {
        this.connection!.destroy((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.connection = null
      this.connecting = null
    }
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return 'PUBLIC'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const rows = await this.query<InfoSchemaTableRow>(
      `SELECT TABLE_NAME, TABLE_TYPE, COMMENT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_NAME`,
      [schemaName],
    )

    return rows.map((row) => ({
      tableName: row.TABLE_NAME,
      schemaName,
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: row.COMMENT ?? null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]> {
    const rows = await this.query<InfoSchemaColumnRow>(
      `SELECT
         COLUMN_NAME,
         DATA_TYPE,
         IS_NULLABLE,
         COLUMN_DEFAULT,
         ORDINAL_POSITION,
         CHARACTER_MAXIMUM_LENGTH,
         COMMENT
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [schemaName, tableName],
    )

    return rows.map((row) => ({
      columnName: row.COLUMN_NAME,
      dataType: this.mapDataType(row.DATA_TYPE),
      isNullable: row.IS_NULLABLE === 'YES',
      isPrimaryKey: false, // Snowflake INFORMATION_SCHEMA.COLUMNS does not expose PK
      defaultValue: row.COLUMN_DEFAULT,
      description: row.COMMENT ?? null,
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
    }))
  }

  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    const rows = await this.query<InfoSchemaForeignKeyRow>(
      `SELECT
         tc.CONSTRAINT_NAME,
         kcu.COLUMN_NAME,
         kcu2.TABLE_NAME   AS REFERENCED_TABLE,
         kcu2.COLUMN_NAME  AS REFERENCED_COLUMN,
         kcu2.TABLE_SCHEMA AS REFERENCED_SCHEMA
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
         ON rc.UNIQUE_CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME
         AND rc.UNIQUE_CONSTRAINT_SCHEMA = kcu2.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = ?
         AND tc.TABLE_NAME = ?
         AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      [schemaName, tableName],
    )

    return rows.map((row) => ({
      constraintName: row.CONSTRAINT_NAME,
      columnName: row.COLUMN_NAME,
      referencedTable: row.REFERENCED_TABLE,
      referencedColumn: row.REFERENCED_COLUMN,
      referencedSchema: row.REFERENCED_SCHEMA,
    }))
  }

  protected async discoverRowCount(tableName: string, schemaName: string): Promise<number> {
    const rows = await this.query<InfoSchemaRowCountRow>(
      `SELECT ROW_COUNT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?`,
      [schemaName, tableName],
    )

    if (rows.length === 0) return 0
    const rowCount = rows[0]?.ROW_COUNT
    return typeof rowCount === 'number' ? rowCount : 0
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    const escapedColumn = this.escapeIdentifier(columnName)
    const escapedTable = this.escapeIdentifier(tableName)

    const rows = await this.query<{ val: unknown }>(
      `SELECT DISTINCT ${escapedColumn} AS "val"
       FROM ${escapedTable}
       WHERE ${escapedColumn} IS NOT NULL
       LIMIT ${String(limit)}`,
    )

    return rows.map((row) => row.val)
  }

  // ---------------------------------------------------------------------------
  // Snowflake LIMIT override — wraps in subquery for safety
  // ---------------------------------------------------------------------------

  protected override wrapWithLimit(sql: string, maxRows: number): string {
    const trimmed = sql.trim().replace(/;$/, '')
    if (/\bLIMIT\s+\d+/i.test(trimmed)) return trimmed
    return `SELECT * FROM (${trimmed}) AS _sub LIMIT ${String(maxRows + 1)}`
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Lazily establishes and caches a Snowflake connection.
   * Uses a shared promise to avoid duplicate concurrent connect() calls.
   */
  private async getConnection(): Promise<SnowflakeConnection> {
    if (this.connection) return this.connection

    if (this.connecting) return this.connecting

    this.connecting = (async () => {
      const snowflake = await loadSnowflakeSDK()
      const opts: Parameters<SnowflakeSDK['createConnection']>[0] = {
        account: this.config.account ?? this.config.host,
        username: this.config.username,
        password: this.config.password,
        database: this.config.database,
        schema: this.config.schema ?? 'PUBLIC',
      }
      if (this.config.warehouse) opts.warehouse = this.config.warehouse
      if (this.config.role) opts.role = this.config.role

      const conn = snowflake.createConnection(opts)

      return await new Promise<SnowflakeConnection>((resolve, reject) => {
        conn.connect((err, connected) => {
          if (err) {
            this.connecting = null
            reject(new Error(`Snowflake connection failed: ${err.message}`))
          } else {
            this.connection = connected
            resolve(connected)
          }
        })
      })
    })()

    return this.connecting
  }

  /**
   * Execute a SQL query and return result rows.
   * Supports bind parameters (positional ? placeholders).
   */
  private async query<T = Record<string, unknown>>(
    sql: string,
    binds: SnowflakePkg.Binds = [],
  ): Promise<T[]> {
    const conn = await this.getConnection()

    return new Promise<T[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds,
        streamResult: false,
        complete: (err, _stmt, rows) => {
          if (err) {
            reject(new Error(`Snowflake query error: ${err.message}`))
          } else {
            resolve((rows ?? []) as T[])
          }
        },
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Escape a Snowflake identifier with double quotes. */
  private escapeIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"'
  }

  /**
   * Normalize Snowflake data type names to a consistent form.
   * Snowflake INFORMATION_SCHEMA reports types in UPPERCASE.
   */
  private mapDataType(dataType: string): string {
    switch (dataType.toUpperCase()) {
      case 'NUMBER':
        return 'NUMBER'
      case 'DECIMAL':
      case 'NUMERIC':
        return 'NUMERIC'
      case 'INT':
      case 'INTEGER':
      case 'BIGINT':
      case 'SMALLINT':
      case 'TINYINT':
      case 'BYTEINT':
        return dataType.toUpperCase()
      case 'FLOAT':
      case 'FLOAT4':
      case 'FLOAT8':
      case 'DOUBLE':
      case 'DOUBLE PRECISION':
      case 'REAL':
        return 'FLOAT'
      case 'VARCHAR':
      case 'STRING':
      case 'TEXT':
      case 'CHAR':
      case 'CHARACTER':
        return 'VARCHAR'
      case 'BINARY':
      case 'VARBINARY':
        return 'BINARY'
      case 'BOOLEAN':
        return 'BOOLEAN'
      case 'DATE':
        return 'DATE'
      case 'DATETIME':
      case 'TIMESTAMP':
      case 'TIMESTAMP_NTZ':
        return 'TIMESTAMP_NTZ'
      case 'TIMESTAMP_LTZ':
        return 'TIMESTAMP_LTZ'
      case 'TIMESTAMP_TZ':
        return 'TIMESTAMP_TZ'
      case 'TIME':
        return 'TIME'
      case 'VARIANT':
        return 'VARIANT'
      case 'OBJECT':
        return 'OBJECT'
      case 'ARRAY':
        return 'ARRAY'
      case 'GEOGRAPHY':
        return 'GEOGRAPHY'
      case 'GEOMETRY':
        return 'GEOMETRY'
      default:
        return dataType.toUpperCase()
    }
  }
}
