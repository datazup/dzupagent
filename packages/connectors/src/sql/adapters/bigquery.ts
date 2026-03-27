/**
 * BigQuery unified SQL connector.
 *
 * Combines query execution and schema discovery into a single connector
 * using the official @google-cloud/bigquery SDK. BigQuery is serverless
 * (HTTP-based job submission) — no persistent connection pool needed.
 *
 * Safety:
 *   - DML/DDL blocked via assertReadOnly() before reaching BigQuery
 *   - maximumBytesBilled cap (1 GB) prevents runaway cost
 */

import { BigQuery } from '@google-cloud/bigquery'
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
// Row shapes for INFORMATION_SCHEMA queries
// ---------------------------------------------------------------------------

interface InformationSchemaTableRow {
  table_name: string
  table_type: string
  description: string | null
}

interface InformationSchemaColumnRow {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
  ordinal_position: number
  description: string | null
}

interface ForeignKeyRow {
  constraint_name: string
  column_name: string
  referenced_table: string
  referenced_column: string
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class BigQueryConnector extends BaseSQLConnector {
  private readonly client: BigQuery
  private readonly projectId: string
  private readonly dataset: string

  constructor(config: SQLConnectionConfig) {
    super(config)

    this.projectId = config.projectId ?? config.database
    this.dataset = config.dataset ?? config.schema ?? 'default'

    const options: Record<string, unknown> = {
      projectId: this.projectId,
    }

    // Service account credentials as JSON string. When running in GCP,
    // Application Default Credentials (ADC) are used automatically.
    if (config.credentialsJson) {
      options['credentials'] = JSON.parse(config.credentialsJson) as unknown
    }

    this.client = new BigQuery(options)
  }

  getDialect(): SQLDialect {
    return 'bigquery'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now()
    try {
      await this.client.query('SELECT 1 AS test')
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

    this.assertReadOnly(sql)

    const wrappedSQL = this.wrapWithLimit(sql, maxRows)

    const [job] = await this.client.createQueryJob({
      query: wrappedSQL,
      defaultDataset: {
        projectId: this.projectId,
        datasetId: this.dataset,
      },
      maximumBytesBilled: '1000000000', // 1 GB cost cap
      jobTimeoutMs: timeoutMs,
    })

    const [rawRows] = await job.getQueryResults()
    const typedRows = (rawRows ?? []) as Record<string, unknown>[]

    const columns = typedRows.length > 0 ? Object.keys(typedRows[0]!) : []

    return {
      columns,
      rows: typedRows.slice(0, maxRows),
      rowCount: typedRows.length,
      truncated: typedRows.length > maxRows,
    }
  }

  /** BigQuery client is stateless (HTTP-based) — no cleanup needed. */
  async destroy(): Promise<void> {
    // No-op
  }

  // ---------------------------------------------------------------------------
  // Schema discovery
  // ---------------------------------------------------------------------------

  protected getDefaultSchema(): string {
    return this.dataset
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    const sql = `
      SELECT
        t.table_name,
        t.table_type,
        opt.option_value AS description
      FROM \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.TABLES\` t
      LEFT JOIN \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.TABLE_OPTIONS\` opt
        ON t.table_catalog = opt.table_catalog
        AND t.table_schema = opt.table_schema
        AND t.table_name = opt.table_name
        AND opt.option_name = 'description'
      WHERE t.table_type IN ('BASE TABLE', 'CLONE', 'SNAPSHOT')
      ORDER BY t.table_name
    `

    const [rows] = await this.client.query({ query: sql })
    const typedRows = rows as InformationSchemaTableRow[]

    return typedRows.map((row) => ({
      tableName: row.table_name,
      schemaName,
      columns: [],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: row.description ?? null,
      sampleValues: {},
    }))
  }

  protected async discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]> {
    const sql = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.ordinal_position,
        cfp.description
      FROM \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.COLUMNS\` c
      LEFT JOIN \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\` cfp
        ON c.table_catalog = cfp.table_catalog
        AND c.table_schema = cfp.table_schema
        AND c.table_name = cfp.table_name
        AND c.column_name = cfp.column_name
      WHERE c.table_name = @tableName
      ORDER BY c.ordinal_position
    `

    const [rows] = await this.client.query({
      query: sql,
      params: { tableName },
    })
    const typedRows = rows as InformationSchemaColumnRow[]

    // Deduplicate — COLUMN_FIELD_PATHS can produce multiple rows for STRUCT/ARRAY
    const seen = new Set<string>()
    const deduped: InformationSchemaColumnRow[] = []
    for (const row of typedRows) {
      if (!seen.has(row.column_name)) {
        seen.add(row.column_name)
        deduped.push(row)
      }
    }

    return deduped.map((row) => ({
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      isPrimaryKey: false, // BigQuery does not expose traditional PKs
      defaultValue: row.column_default ?? null,
      description: row.description ?? null,
      maxLength: this.extractMaxLength(row.data_type),
    }))
  }

  /**
   * Discover informational (unenforced) foreign key constraints.
   * Returns empty array if the INFORMATION_SCHEMA views are unavailable.
   */
  protected async discoverForeignKeys(
    tableName: string,
    schemaName: string,
  ): Promise<ForeignKey[]> {
    try {
      const sql = `
        SELECT
          tc.constraint_name,
          kcu.column_name,
          ccu.table_name AS referenced_table,
          ccu.column_name AS referenced_column
        FROM \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS\` tc
        JOIN \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE\` kcu
          ON tc.constraint_catalog = kcu.constraint_catalog
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.constraint_name = kcu.constraint_name
        JOIN \`${this.escapeProject()}.${this.escapeIdentifier(schemaName)}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE\` ccu
          ON tc.constraint_catalog = ccu.constraint_catalog
          AND tc.constraint_schema = ccu.constraint_schema
          AND tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = @tableName
        ORDER BY tc.constraint_name
      `

      const [rows] = await this.client.query({
        query: sql,
        params: { tableName },
      })
      const typedRows = rows as ForeignKeyRow[]

      return typedRows.map((row) => ({
        constraintName: row.constraint_name,
        columnName: row.column_name,
        referencedTable: row.referenced_table,
        referencedColumn: row.referenced_column,
        referencedSchema: schemaName,
      }))
    } catch {
      // Informational constraints may not be available in all BigQuery editions
      return []
    }
  }

  protected async discoverRowCount(tableName: string, schemaName: string): Promise<number> {
    try {
      const [metadata] = await this.client
        .dataset(schemaName)
        .table(tableName)
        .getMetadata()

      return Number(metadata.numRows ?? 0)
    } catch {
      return 0
    }
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    const escapedColumn = this.escapeBacktickIdentifier(columnName)
    const fqTable = `\`${this.escapeProject()}.${this.escapeBacktickIdentifier(this.dataset)}.${this.escapeBacktickIdentifier(tableName)}\``

    const sql = `
      SELECT DISTINCT ${escapedColumn} AS val
      FROM ${fqTable}
      WHERE ${escapedColumn} IS NOT NULL
      LIMIT ${String(limit)}
    `

    const [rows] = await this.client.query({ query: sql })
    return (rows as Array<{ val: unknown }>).map((row) => row.val)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Reject any SQL statement starting with a DML or DDL keyword.
   * BigQuery supports DML, so this application-level guard prevents
   * accidental writes via the NL2SQL pipeline.
   */
  private assertReadOnly(sql: string): void {
    const trimmed = sql.trim().toUpperCase()
    const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'MERGE']
    if (forbidden.some((kw) => trimmed.startsWith(kw))) {
      throw new Error('Only SELECT queries are allowed')
    }
  }

  /** Escape a BigQuery identifier with backtick quoting. */
  private escapeBacktickIdentifier(identifier: string): string {
    return '`' + identifier.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
  }

  /** Escape the project ID for fully-qualified table references. */
  private escapeProject(): string {
    return this.projectId.replace(/`/g, '')
  }

  /** Escape an identifier for INFORMATION_SCHEMA FROM clauses. */
  private escapeIdentifier(identifier: string): string {
    return identifier.replace(/`/g, '')
  }

  /** Extract max length from STRING(N) or BYTES(N) types. */
  private extractMaxLength(dataType: string): number | null {
    const match = /^(?:STRING|BYTES)\((\d+)\)$/.exec(dataType)
    if (match?.[1]) return Number(match[1])
    return null
  }
}
