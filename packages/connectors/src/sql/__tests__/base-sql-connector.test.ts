import { describe, it, expect } from 'vitest'
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

class TestConnector extends BaseSQLConnector {
  public sampleCalls = 0

  getDialect(): SQLDialect {
    return 'generic'
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, latencyMs: 1 }
  }

  async executeQuery(_sql: string, _options?: QueryExecutionOptions): Promise<QueryResultData> {
    return { columns: [], rows: [], rowCount: 0, truncated: false }
  }

  async destroy(): Promise<void> {
    return undefined
  }

  protected getDefaultSchema(): string {
    return 'public'
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    return [
      {
        tableName: 'users',
        schemaName,
        columns: [],
        foreignKeys: [],
        rowCountEstimate: 0,
        description: null,
        sampleValues: {},
      },
      {
        tableName: 'orders',
        schemaName,
        columns: [],
        foreignKeys: [],
        rowCountEstimate: 0,
        description: null,
        sampleValues: {},
      },
    ]
  }

  protected async discoverColumns(
    _tableName: string,
    _schemaName: string,
  ): Promise<ColumnInfo[]> {
    return [
      {
        columnName: 'id',
        dataType: 'int',
        isNullable: false,
        isPrimaryKey: true,
        defaultValue: null,
        description: null,
        maxLength: null,
      },
    ]
  }

  protected async discoverForeignKeys(
    _tableName: string,
    _schemaName: string,
  ): Promise<ForeignKey[]> {
    return []
  }

  protected async discoverRowCount(_tableName: string, _schemaName: string): Promise<number> {
    return 42
  }

  protected async discoverSampleValues(
    _tableName: string,
    _schemaName: string,
    _columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    this.sampleCalls += 1
    return Array.from({ length: Math.min(limit, 2) }, (_, i) => i + 1)
  }

  public exposeWrapWithLimit(sql: string, maxRows: number): string {
    return this.wrapWithLimit(sql, maxRows)
  }
}

const config: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'test_db',
  username: 'user',
  password: 'pass',
  ssl: false,
}

describe('BaseSQLConnector.wrapWithLimit', () => {
  it('adds LIMIT maxRows+1 and strips trailing semicolon', () => {
    const connector = new TestConnector(config)
    const wrapped = connector.exposeWrapWithLimit('SELECT * FROM users;', 10)
    expect(wrapped).toBe('SELECT * FROM users LIMIT 11')
  })

  it('does not add LIMIT when query already has one', () => {
    const connector = new TestConnector(config)
    const wrapped = connector.exposeWrapWithLimit('SELECT * FROM users LIMIT 5', 10)
    expect(wrapped).toBe('SELECT * FROM users LIMIT 5')
  })
})

describe('BaseSQLConnector.discoverSchema orchestration', () => {
  it('applies include/exclude filtering in shared layer', async () => {
    const connector = new TestConnector(config)

    const schema = await connector.discoverSchema({
      includeTables: ['users', 'orders'],
      excludeTables: ['orders'],
      sampleValueLimit: 0,
    })

    expect(schema.tables.map((t) => t.tableName)).toEqual(['users'])
  })

  it('skips sample value discovery when sampleValueLimit is 0', async () => {
    const connector = new TestConnector(config)

    await connector.discoverSchema({ sampleValueLimit: 0 })

    expect(connector.sampleCalls).toBe(0)
  })

  it('collects sample values when sampleValueLimit is positive', async () => {
    const connector = new TestConnector(config)

    const schema = await connector.discoverSchema({ sampleValueLimit: 2 })

    expect(connector.sampleCalls).toBeGreaterThan(0)
    expect(schema.tables[0]!.sampleValues['id']).toEqual([1, 2])
  })
})
