/**
 * ClickHouse unified SQL connector.
 *
 * Combines query execution and schema discovery into a single connector
 * using the official @clickhouse/client (HTTP transport). ClickHouse does not
 * support foreign key constraints; `discoverForeignKeys` always returns [].
 *
 * No explicit read-only enforcement is needed — ClickHouse is an OLAP engine
 * that does not support UPDATE/DELETE. INSERT is the only write operation
 * and is blocked by the SQL safety validator at the application level.
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

import type * as ClickHousePkg from '@clickhouse/client'

type ClickHouseModule = typeof ClickHousePkg
type ClickHouseClient = ClickHousePkg.ClickHouseClient

const runtimeRequire = createRequire(import.meta.url)
const CLICKHOUSE_DRIVER_PACKAGE = '@clickhouse/client'

let clickhouseModule: ClickHouseModule | undefined

function isMissingModuleError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
  )
}

function loadClickHouseModule(): ClickHouseModule {
  if (clickhouseModule) return clickhouseModule

  try {
    clickhouseModule = runtimeRequire(CLICKHOUSE_DRIVER_PACKAGE) as ClickHouseModule
    return clickhouseModule
  } catch (error: unknown) {
    if (isMissingModuleError(error)) {
      throw new Error(
        `ClickHouseConnector requires the optional dependency "${CLICKHOUSE_DRIVER_PACKAGE}". Install it with: yarn add ${CLICKHOUSE_DRIVER_PACKAGE}`,
      )
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// ClickHouse JSON response shape
// ---------------------------------------------------------------------------

interface ClickHouseJSONResponse {
  meta?: ReadonlyArray<{ name: string; type: string }>
  data?: ReadonlyArray<Record<string, unknown>>
  rows?: number
  statistics?: {
    elapsed: number
    rows_read: number
    bytes_read: number
  }
}

// ---------------------------------------------------------------------------
// Row shapes for system table queries
// ---------------------------------------------------------------------------

interface SystemTableRow {
  name: string
  comment: string
  total_rows: string
}

interface SystemColumnRow {
  name: string
  type: string
  default_kind: string
  default_expression: string
  comment: string
  is_in_primary_key: number
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class ClickHouseConnector extends BaseSQLConnector {
  private readonly client: ClickHouseClient

  constructor(config: SQLConnectionConfig) {
    super(config)
    const { createClient } = loadClickHouseModule()

    const host = config.host.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    const protocol = config.ssl ? 'https' : 'http'
    this.client = createClient({
      url: `${protocol}://${host}:${String(config.port)}`,
      username: config.username,
      password: config.password,
      database: config.database,
    })
  }

  getDialect(): SQLDialect {
    return 'clickhouse'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      const resultSet = await this.client.query({ query: 'SELECT 1', format: 'JSON' })
      await resultSet.json()
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

    // Convert ms to seconds for ClickHouse's max_execution_time setting
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))

    const wrappedSQL = this.wrapWithLimit(sql, maxRows)

    const resultSet = await this.client.query({
      query: wrappedSQL,
      format: 'JSON',
      clickhouse_settings: {
        max_execution_time: timeoutSeconds,
      },
    })

    const response = await resultSet.json<ClickHouseJSONResponse>()
    const columns = response.meta?.map((m) => m.name) ?? []
    const rows = (response.data ?? []) as Record<string, unknown>[]

    return {
      columns,
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated: rows.length > maxRows,
    }
  }

  async destroy(): Promise<void> {
    await this.client.close()
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return 'default'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const resultSet = await this.client.query({
      query: `
        SELECT
          name,
          comment,
          toString(total_rows) AS total_rows
        FROM system.tables
        WHERE database = {schemaName: String}
          AND engine NOT IN ('View', 'MaterializedView', 'LiveView')
        ORDER BY name
      `,
      format: 'JSONEachRow',
      query_params: { schemaName },
    })

    const rows = await resultSet.json<SystemTableRow>()

    return rows.map((row) => ({
      tableName: row.name,
      schemaName,
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: row.comment || null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]> {
    const resultSet = await this.client.query({
      query: `
        SELECT
          name,
          type,
          default_kind,
          default_expression,
          comment,
          is_in_primary_key
        FROM system.columns
        WHERE database = {schemaName: String}
          AND table = {tableName: String}
        ORDER BY position
      `,
      format: 'JSONEachRow',
      query_params: { schemaName, tableName },
    })

    const rows = await resultSet.json<SystemColumnRow>()

    return rows.map((row) => ({
      columnName: row.name,
      dataType: row.type,
      isNullable: this.isNullableType(row.type),
      isPrimaryKey: row.is_in_primary_key === 1,
      defaultValue: row.default_kind !== '' ? row.default_expression : null,
      description: row.comment || null,
      maxLength: this.extractMaxLength(row.type),
    }))
  }

  /** ClickHouse does not support foreign key constraints. */
  protected async discoverForeignKeys(
    _tableName: string,
    _schemaName: string,
  ): Promise<ForeignKey[]> {
    return []
  }

  protected async discoverRowCount(tableName: string, schemaName: string): Promise<number> {
    const resultSet = await this.client.query({
      query: `
        SELECT toString(total_rows) AS total_rows
        FROM system.tables
        WHERE database = {schemaName: String}
          AND name = {tableName: String}
      `,
      format: 'JSONEachRow',
      query_params: { schemaName, tableName },
    })

    const rows = await resultSet.json<{ total_rows: string }>()
    if (rows.length === 0) return 0
    return Number(rows[0]!.total_rows ?? 0)
  }

  protected async discoverSampleValues(
    tableName: string,
    schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    const escapedSchema = this.escapeIdentifier(schemaName)
    const escapedTable = this.escapeIdentifier(tableName)
    const escapedColumn = this.escapeIdentifier(columnName)

    // Cannot use query_params for identifiers, so we escape manually.
    // The limit is safe because it is always a number from our own code.
    const resultSet = await this.client.query({
      query: `
        SELECT DISTINCT ${escapedColumn} AS val
        FROM ${escapedSchema}.${escapedTable}
        WHERE ${escapedColumn} IS NOT NULL
        LIMIT ${String(limit)}
      `,
      format: 'JSONEachRow',
    })

    const rows = await resultSet.json<{ val: unknown }>()
    return rows.map((row) => row.val)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine if a ClickHouse type is nullable.
   * Handles Nullable(T) and LowCardinality(Nullable(T)).
   */
  private isNullableType(type: string): boolean {
    const inner = type.startsWith('LowCardinality(')
      ? type.slice('LowCardinality('.length, -1)
      : type
    return inner.startsWith('Nullable(')
  }

  /** Extract max length for FixedString(N) types. */
  private extractMaxLength(type: string): number | null {
    const match = /FixedString\((\d+)\)/.exec(type)
    if (match?.[1]) return Number(match[1])
    return null
  }

  /** Escape a ClickHouse identifier with double quotes. */
  private escapeIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"'
  }
}
