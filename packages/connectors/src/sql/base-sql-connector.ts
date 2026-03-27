/**
 * Abstract base class for unified SQL connectors.
 *
 * Handles shared orchestration for schema discovery (parallel enrichment,
 * table filtering) while delegating dialect-specific logic to subclasses.
 *
 * Migrated from @nl2sql/schema-discovery/base-adapter.ts + @nl2sql/db-connectors.
 */

import type {
  SQLConnector,
  SQLDialect,
  SQLConnectionConfig,
  QueryExecutionOptions,
  QueryResultData,
  ConnectionTestResult,
  DatabaseSchema,
  TableSchema,
  ColumnInfo,
  ForeignKey,
  SchemaDiscoveryOptions,
} from './types.js'
import { generateDDL } from './ddl-generator.js'

export abstract class BaseSQLConnector implements SQLConnector {
  protected readonly config: SQLConnectionConfig

  constructor(config: SQLConnectionConfig) {
    this.config = config
  }

  abstract getDialect(): SQLDialect
  abstract testConnection(): Promise<ConnectionTestResult>
  abstract executeQuery(sql: string, options?: QueryExecutionOptions): Promise<QueryResultData>
  abstract destroy(): Promise<void>

  // --- Schema discovery (shared orchestration) ---

  async discoverSchema(options?: SchemaDiscoveryOptions): Promise<DatabaseSchema> {
    const schemaName = options?.schemaName ?? this.getDefaultSchema()
    const tables = await this.discoverTables(schemaName, options)
    const filtered = this.filterTables(tables, options)
    const enriched = await Promise.all(
      filtered.map((t) => this.enrichTable(t, schemaName, options)),
    )

    return {
      dialect: this.getDialect(),
      schemaName,
      tables: enriched,
      discoveredAt: new Date(),
    }
  }

  generateDDL(table: TableSchema): string {
    return generateDDL(table, this.getDialect())
  }

  // --- Abstract methods for dialect-specific schema discovery ---

  protected abstract getDefaultSchema(): string
  protected abstract discoverTables(schemaName: string, options?: SchemaDiscoveryOptions): Promise<TableSchema[]>
  protected abstract discoverColumns(tableName: string, schemaName: string): Promise<ColumnInfo[]>
  protected abstract discoverForeignKeys(tableName: string, schemaName: string): Promise<ForeignKey[]>
  protected abstract discoverRowCount(tableName: string, schemaName: string): Promise<number>
  protected abstract discoverSampleValues(tableName: string, schemaName: string, columnName: string, limit: number): Promise<unknown[]>

  // --- Query helpers ---

  /**
   * Wraps a SQL statement with a LIMIT clause when not already present.
   * Requests maxRows+1 to detect truncation.
   */
  protected wrapWithLimit(sql: string, maxRows: number): string {
    const trimmed = sql.trim().replace(/;$/, '')
    if (/\bLIMIT\s+\d+/i.test(trimmed)) return trimmed
    return `${trimmed} LIMIT ${String(maxRows + 1)}`
  }

  // --- Private helpers ---

  private filterTables(tables: TableSchema[], options?: SchemaDiscoveryOptions): TableSchema[] {
    let result = tables
    if (options?.includeTables?.length) {
      const includeSet = new Set(options.includeTables)
      result = result.filter((t) => includeSet.has(t.tableName))
    }
    if (options?.excludeTables?.length) {
      const excludeSet = new Set(options.excludeTables)
      result = result.filter((t) => !excludeSet.has(t.tableName))
    }
    return result
  }

  private async enrichTable(
    table: TableSchema,
    schemaName: string,
    options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema> {
    const sampleLimit = options?.sampleValueLimit ?? 5

    const [columns, foreignKeys, rowCount] = await Promise.all([
      this.discoverColumns(table.tableName, schemaName),
      this.discoverForeignKeys(table.tableName, schemaName),
      this.discoverRowCount(table.tableName, schemaName),
    ])

    const sampleValues: Record<string, unknown[]> = {}
    if (sampleLimit > 0) {
      const results = await Promise.all(
        columns.map((col) =>
          this.discoverSampleValues(table.tableName, schemaName, col.columnName, sampleLimit)
            .then((values) => ({ columnName: col.columnName, values }))
            .catch(() => ({ columnName: col.columnName, values: [] as unknown[] })),
        ),
      )
      for (const { columnName, values } of results) {
        sampleValues[columnName] = values
      }
    }

    return { ...table, columns, foreignKeys, rowCountEstimate: rowCount, sampleValues }
  }
}
