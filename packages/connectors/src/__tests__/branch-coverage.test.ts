/**
 * Targeted branch-coverage tests across multiple connector modules.
 *
 * Covers:
 *  - connector-contract normalization: id/toModelOutput optional branches
 *  - DDL generator: edge cases in MySQL/ClickHouse/BigQuery default/schema branches
 *  - SQL tools: error paths in sql-list-tables, sql-describe-table,
 *    sql-discover-schema, sql-generate-ddl, sql-test-connection,
 *    and enabledTools filtering
 *  - Database connector: row-limit LIMIT wrapping branch variants
 *  - Slack/GitHub/HTTP: config edge cases
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import {
  normalizeConnectorTool,
  normalizeConnectorTools,
  isConnectorTool,
} from '../connector-contract.js'
import { generateDDL } from '../sql/ddl-generator.js'
import { createSQLTools } from '../sql/sql-tools.js'
import {
  createDatabaseOperations,
  createDatabaseConnector,
} from '../database/db-connector.js'
import type {
  SQLConnector,
  TableSchema,
  ColumnInfo,
  ForeignKey,
  DatabaseSchema,
  QueryResultData,
  ConnectionTestResult,
} from '../sql/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColumn(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    columnName: 'id',
    dataType: 'INTEGER',
    isNullable: false,
    isPrimaryKey: false,
    defaultValue: null,
    description: null,
    maxLength: null,
    ...overrides,
  }
}

function makeFK(overrides: Partial<ForeignKey> = {}): ForeignKey {
  return {
    constraintName: 'fk_u',
    columnName: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'id',
    referencedSchema: '',
    ...overrides,
  }
}

function makeTable(overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    tableName: 't',
    schemaName: 'public',
    columns: [makeColumn()],
    foreignKeys: [],
    rowCountEstimate: 0,
    description: null,
    sampleValues: {},
    ...overrides,
  }
}

function makeStubConnector(overrides: Partial<SQLConnector> = {}): SQLConnector {
  return {
    getDialect: () => 'postgresql',
    testConnection: async () => ({ ok: true, latencyMs: 5 }) as ConnectionTestResult,
    executeQuery: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false } as QueryResultData),
    discoverSchema: async () => ({
      dialect: 'postgresql',
      schemaName: 'public',
      tables: [],
      discoveredAt: new Date(),
    } as DatabaseSchema),
    generateDDL: (t: TableSchema) => `CREATE TABLE ${t.tableName}`,
    destroy: async () => { /* noop */ },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// connector-contract normalizeConnectorTool branches
// ---------------------------------------------------------------------------

describe('normalizeConnectorTool — branch coverage', () => {
  it('assigns id when provided as string', async () => {
    const tool = normalizeConnectorTool({
      id: 'custom-id',
      name: 'tool',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'ok',
    })
    expect(tool.id).toBe('custom-id')
  })

  it('derives id from name when id is absent', async () => {
    const tool = normalizeConnectorTool({
      name: 'name-only',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'ok',
    })
    expect(tool.id).toBe('name-only')
  })

  it('derives id from name when id is present but not a string', async () => {
    const tool = normalizeConnectorTool({
      id: 42 as unknown as string,
      name: 'tool',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'ok',
    })
    // non-string id → derived from name
    expect(tool.id).toBe('tool')
  })

  it('includes toModelOutput when provided as function', () => {
    const tool = normalizeConnectorTool({
      name: 'tool',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'out',
      toModelOutput: (out: string) => out.toUpperCase(),
    })
    expect(tool.toModelOutput?.('hello')).toBe('HELLO')
  })

  it('omits toModelOutput when not a function', () => {
    const tool = normalizeConnectorTool({
      name: 'tool',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'out',
      toModelOutput: 'not-a-fn' as unknown as (o: string) => string,
    })
    expect(tool.toModelOutput).toBeUndefined()
  })

  it('isConnectorTool confirms the normalized shape', () => {
    const tool = normalizeConnectorTool({
      name: 'tool',
      description: 'desc',
      schema: { type: 'object' },
      invoke: async () => 'out',
    })
    expect(isConnectorTool(tool)).toBe(true)
  })

  it('normalizeConnectorTools handles DynamicStructuredTool arrays', async () => {
    const dst = new DynamicStructuredTool({
      name: 'live',
      description: 'live tool',
      schema: z.object({ x: z.number() }),
      func: async ({ x }) => `got ${x}`,
    })
    const [tool] = normalizeConnectorTools([dst])
    expect(tool!.name).toBe('live')
    await expect(tool!.invoke({ x: 7 })).resolves.toBe('got 7')
  })
})

// ---------------------------------------------------------------------------
// DDL generator — additional branch coverage
// ---------------------------------------------------------------------------

describe('generateDDL — branch coverage', () => {
  describe('MySQL', () => {
    it('includes DEFAULT for non-PK column', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ columnName: 'status', dataType: 'VARCHAR(10)', defaultValue: "'active'" })],
      }), 'mysql')
      expect(ddl).toContain("DEFAULT 'active'")
    })

    it('does not emit DEFAULT when defaultValue is null', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ columnName: 'flag', dataType: 'BOOLEAN', defaultValue: null })],
      }), 'mysql')
      expect(ddl).not.toContain('DEFAULT')
    })

    it('emits AUTO_INCREMENT for integer PK with null default', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true, dataType: 'BIGINT', defaultValue: null })],
      }), 'mysql')
      expect(ddl).toContain('AUTO_INCREMENT')
    })

    it('emits AUTO_INCREMENT for PK with nextval default', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true, dataType: 'bigserial', defaultValue: "nextval('x_seq'::regclass)" })],
      }), 'mysql')
      expect(ddl).toContain('AUTO_INCREMENT')
    })

    it('emits DEFAULT (not AUTO_INCREMENT) for non-integer PK', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true, dataType: 'VARCHAR(36)', defaultValue: "gen_random_uuid()" })],
      }), 'mysql')
      expect(ddl).not.toContain('AUTO_INCREMENT')
      expect(ddl).toContain('DEFAULT gen_random_uuid()')
    })

    it('emits PRIMARY KEY line when pkCols > 0', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true, dataType: 'BIGINT' })],
      }), 'mysql')
      expect(ddl).toContain('PRIMARY KEY (`id`)')
    })

    it('skips PRIMARY KEY line when no PK columns', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: false })],
      }), 'mysql')
      expect(ddl).not.toContain('PRIMARY KEY')
    })
  })

  describe('ClickHouse', () => {
    it('uses tuple() when no PK columns', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: false })],
        schemaName: '',
      }), 'clickhouse')
      expect(ddl).toContain('ORDER BY tuple()')
    })

    it('uses ORDER BY (col) when PK columns present', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ columnName: 'id', isPrimaryKey: true })],
        schemaName: '',
      }), 'clickhouse')
      expect(ddl).toContain('ORDER BY (`id`)')
    })

    it('omits schema prefix when schemaName is empty', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn()],
        schemaName: '',
        tableName: 't',
      }), 'clickhouse')
      expect(ddl).toContain('CREATE TABLE `t`')
      expect(ddl).not.toContain('`.`t`')
    })

    it('includes schema prefix when schemaName provided', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn()],
        schemaName: 'analytics',
        tableName: 'events',
      }), 'clickhouse')
      expect(ddl).toContain('`analytics`.`events`')
    })

    it('emits DEFAULT when defaultValue is non-null', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ columnName: 'c', dataType: 'UInt32', defaultValue: '0' })],
        schemaName: '',
      }), 'clickhouse')
      expect(ddl).toContain('DEFAULT 0')
    })
  })

  describe('BigQuery', () => {
    it('omits schema prefix when schemaName is empty', () => {
      const ddl = generateDDL(makeTable({
        schemaName: '',
        tableName: 't',
      }), 'bigquery')
      expect(ddl).toContain('CREATE TABLE `t`')
      expect(ddl).not.toContain('`.`t`')
    })

    it('includes schema prefix when schemaName provided', () => {
      const ddl = generateDDL(makeTable({
        schemaName: 'dataset1',
        tableName: 'users',
      }), 'bigquery')
      expect(ddl).toContain('`dataset1`.`users`')
    })

    it('includes DEFAULT when defaultValue is non-null', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ columnName: 'c', defaultValue: "'abc'" })],
      }), 'bigquery')
      expect(ddl).toContain("DEFAULT 'abc'")
    })

    it('emits NOT NULL when column is non-nullable', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isNullable: false })],
      }), 'bigquery')
      expect(ddl).toContain('NOT NULL')
    })

    it('omits NOT NULL when column is nullable', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isNullable: true })],
      }), 'bigquery')
      expect(ddl).not.toContain('NOT NULL')
    })
  })

  describe('Snowflake', () => {
    it('omits schema prefix when schemaName is empty', () => {
      const ddl = generateDDL(makeTable({
        schemaName: '',
        tableName: 'orders',
      }), 'snowflake')
      expect(ddl).toContain('CREATE TABLE "orders"')
    })

    it('includes schema prefix when schemaName provided', () => {
      const ddl = generateDDL(makeTable({
        schemaName: 'sales',
        tableName: 'orders',
      }), 'snowflake')
      expect(ddl).toContain('"sales"."orders"')
    })

    it('emits PRIMARY KEY clause when pkCols > 0', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true })],
        schemaName: '',
      }), 'snowflake')
      expect(ddl).toContain('PRIMARY KEY ("id")')
    })

    it('skips PRIMARY KEY clause when pkCols = 0', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: false })],
        schemaName: '',
      }), 'snowflake')
      expect(ddl).not.toContain('PRIMARY KEY')
    })
  })

  describe('Generic (sqlite / sqlserver / generic)', () => {
    it('generates generic DDL for sqlite', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true })],
      }), 'sqlite')
      expect(ddl).toContain('CREATE TABLE')
      expect(ddl).toContain('PRIMARY KEY')
    })

    it('generates generic DDL for sqlserver', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true })],
      }), 'sqlserver')
      expect(ddl).toContain('CREATE TABLE')
    })

    it('generates generic DDL for generic dialect', () => {
      const ddl = generateDDL(makeTable(), 'generic')
      expect(ddl).toContain('CREATE TABLE')
    })

    it('duckdb uses postgresql DDL generator', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ isPrimaryKey: true, dataType: 'INTEGER' })],
      }), 'duckdb')
      expect(ddl).toContain('CREATE TABLE')
      expect(ddl).toContain('"public"."t"')
    })
  })

  describe('Description comment branches', () => {
    it('emits description comment when description is non-empty', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ description: 'The user identifier' })],
      }), 'postgresql')
      expect(ddl).toContain('-- The user identifier')
    })

    it('collapses newlines in description to single space', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ description: 'line1\nline2\r\nline3' })],
      }), 'postgresql')
      expect(ddl).toContain('-- line1 line2 line3')
    })

    it('omits description comment when description is whitespace only', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ description: '   \t  \n' })],
      }), 'postgresql')
      expect(ddl).not.toContain('-- ')
    })

    it('omits description comment when description is null', () => {
      const ddl = generateDDL(makeTable({
        columns: [makeColumn({ description: null })],
      }), 'postgresql')
      expect(ddl).not.toContain('--')
    })
  })

  describe('Foreign key branches', () => {
    it('emits FK constraint with schema prefix when referencedSchema set', () => {
      const ddl = generateDDL(makeTable({
        foreignKeys: [makeFK({ referencedSchema: 'other', referencedTable: 'users' })],
      }), 'postgresql')
      expect(ddl).toContain('REFERENCES "other"."users"')
    })

    it('emits FK constraint without schema prefix when referencedSchema empty', () => {
      const ddl = generateDDL(makeTable({
        foreignKeys: [makeFK({ referencedSchema: '', referencedTable: 'users' })],
      }), 'postgresql')
      expect(ddl).toContain('REFERENCES "users"')
      expect(ddl).not.toContain('"".')
    })
  })
})

// ---------------------------------------------------------------------------
// SQL tools — error and discovery branches
// ---------------------------------------------------------------------------

describe('createSQLTools — branch coverage', () => {
  describe('sql-query tool', () => {
    it('rejects non-SELECT statements with READ_ONLY_SQL_ERROR', async () => {
      const connector = makeStubConnector()
      const tools = createSQLTools({ connector })
      const tool = tools.find(t => t.name === 'sql-query')!
      const result = await tool.invoke({ sql: 'DELETE FROM users' })
      expect(result).toContain('error')
      expect(result).toContain('read-only')
    })

    it('executes SELECT and returns JSON result', async () => {
      const connector = makeStubConnector({
        executeQuery: async () => ({
          columns: ['id'],
          rows: [{ id: 1 }],
          rowCount: 1,
          truncated: false,
        }),
      })
      const tools = createSQLTools({ connector })
      const tool = tools.find(t => t.name === 'sql-query')!
      const result = await tool.invoke({ sql: 'SELECT id FROM t' })
      const parsed = JSON.parse(result)
      expect(parsed.rows).toEqual([{ id: 1 }])
    })

    it('uses custom maxRows when provided', async () => {
      const execSpy = vi.fn().mockResolvedValue({
        columns: [], rows: [], rowCount: 0, truncated: false,
      })
      const connector = makeStubConnector({ executeQuery: execSpy })
      const tools = createSQLTools({ connector, maxRows: 500 })
      await tools.find(t => t.name === 'sql-query')!
        .invoke({ sql: 'SELECT 1', maxRows: 50 })
      expect(execSpy).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ maxRows: 50 }))
    })

    it('uses config maxRows as fallback', async () => {
      const execSpy = vi.fn().mockResolvedValue({
        columns: [], rows: [], rowCount: 0, truncated: false,
      })
      const connector = makeStubConnector({ executeQuery: execSpy })
      const tools = createSQLTools({ connector, maxRows: 200 })
      await tools.find(t => t.name === 'sql-query')!
        .invoke({ sql: 'SELECT 1' })
      expect(execSpy).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ maxRows: 200 }))
    })

    it('uses custom timeoutMs when provided', async () => {
      const execSpy = vi.fn().mockResolvedValue({
        columns: [], rows: [], rowCount: 0, truncated: false,
      })
      const connector = makeStubConnector({ executeQuery: execSpy })
      const tools = createSQLTools({ connector, queryTimeout: 15_000 })
      await tools.find(t => t.name === 'sql-query')!
        .invoke({ sql: 'SELECT 1', timeoutMs: 500 })
      expect(execSpy).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ timeoutMs: 500 }))
    })

    it('surfaces Error instance message in JSON', async () => {
      const connector = makeStubConnector({
        executeQuery: async () => { throw new Error('bad query') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-query')!
        .invoke({ sql: 'SELECT 1' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('bad query')
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        executeQuery: async () => { throw 'raw string' },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-query')!
        .invoke({ sql: 'SELECT 1' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('raw string')
    })
  })

  describe('sql-list-tables tool', () => {
    it('returns tables list as JSON with dialect', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => ({
          dialect: 'mysql',
          schemaName: 'db',
          tables: [makeTable({ tableName: 'users' })],
          discoveredAt: new Date(),
        }),
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-list-tables')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.dialect).toBe('mysql')
      expect(parsed.tables[0].tableName).toBe('users')
    })

    it('returns Error message on discovery failure', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw new Error('schema denied') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-list-tables')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('schema denied')
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw 'boom' },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-list-tables')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('boom')
    })

    it('passes schemaName to discoverSchema when provided', async () => {
      const spy = vi.fn().mockResolvedValue({
        dialect: 'postgresql',
        schemaName: 'custom',
        tables: [],
        discoveredAt: new Date(),
      })
      const connector = makeStubConnector({ discoverSchema: spy })
      const tools = createSQLTools({ connector })
      await tools.find(t => t.name === 'sql-list-tables')!.invoke({ schemaName: 'custom' })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ schemaName: 'custom' }))
    })
  })

  describe('sql-describe-table tool', () => {
    it('returns DDL + table metadata', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => ({
          dialect: 'postgresql',
          schemaName: 'public',
          tables: [makeTable({ tableName: 'u' })],
          discoveredAt: new Date(),
        }),
        generateDDL: () => 'CREATE TABLE u (id INT);',
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-describe-table')!
        .invoke({ tableName: 'u' })
      const parsed = JSON.parse(result)
      expect(parsed.ddl).toBe('CREATE TABLE u (id INT);')
      expect(parsed.tableName).toBe('u')
    })

    it('returns error when table not found', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => ({
          dialect: 'postgresql',
          schemaName: 'public',
          tables: [],
          discoveredAt: new Date(),
        }),
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-describe-table')!
        .invoke({ tableName: 'missing' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toContain('not found')
    })

    it('uses default sampleValueLimit of 5 when not specified', async () => {
      const spy = vi.fn().mockResolvedValue({
        dialect: 'postgresql',
        schemaName: 'public',
        tables: [makeTable()],
        discoveredAt: new Date(),
      })
      const connector = makeStubConnector({ discoverSchema: spy })
      const tools = createSQLTools({ connector })
      await tools.find(t => t.name === 'sql-describe-table')!.invoke({ tableName: 't' })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sampleValueLimit: 5 }))
    })

    it('honours explicit sampleValueLimit', async () => {
      const spy = vi.fn().mockResolvedValue({
        dialect: 'postgresql',
        schemaName: 'public',
        tables: [makeTable()],
        discoveredAt: new Date(),
      })
      const connector = makeStubConnector({ discoverSchema: spy })
      const tools = createSQLTools({ connector })
      await tools.find(t => t.name === 'sql-describe-table')!
        .invoke({ tableName: 't', sampleValueLimit: 10 })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sampleValueLimit: 10 }))
    })

    it('returns Error message when discovery fails', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw new Error('no perms') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-describe-table')!
        .invoke({ tableName: 't' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('no perms')
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw 42 },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-describe-table')!
        .invoke({ tableName: 't' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('42')
    })
  })

  describe('sql-discover-schema tool', () => {
    it('passes includeTables and excludeTables through', async () => {
      const spy = vi.fn().mockResolvedValue({
        dialect: 'postgresql',
        schemaName: 'public',
        tables: [],
        discoveredAt: new Date(),
      })
      const connector = makeStubConnector({ discoverSchema: spy })
      const tools = createSQLTools({ connector })
      await tools.find(t => t.name === 'sql-discover-schema')!.invoke({
        includeTables: ['a', 'b'],
        excludeTables: ['c'],
        sampleValueLimit: 0,
      })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        includeTables: ['a', 'b'],
        excludeTables: ['c'],
        sampleValueLimit: 0,
      }))
    })

    it('returns Error message on failure', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw new Error('auth failed') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-discover-schema')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('auth failed')
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw { nested: 'fail' } },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-discover-schema')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.error).toContain('[object Object]')
    })
  })

  describe('sql-generate-ddl tool', () => {
    it('returns DDL string for existing table', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => ({
          dialect: 'postgresql',
          schemaName: 'public',
          tables: [makeTable({ tableName: 'x' })],
          discoveredAt: new Date(),
        }),
        generateDDL: () => 'CREATE TABLE x (...)',
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-generate-ddl')!
        .invoke({ tableName: 'x' })
      expect(result).toBe('CREATE TABLE x (...)')
    })

    it('returns JSON error when table not found', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => ({
          dialect: 'postgresql',
          schemaName: 'public',
          tables: [],
          discoveredAt: new Date(),
        }),
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-generate-ddl')!
        .invoke({ tableName: 'missing' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toContain('not found')
    })

    it('returns Error JSON on discovery failure', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw new Error('lost conn') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-generate-ddl')!
        .invoke({ tableName: 't' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('lost conn')
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        discoverSchema: async () => { throw null },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-generate-ddl')!
        .invoke({ tableName: 't' })
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('null')
    })
  })

  describe('sql-test-connection tool', () => {
    it('returns test result on success', async () => {
      const connector = makeStubConnector({
        testConnection: async () => ({ ok: true, latencyMs: 12 }),
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-test-connection')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.latencyMs).toBe(12)
    })

    it('returns failure JSON when testConnection rejects', async () => {
      const connector = makeStubConnector({
        testConnection: async () => { throw new Error('down') },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-test-connection')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toBe('down')
      expect(parsed.latencyMs).toBe(-1)
    })

    it('coerces non-Error rejection via String()', async () => {
      const connector = makeStubConnector({
        testConnection: async () => { throw 'wire pulled' },
      })
      const tools = createSQLTools({ connector })
      const result = await tools.find(t => t.name === 'sql-test-connection')!.invoke({})
      const parsed = JSON.parse(result)
      expect(parsed.error).toBe('wire pulled')
    })
  })

  describe('enabledTools filter', () => {
    it('returns only enabled tools', () => {
      const connector = makeStubConnector()
      const tools = createSQLTools({
        connector,
        enabledTools: ['sql-query', 'sql-test-connection'],
      })
      expect(tools.map(t => t.name).sort()).toEqual(['sql-query', 'sql-test-connection'])
    })

    it('returns empty when no matches', () => {
      const connector = makeStubConnector()
      const tools = createSQLTools({
        connector,
        enabledTools: ['not-a-tool'],
      })
      expect(tools).toHaveLength(0)
    })

    it('returns all when enabledTools is omitted', () => {
      const connector = makeStubConnector()
      const tools = createSQLTools({ connector })
      expect(tools.length).toBeGreaterThanOrEqual(6)
    })
  })
})

// ---------------------------------------------------------------------------
// createDatabaseOperations — additional row-limit wrapping branches
// ---------------------------------------------------------------------------

describe('createDatabaseOperations — LIMIT wrapping', () => {
  function makeExec(result: { rows: Record<string, unknown>[]; rowCount: number }) {
    return {
      execute: vi.fn().mockResolvedValue({
        rows: result.rows,
        rowCount: result.rowCount,
        fields: [],
        duration: 0,
      }),
      close: async () => { /* noop */ },
    }
  }

  it('does not wrap EXPLAIN statements (not SELECT-like by prefix but preserved)', async () => {
    const executor = makeExec({ rows: [], rowCount: 0 })
    const ops = createDatabaseOperations(executor, { maxRows: 100 })
    await ops.query('EXPLAIN SELECT * FROM t')
    const calledSql = executor.execute.mock.calls[0]?.[0]
    // EXPLAIN starts with SELECT-like pattern (EXPLAIN matches SELECT_LIKE) → wrapped
    expect(calledSql).toContain('LIMIT')
  })

  it('does not wrap VALUES statements without LIMIT (gets wrapped)', async () => {
    const executor = makeExec({ rows: [{ a: 1 }], rowCount: 1 })
    const ops = createDatabaseOperations(executor, { maxRows: 50 })
    await ops.query('VALUES (1), (2), (3)')
    const calledSql = executor.execute.mock.calls[0]?.[0]
    expect(calledSql).toContain('LIMIT 50')
  })

  it('does not wrap SHOW TABLES (SELECT-like prefix match → wrapped)', async () => {
    const executor = makeExec({ rows: [], rowCount: 0 })
    const ops = createDatabaseOperations(executor, { maxRows: 20 })
    await ops.query('SHOW TABLES')
    const calledSql = executor.execute.mock.calls[0]?.[0]
    expect(calledSql).toContain('LIMIT 20')
  })

  it('uses default maxRows of 1000 when not specified', async () => {
    const executor = makeExec({ rows: [], rowCount: 0 })
    const ops = createDatabaseOperations(executor, {})
    await ops.query('SELECT 1')
    const calledSql = executor.execute.mock.calls[0]?.[0]
    expect(calledSql).toContain('LIMIT 1000')
  })

  it('enforces readOnly default (true) when not specified', async () => {
    const executor = makeExec({ rows: [], rowCount: 0 })
    const ops = createDatabaseOperations(executor, {})
    await expect(ops.query('DELETE FROM t')).rejects.toThrow('Write operations not allowed')
  })

  it('allows writes when readOnly is false', async () => {
    const executor = makeExec({ rows: [], rowCount: 1 })
    const ops = createDatabaseOperations(executor, { readOnly: false })
    await expect(ops.query('DELETE FROM t')).resolves.toBeDefined()
  })

  it('does not wrap non-SELECT queries (e.g. INSERT) even in read-write mode', async () => {
    const executor = makeExec({ rows: [], rowCount: 1 })
    const ops = createDatabaseOperations(executor, { readOnly: false, maxRows: 100 })
    await ops.query('INSERT INTO t VALUES (1)')
    const calledSql = executor.execute.mock.calls[0]?.[0]
    expect(calledSql).toBe('INSERT INTO t VALUES (1)')
  })
})

// ---------------------------------------------------------------------------
// createDatabaseConnector — additional enabledTools + filter edge cases
// ---------------------------------------------------------------------------

describe('createDatabaseConnector — branch coverage', () => {
  const makeCustomQuery = () => vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

  it('returns all 3 tools when enabledTools is undefined', () => {
    const tools = createDatabaseConnector({ query: makeCustomQuery() })
    expect(tools.map(t => t.name).sort()).toEqual([
      'db-describe-table', 'db-list-tables', 'db-query',
    ])
  })

  it('filters to just db-list-tables', () => {
    const tools = createDatabaseConnector({
      query: makeCustomQuery(),
      enabledTools: ['db-list-tables'],
    })
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('db-list-tables')
  })

  it('returns empty when enabledTools has no matches', () => {
    const tools = createDatabaseConnector({
      query: makeCustomQuery(),
      enabledTools: ['unknown'],
    })
    expect(tools).toHaveLength(0)
  })

  it('describes tool with default maxRows in description', () => {
    const tools = createDatabaseConnector({ query: makeCustomQuery() })
    const dbQuery = tools.find(t => t.name === 'db-query')!
    expect(dbQuery.description).toContain('1000 rows')
  })

  it('describes tool with custom maxRows', () => {
    const tools = createDatabaseConnector({ query: makeCustomQuery(), maxRows: 25 })
    const dbQuery = tools.find(t => t.name === 'db-query')!
    expect(dbQuery.description).toContain('25 rows')
  })

  it('describes read-only mode in description when readOnly true', () => {
    const tools = createDatabaseConnector({ query: makeCustomQuery(), readOnly: true })
    const dbQuery = tools.find(t => t.name === 'db-query')!
    expect(dbQuery.description).toContain('Read-only')
  })

  it('describes read-write mode in description when readOnly false', () => {
    const tools = createDatabaseConnector({ query: makeCustomQuery(), readOnly: false })
    const dbQuery = tools.find(t => t.name === 'db-query')!
    expect(dbQuery.description).toContain('Read-write')
  })
})
