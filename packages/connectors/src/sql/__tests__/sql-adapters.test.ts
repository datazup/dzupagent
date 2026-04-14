import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BaseSQLConnector } from '../base-sql-connector.js'
import type {
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
} from '../types.js'

// ---------------------------------------------------------------------------
// Configurable mock connector for testing BaseSQLConnector orchestration
// ---------------------------------------------------------------------------

interface MockConnectorConfig {
  dialect?: SQLDialect
  defaultSchema?: string
  tables?: TableSchema[]
  columns?: Record<string, ColumnInfo[]>
  foreignKeys?: Record<string, ForeignKey[]>
  rowCounts?: Record<string, number>
  sampleValues?: Record<string, Record<string, unknown[]>>
  testConnectionResult?: ConnectionTestResult
  executeQueryResult?: QueryResultData
}

class ConfigurableMockConnector extends BaseSQLConnector {
  private readonly mockConfig: Required<MockConnectorConfig>
  public discoverTablesCalled = false
  public discoverColumnsCalls: string[] = []
  public discoverForeignKeysCalls: string[] = []
  public discoverRowCountCalls: string[] = []
  public discoverSampleValuesCalls: Array<{ table: string; column: string; limit: number }> = []

  constructor(
    connConfig: SQLConnectionConfig,
    mockConfig: MockConnectorConfig = {},
  ) {
    super(connConfig)
    this.mockConfig = {
      dialect: mockConfig.dialect ?? 'generic',
      defaultSchema: mockConfig.defaultSchema ?? 'public',
      tables: mockConfig.tables ?? [],
      columns: mockConfig.columns ?? {},
      foreignKeys: mockConfig.foreignKeys ?? {},
      rowCounts: mockConfig.rowCounts ?? {},
      sampleValues: mockConfig.sampleValues ?? {},
      testConnectionResult: mockConfig.testConnectionResult ?? { ok: true, latencyMs: 1 },
      executeQueryResult: mockConfig.executeQueryResult ?? {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
      },
    }
  }

  getDialect(): SQLDialect {
    return this.mockConfig.dialect
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return this.mockConfig.testConnectionResult
  }

  async executeQuery(_sql: string, _options?: QueryExecutionOptions): Promise<QueryResultData> {
    return this.mockConfig.executeQueryResult
  }

  async destroy(): Promise<void> {
    return undefined
  }

  protected getDefaultSchema(): string {
    return this.mockConfig.defaultSchema
  }

  protected async discoverTables(
    schemaName: string,
    _options?: SchemaDiscoveryOptions,
  ): Promise<TableSchema[]> {
    this.discoverTablesCalled = true
    return this.mockConfig.tables.map((t) => ({ ...t, schemaName }))
  }

  protected async discoverColumns(
    tableName: string,
    _schemaName: string,
  ): Promise<ColumnInfo[]> {
    this.discoverColumnsCalls.push(tableName)
    return this.mockConfig.columns[tableName] ?? []
  }

  protected async discoverForeignKeys(
    tableName: string,
    _schemaName: string,
  ): Promise<ForeignKey[]> {
    this.discoverForeignKeysCalls.push(tableName)
    return this.mockConfig.foreignKeys[tableName] ?? []
  }

  protected async discoverRowCount(
    tableName: string,
    _schemaName: string,
  ): Promise<number> {
    this.discoverRowCountCalls.push(tableName)
    return this.mockConfig.rowCounts[tableName] ?? 0
  }

  protected async discoverSampleValues(
    tableName: string,
    _schemaName: string,
    columnName: string,
    limit: number,
  ): Promise<unknown[]> {
    this.discoverSampleValuesCalls.push({ table: tableName, column: columnName, limit })
    return this.mockConfig.sampleValues[tableName]?.[columnName] ?? []
  }

  /** Expose protected method for testing */
  public testWrapWithLimit(sql: string, maxRows: number): string {
    return this.wrapWithLimit(sql, maxRows)
  }
}

const baseConfig: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'testdb',
  username: 'user',
  password: 'pass',
  ssl: false,
}

// ---------------------------------------------------------------------------
// wrapWithLimit
// ---------------------------------------------------------------------------

describe('BaseSQLConnector.wrapWithLimit', () => {
  it('should add LIMIT maxRows+1', () => {
    const c = new ConfigurableMockConnector(baseConfig)
    expect(c.testWrapWithLimit('SELECT * FROM users', 100)).toBe(
      'SELECT * FROM users LIMIT 101',
    )
  })

  it('should strip trailing semicolon before adding LIMIT', () => {
    const c = new ConfigurableMockConnector(baseConfig)
    expect(c.testWrapWithLimit('SELECT 1;', 10)).toBe('SELECT 1 LIMIT 11')
  })

  it('should not add LIMIT if already present', () => {
    const c = new ConfigurableMockConnector(baseConfig)
    expect(c.testWrapWithLimit('SELECT * FROM t LIMIT 5', 100)).toBe(
      'SELECT * FROM t LIMIT 5',
    )
  })

  it('should handle LIMIT with different casing', () => {
    const c = new ConfigurableMockConnector(baseConfig)
    expect(c.testWrapWithLimit('SELECT * FROM t limit 5', 100)).toBe(
      'SELECT * FROM t limit 5',
    )
  })

  it('should handle whitespace-padded queries', () => {
    const c = new ConfigurableMockConnector(baseConfig)
    const result = c.testWrapWithLimit('  SELECT * FROM t  ;  ', 10)
    expect(result).toContain('LIMIT 11')
    expect(result).not.toContain(';')
  })
})

// ---------------------------------------------------------------------------
// discoverSchema orchestration
// ---------------------------------------------------------------------------

describe('BaseSQLConnector.discoverSchema', () => {
  it('should use default schema when none specified', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      defaultSchema: 'myschema',
      tables: [
        {
          tableName: 'items',
          schemaName: '',
          columns: [],
          foreignKeys: [],
          rowCountEstimate: 0,
          description: null,
          sampleValues: {},
        },
      ],
    })

    const schema = await c.discoverSchema()
    expect(schema.schemaName).toBe('myschema')
  })

  it('should use provided schemaName option', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      defaultSchema: 'public',
      tables: [],
    })

    const schema = await c.discoverSchema({ schemaName: 'custom' })
    expect(schema.schemaName).toBe('custom')
  })

  it('should filter tables by includeTables', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 'users', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'orders', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'products', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
    })

    const schema = await c.discoverSchema({ includeTables: ['users', 'orders'], sampleValueLimit: 0 })
    expect(schema.tables.map((t) => t.tableName)).toEqual(['users', 'orders'])
  })

  it('should filter tables by excludeTables', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 'users', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'migrations', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
    })

    const schema = await c.discoverSchema({ excludeTables: ['migrations'], sampleValueLimit: 0 })
    expect(schema.tables.map((t) => t.tableName)).toEqual(['users'])
  })

  it('should apply both include and exclude filters', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 'a', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'b', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'c', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
    })

    const schema = await c.discoverSchema({
      includeTables: ['a', 'b'],
      excludeTables: ['b'],
      sampleValueLimit: 0,
    })
    expect(schema.tables.map((t) => t.tableName)).toEqual(['a'])
  })

  it('should enrich tables with columns, FKs, and row counts', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 'users', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
      columns: {
        users: [
          { columnName: 'id', dataType: 'int', isNullable: false, isPrimaryKey: true, defaultValue: null, description: null, maxLength: null },
          { columnName: 'email', dataType: 'varchar', isNullable: false, isPrimaryKey: false, defaultValue: null, description: null, maxLength: 255 },
        ],
      },
      foreignKeys: {
        users: [],
      },
      rowCounts: {
        users: 1000,
      },
      sampleValues: {
        users: {
          id: [1, 2, 3],
          email: ['a@b.com', 'c@d.com'],
        },
      },
    })

    const schema = await c.discoverSchema({ sampleValueLimit: 3 })
    const users = schema.tables[0]!

    expect(users.columns).toHaveLength(2)
    expect(users.columns[0]!.columnName).toBe('id')
    expect(users.rowCountEstimate).toBe(1000)
    expect(users.sampleValues['id']).toEqual([1, 2, 3])
    expect(users.sampleValues['email']).toEqual(['a@b.com', 'c@d.com'])
  })

  it('should skip sample values when sampleValueLimit is 0', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 't', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
      columns: {
        t: [
          { columnName: 'x', dataType: 'int', isNullable: false, isPrimaryKey: false, defaultValue: null, description: null, maxLength: null },
        ],
      },
    })

    await c.discoverSchema({ sampleValueLimit: 0 })
    expect(c.discoverSampleValuesCalls).toHaveLength(0)
  })

  it('should handle sample value discovery failure gracefully', async () => {
    // Create a subclass that throws on sample values for one column
    class FailingSampleConnector extends ConfigurableMockConnector {
      protected override async discoverSampleValues(
        tableName: string,
        _schemaName: string,
        columnName: string,
        _limit: number,
      ): Promise<unknown[]> {
        if (columnName === 'failing_col') {
          throw new Error('Connection timeout')
        }
        return [1, 2]
      }
    }

    const c = new FailingSampleConnector(baseConfig, {
      tables: [
        { tableName: 't', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
      columns: {
        t: [
          { columnName: 'good_col', dataType: 'int', isNullable: false, isPrimaryKey: false, defaultValue: null, description: null, maxLength: null },
          { columnName: 'failing_col', dataType: 'text', isNullable: true, isPrimaryKey: false, defaultValue: null, description: null, maxLength: null },
        ],
      },
    })

    const schema = await c.discoverSchema({ sampleValueLimit: 5 })
    const table = schema.tables[0]!

    // good_col should have samples, failing_col should have empty array
    expect(table.sampleValues['good_col']).toEqual([1, 2])
    expect(table.sampleValues['failing_col']).toEqual([])
  })

  it('should include dialect in returned schema', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      dialect: 'postgresql',
      tables: [],
    })

    const schema = await c.discoverSchema()
    expect(schema.dialect).toBe('postgresql')
  })

  it('should include discoveredAt timestamp', async () => {
    const c = new ConfigurableMockConnector(baseConfig, { tables: [] })
    const before = new Date()
    const schema = await c.discoverSchema()
    const after = new Date()

    expect(schema.discoveredAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(schema.discoveredAt.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('should call discoverColumns for each table after filtering', async () => {
    const c = new ConfigurableMockConnector(baseConfig, {
      tables: [
        { tableName: 'a', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'b', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
        { tableName: 'c', schemaName: '', columns: [], foreignKeys: [], rowCountEstimate: 0, description: null, sampleValues: {} },
      ],
    })

    await c.discoverSchema({ includeTables: ['a', 'c'], sampleValueLimit: 0 })
    expect(c.discoverColumnsCalls.sort()).toEqual(['a', 'c'])
    expect(c.discoverForeignKeysCalls.sort()).toEqual(['a', 'c'])
    expect(c.discoverRowCountCalls.sort()).toEqual(['a', 'c'])
  })

  it('should return empty tables array when no tables discovered', async () => {
    const c = new ConfigurableMockConnector(baseConfig, { tables: [] })
    const schema = await c.discoverSchema()
    expect(schema.tables).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// generateDDL integration via BaseSQLConnector
// ---------------------------------------------------------------------------

describe('BaseSQLConnector.generateDDL', () => {
  it('should delegate to the generateDDL function with correct dialect', () => {
    const c = new ConfigurableMockConnector(baseConfig, { dialect: 'postgresql' })
    const table: TableSchema = {
      tableName: 'test',
      schemaName: 'public',
      columns: [
        { columnName: 'id', dataType: 'int', isNullable: false, isPrimaryKey: true, defaultValue: null, description: null, maxLength: null },
      ],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: null,
      sampleValues: {},
    }

    const ddl = c.generateDDL(table)
    expect(ddl).toContain('CREATE TABLE "public"."test"')
    expect(ddl).toContain('"id" int NOT NULL PRIMARY KEY')
  })

  it('should use correct dialect for mysql connector', () => {
    const c = new ConfigurableMockConnector(baseConfig, { dialect: 'mysql' })
    const table: TableSchema = {
      tableName: 'items',
      schemaName: 'shop',
      columns: [
        { columnName: 'id', dataType: 'int', isNullable: false, isPrimaryKey: true, defaultValue: null, description: null, maxLength: null },
      ],
      foreignKeys: [],
      rowCountEstimate: 0,
      description: null,
      sampleValues: {},
    }

    const ddl = c.generateDDL(table)
    expect(ddl).toContain('CREATE TABLE `items`')
    expect(ddl).toContain('`id`')
  })
})
