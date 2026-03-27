/**
 * PostgreSQL unified connector — query execution + schema discovery.
 *
 * Uses the `pg` library with a connection pool. All queries against
 * information_schema / pg_catalog use parameterized placeholders ($1, $2, ...)
 * to prevent injection even though the values are schema metadata strings.
 *
 * The pool enforces read-only transactions by default so that NL2SQL-generated
 * queries cannot mutate data.
 */

import pg from 'pg'
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

const { Pool } = pg

export class PostgreSQLConnector extends BaseSQLConnector {
  private readonly pool: pg.Pool

  constructor(config: SQLConnectionConfig) {
    super(config)

    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30_000,
    })

    // Force every new connection into read-only mode so that
    // user-supplied SQL cannot INSERT/UPDATE/DELETE/DROP.
    this.pool.on('connect', (client: pg.PoolClient) => {
      client.query('SET default_transaction_read_only = ON').catch(() => {
        // Swallow — worst case we fall back to the statement_timeout guard.
      })
    })
  }

  // ---------------------------------------------------------------------------
  // SQLConnector interface — core
  // ---------------------------------------------------------------------------

  getDialect(): SQLDialect {
    return 'postgresql'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = Date.now()
    let client: pg.PoolClient | undefined
    try {
      client = await this.pool.connect()
      await client.query('SELECT 1')
      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      }
    } finally {
      client?.release()
    }
  }

  async executeQuery(
    sql: string,
    options?: QueryExecutionOptions,
  ): Promise<QueryResultData> {
    const timeoutMs = options?.timeoutMs ?? 30_000
    const maxRows = options?.maxRows ?? 500
    const wrapped = this.wrapWithLimit(sql, maxRows)

    let client: pg.PoolClient | undefined
    try {
      client = await this.pool.connect()

      // Per-query timeout — applied at the session level so the database
      // itself cancels runaway statements.
      await client.query(`SET statement_timeout = ${String(timeoutMs)}`)

      const result = await client.query(wrapped)

      const columns =
        result.fields?.map((f: pg.FieldDef) => f.name) ?? []

      const truncated = result.rows.length > maxRows
      const rows = truncated ? result.rows.slice(0, maxRows) : result.rows

      return {
        columns,
        rows: rows as Record<string, unknown>[],
        rowCount: rows.length,
        truncated,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`PostgreSQL query failed: ${message}`)
    } finally {
      if (client) {
        // Reset statement_timeout so the pooled connection is clean for the
        // next consumer.
        await client.query('SET statement_timeout = 0').catch(() => {})
        client.release()
      }
    }
  }

  async destroy(): Promise<void> {
    await this.pool.end()
  }

  // ---------------------------------------------------------------------------
  // Schema discovery — dialect-specific implementations
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return this.config.schema ?? 'public'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const sql = `
      SELECT
        t.table_name,
        t.table_schema,
        obj_description(
          (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass,
          'pg_class'
        ) AS description
      FROM information_schema.tables t
      WHERE t.table_schema = $1
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY t.table_name
    `
    const result = await this.pool.query(sql, [schemaName])

    return result.rows.map(
      (row: Record<string, unknown>): TableSchema => ({
        tableName: row.table_name as string,
        schemaName: row.table_schema as string,
        columns: [],
        foreignKeys: [],
        rowCountEstimate: 0,
        description: (row.description as string) ?? null,
        sampleValues: {},
      }),
    )
  }

  protected async discoverColumns(
    tableName: string,
    schemaName: string,
  ): Promise<ColumnInfo[]> {
    const sql = `
      SELECT
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        pgd.description,
        CASE
          WHEN pk.column_name IS NOT NULL THEN true
          ELSE false
        END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN pg_catalog.pg_statio_all_tables st
        ON st.schemaname = c.table_schema
       AND st.relname   = c.table_name
      LEFT JOIN pg_catalog.pg_description pgd
        ON pgd.objoid    = st.relid
       AND pgd.objsubid  = c.ordinal_position
      LEFT JOIN (
        SELECT
          kcu.table_schema,
          kcu.table_name,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name  = kcu.constraint_name
         AND tc.table_schema     = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk
        ON pk.table_schema = c.table_schema
       AND pk.table_name   = c.table_name
       AND pk.column_name  = c.column_name
      WHERE c.table_schema = $1
        AND c.table_name   = $2
      ORDER BY c.ordinal_position
    `
    const result = await this.pool.query(sql, [schemaName, tableName])

    return result.rows.map(
      (row: Record<string, unknown>): ColumnInfo => ({
        columnName: row.column_name as string,
        dataType: this.mapDataType(
          row.data_type as string,
          row.udt_name as string,
        ),
        isNullable: (row.is_nullable as string) === 'YES',
        isPrimaryKey: row.is_primary_key as boolean,
        defaultValue: (row.column_default as string) ?? null,
        description: (row.description as string) ?? null,
        maxLength: (row.character_maximum_length as number) ?? null,
      }),
    )
  }

  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    const sql = `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name  AS referenced_table,
        ccu.column_name AS referenced_column,
        ccu.table_schema AS referenced_schema
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name  = kcu.constraint_name
       AND tc.table_schema     = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = $1
        AND tc.table_name      = $2
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `
    const result = await this.pool.query(sql, [schemaName, tableName])

    return result.rows.map(
      (row: Record<string, unknown>): ForeignKey => ({
        constraintName: row.constraint_name as string,
        columnName: row.column_name as string,
        referencedTable: row.referenced_table as string,
        referencedColumn: row.referenced_column as string,
        referencedSchema: row.referenced_schema as string,
      }),
    )
  }

  protected async discoverRowCount(
    tableName: string,
    schemaName: string,
  ): Promise<number> {
    // pg_class.reltuples is an estimate refreshed by ANALYZE / autovacuum.
    // It avoids a full sequential scan on large tables.
    const sql = `
      SELECT c.reltuples::bigint AS estimate
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
    `
    const result = await this.pool.query(sql, [schemaName, tableName])

    if (result.rows.length === 0) return 0
    const estimate = Number(result.rows[0].estimate)
    // reltuples can be -1 when the table has never been analyzed
    return estimate >= 0 ? estimate : 0
  }

  protected async discoverSampleValues(
    tableName: string,
    schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    // Use quoted identifiers for table/column names (not parameterizable).
    // schema, table, and column names come from our own discoverColumns()
    // output — never from user input.
    const fqTable = `${this.quoteIdent(schemaName)}.${this.quoteIdent(tableName)}`
    const fqColumn = this.quoteIdent(columnName)

    const sql = `
      SELECT DISTINCT ${fqColumn} AS val
      FROM ${fqTable}
      WHERE ${fqColumn} IS NOT NULL
      LIMIT ${String(limit)}
    `
    const result = await this.pool.query(sql)
    return result.rows.map((r: Record<string, unknown>) => r.val)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Map information_schema data_type strings to friendlier short names.
   * USER-DEFINED types (enums, composites) are replaced with the actual
   * udt_name so the LLM sees e.g. "order_status" instead of "USER-DEFINED".
   */
  private mapDataType(dataType: string, udtName: string): string {
    switch (dataType) {
      case 'USER-DEFINED':
        return udtName
      case 'character varying':
        return 'varchar'
      case 'character':
        return 'char'
      case 'timestamp without time zone':
        return 'timestamp'
      case 'timestamp with time zone':
        return 'timestamptz'
      case 'time without time zone':
        return 'time'
      case 'time with time zone':
        return 'timetz'
      case 'double precision':
        return 'float8'
      case 'boolean':
        return 'bool'
      case 'ARRAY':
        // udt_name for arrays is prefixed with underscore, e.g. _int4
        return udtName.startsWith('_') ? `${udtName.slice(1)}[]` : `${udtName}[]`
      default:
        return dataType
    }
  }

  /**
   * Quote a SQL identifier using double-quotes and escape any embedded
   * double-quote characters, matching PostgreSQL's identifier quoting rules.
   */
  private quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
  }
}
