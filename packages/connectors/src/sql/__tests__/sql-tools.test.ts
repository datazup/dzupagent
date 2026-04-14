import { describe, it, expect, vi } from 'vitest'
import { createSQLTools, __sqlToolsInternals } from '../sql-tools.js'
import type {
  SQLConnector,
  QueryExecutionOptions,
  QueryResultData,
  ConnectionTestResult,
  DatabaseSchema,
  SchemaDiscoveryOptions,
  TableSchema,
} from '../types.js'

function makeMockConnector(): {
  connector: SQLConnector
  executeQuery: ReturnType<typeof vi.fn>
} {
  const executeQuery = vi.fn(
    async (_sql: string, _options?: QueryExecutionOptions): Promise<QueryResultData> => ({
      columns: ['id'],
      rows: [{ id: 1 }],
      rowCount: 1,
      truncated: false,
    }),
  )

  const discoverSchema = vi.fn(
    async (_options?: SchemaDiscoveryOptions): Promise<DatabaseSchema> => ({
      dialect: 'mysql',
      schemaName: 'public',
      discoveredAt: new Date('2026-03-30T00:00:00.000Z'),
      tables: [
        {
          tableName: 'users',
          schemaName: 'public',
          columns: [],
          foreignKeys: [],
          rowCountEstimate: 1,
          description: null,
          sampleValues: {},
        },
      ],
    }),
  )

  const connector: SQLConnector = {
    getDialect: () => 'mysql',
    testConnection: async (): Promise<ConnectionTestResult> => ({ ok: true, latencyMs: 1 }),
    executeQuery,
    discoverSchema,
    generateDDL: (_table: TableSchema) => 'CREATE TABLE users (id INT)',
    destroy: async () => undefined,
  }

  return { connector, executeQuery }
}

describe('sql-tools read-only enforcement', () => {
  it('allows SELECT queries and passes default limits/timeouts', async () => {
    const { connector, executeQuery } = makeMockConnector()
    const tools = createSQLTools({ connector, maxRows: 123, queryTimeout: 456 })
    const sqlQuery = tools.find((t) => t.name === 'sql-query')!

    const raw = await sqlQuery.invoke({ sql: 'SELECT * FROM users' })
    const result = JSON.parse(raw as string) as QueryResultData

    expect(result.rowCount).toBe(1)
    expect(executeQuery).toHaveBeenCalledWith('SELECT * FROM users', {
      maxRows: 123,
      timeoutMs: 456,
    })
  })

  it('allows WITH queries after leading comments', async () => {
    const { connector, executeQuery } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlQuery = tools.find((t) => t.name === 'sql-query')!

    const raw = await sqlQuery.invoke({
      sql: '/* report query */\n-- cte follows\nWITH t AS (SELECT 1 AS id) SELECT * FROM t',
    })

    const result = JSON.parse(raw as string) as QueryResultData
    expect(result.rowCount).toBe(1)
    expect(executeQuery).toHaveBeenCalledTimes(1)
  })

  it('blocks write queries and does not call connector.executeQuery', async () => {
    const { connector, executeQuery } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlQuery = tools.find((t) => t.name === 'sql-query')!

    const raw = await sqlQuery.invoke({ sql: 'DELETE FROM users WHERE id = 1' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('Only read-only queries are allowed')
    expect(executeQuery).not.toHaveBeenCalled()
  })
})

describe('sql-tools internals', () => {
  it('recognizes SELECT/WITH and rejects DML', () => {
    expect(__sqlToolsInternals.isReadOnlySQL('SELECT 1')).toBe(true)
    expect(__sqlToolsInternals.isReadOnlySQL('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(__sqlToolsInternals.isReadOnlySQL('UPDATE users SET active = false')).toBe(false)
  })

  it('strips leading SQL comments correctly', () => {
    expect(__sqlToolsInternals.stripLeadingComments('-- one\nSELECT 1')).toBe('SELECT 1')
    expect(__sqlToolsInternals.stripLeadingComments('/* one */ SELECT 1')).toBe('SELECT 1')
    expect(__sqlToolsInternals.stripLeadingComments('/* unclosed')).toBe('')
  })

  it('strips comments and literals from SQL', () => {
    // DML keyword in comment should be replaced
    const result = __sqlToolsInternals.stripCommentsAndLiterals("SELECT 'INSERT' FROM t -- DELETE")
    expect(result).not.toContain('INSERT')
    expect(result).not.toContain('DELETE')
    expect(result).toContain('SELECT')
  })
})

// ---------------------------------------------------------------------------
// sql-list-tables tool
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-list-tables', () => {
  it('returns table listing from discoverSchema', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const listTool = tools.find((t) => t.name === 'sql-list-tables')!

    const raw = await listTool.invoke({})
    const result = JSON.parse(raw as string) as { dialect: string; tables: Array<{ tableName: string }> }

    expect(result.dialect).toBe('mysql')
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]!.tableName).toBe('users')
  })

  it('passes schemaName option', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const listTool = tools.find((t) => t.name === 'sql-list-tables')!

    await listTool.invoke({ schemaName: 'analytics' })

    expect(connector.discoverSchema).toHaveBeenCalledWith(
      expect.objectContaining({ schemaName: 'analytics', sampleValueLimit: 0 }),
    )
  })

  it('returns error on failure', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockRejectedValue(new Error('DB offline'))
    const tools = createSQLTools({ connector })
    const listTool = tools.find((t) => t.name === 'sql-list-tables')!

    const raw = await listTool.invoke({})
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('DB offline')
  })
})

// ---------------------------------------------------------------------------
// sql-describe-table tool
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-describe-table', () => {
  it('returns table info with DDL', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const describeTool = tools.find((t) => t.name === 'sql-describe-table')!

    const raw = await describeTool.invoke({ tableName: 'users' })
    const result = JSON.parse(raw as string) as { tableName: string; ddl: string }

    expect(result.tableName).toBe('users')
    expect(result.ddl).toBe('CREATE TABLE users (id INT)')
  })

  it('returns error when table not found', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockResolvedValue({
      dialect: 'mysql',
      schemaName: 'public',
      discoveredAt: new Date(),
      tables: [],
    })
    const tools = createSQLTools({ connector })
    const describeTool = tools.find((t) => t.name === 'sql-describe-table')!

    const raw = await describeTool.invoke({ tableName: 'nonexistent' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain("'nonexistent' not found")
  })

  it('returns error on failure', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockRejectedValue(new Error('timeout'))
    const tools = createSQLTools({ connector })
    const describeTool = tools.find((t) => t.name === 'sql-describe-table')!

    const raw = await describeTool.invoke({ tableName: 'users' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('timeout')
  })
})

// ---------------------------------------------------------------------------
// sql-discover-schema tool
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-discover-schema', () => {
  it('returns full schema discovery result', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const discoverTool = tools.find((t) => t.name === 'sql-discover-schema')!

    const raw = await discoverTool.invoke({})
    const result = JSON.parse(raw as string) as { dialect: string; tables: unknown[] }

    expect(result.dialect).toBe('mysql')
    expect(result.tables).toHaveLength(1)
  })

  it('passes options through', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const discoverTool = tools.find((t) => t.name === 'sql-discover-schema')!

    await discoverTool.invoke({
      schemaName: 'custom',
      includeTables: ['users'],
      excludeTables: ['logs'],
      sampleValueLimit: 3,
    })

    expect(connector.discoverSchema).toHaveBeenCalledWith({
      schemaName: 'custom',
      includeTables: ['users'],
      excludeTables: ['logs'],
      sampleValueLimit: 3,
    })
  })

  it('returns error on failure', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockRejectedValue(new Error('access denied'))
    const tools = createSQLTools({ connector })
    const discoverTool = tools.find((t) => t.name === 'sql-discover-schema')!

    const raw = await discoverTool.invoke({})
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('access denied')
  })
})

// ---------------------------------------------------------------------------
// sql-generate-ddl tool
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-generate-ddl', () => {
  it('generates DDL for a table', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const ddlTool = tools.find((t) => t.name === 'sql-generate-ddl')!

    const raw = await ddlTool.invoke({ tableName: 'users' })

    expect(raw).toBe('CREATE TABLE users (id INT)')
  })

  it('returns error when table not found', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockResolvedValue({
      dialect: 'mysql',
      schemaName: 'public',
      discoveredAt: new Date(),
      tables: [],
    })
    const tools = createSQLTools({ connector })
    const ddlTool = tools.find((t) => t.name === 'sql-generate-ddl')!

    const raw = await ddlTool.invoke({ tableName: 'nonexistent' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain("'nonexistent' not found")
  })

  it('returns error on failure', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.discoverSchema).mockRejectedValue(new Error('boom'))
    const tools = createSQLTools({ connector })
    const ddlTool = tools.find((t) => t.name === 'sql-generate-ddl')!

    const raw = await ddlTool.invoke({ tableName: 'users' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('boom')
  })
})

// ---------------------------------------------------------------------------
// sql-test-connection tool
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-test-connection', () => {
  it('returns connection test result', async () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const testTool = tools.find((t) => t.name === 'sql-test-connection')!

    const raw = await testTool.invoke({})
    const result = JSON.parse(raw as string) as { ok: boolean; latencyMs: number }

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBe(1)
  })

  it('returns error on failure', async () => {
    const { connector } = makeMockConnector()
    connector.testConnection = vi.fn().mockRejectedValue(new Error('refused'))
    const tools = createSQLTools({ connector })
    const testTool = tools.find((t) => t.name === 'sql-test-connection')!

    const raw = await testTool.invoke({})
    const result = JSON.parse(raw as string) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('refused')
  })
})

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

describe('createSQLTools — enabledTools filtering', () => {
  it('returns all 6 tools by default', () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({ connector })

    expect(tools).toHaveLength(6)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'sql-describe-table',
      'sql-discover-schema',
      'sql-generate-ddl',
      'sql-list-tables',
      'sql-query',
      'sql-test-connection',
    ])
  })

  it('filters to only enabled tools', () => {
    const { connector } = makeMockConnector()
    const tools = createSQLTools({
      connector,
      enabledTools: ['sql-query', 'sql-test-connection'],
    })

    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.name).sort()).toEqual(['sql-query', 'sql-test-connection'])
  })
})

// ---------------------------------------------------------------------------
// sql-query error handling
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-query error handling', () => {
  it('returns error JSON when executeQuery throws', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.executeQuery).mockRejectedValue(new Error('connection lost'))
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find((t) => t.name === 'sql-query')!

    const raw = await sqlTool.invoke({ sql: 'SELECT 1' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toContain('connection lost')
  })

  it('returns error JSON when executeQuery throws non-Error', async () => {
    const { connector } = makeMockConnector()
    vi.mocked(connector.executeQuery).mockRejectedValue('raw string')
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find((t) => t.name === 'sql-query')!

    const raw = await sqlTool.invoke({ sql: 'SELECT 1' })
    const result = JSON.parse(raw as string) as { error: string }

    expect(result.error).toBe('raw string')
  })

  it('passes maxRows and timeoutMs overrides from input', async () => {
    const { connector, executeQuery } = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find((t) => t.name === 'sql-query')!

    await sqlTool.invoke({ sql: 'SELECT 1', maxRows: 99, timeoutMs: 1234 })

    expect(executeQuery).toHaveBeenCalledWith('SELECT 1', {
      maxRows: 99,
      timeoutMs: 1234,
    })
  })
})
