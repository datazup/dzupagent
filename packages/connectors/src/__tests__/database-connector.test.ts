/**
 * Tests for the database connector — covers read-only enforcement,
 * parameterized query execution, result formatting, schema introspection,
 * table listing, table description, health check, row limits, tool filtering,
 * error handling, and custom vs pg executor paths.
 */
import { describe, it, expect, vi } from 'vitest'
import { createDatabaseConnector, createDatabaseOperations } from '../database/db-connector.js'
import type { DatabaseConnectorConfig } from '../database/db-connector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockQuery(rows: Record<string, unknown>[] = [], rowCount?: number) {
  return vi.fn().mockResolvedValue({ rows, rowCount: rowCount ?? rows.length })
}

function makeConfig(overrides: Partial<DatabaseConnectorConfig> = {}): DatabaseConnectorConfig {
  return { query: mockQuery(), ...overrides }
}

// ---------------------------------------------------------------------------
// Read-only enforcement
// ---------------------------------------------------------------------------

describe('Database connector', () => {
  describe('read-only mode', () => {
    const writeStatements = [
      'INSERT INTO users (name) VALUES ($1)',
      'UPDATE users SET name = $1 WHERE id = $2',
      'DELETE FROM users WHERE id = $1',
      'DROP TABLE users',
      'ALTER TABLE users ADD COLUMN age INT',
      'CREATE TABLE temp (id INT)',
      'TRUNCATE users',
      'GRANT SELECT ON users TO reader',
      'REVOKE ALL ON users FROM public',
      'MERGE INTO target USING source ON target.id = source.id',
      'COPY users TO STDOUT',
    ]

    for (const sql of writeStatements) {
      const keyword = sql.trim().split(/\s/)[0]!
      it(`blocks ${keyword} in read-only mode`, async () => {
        const tools = createDatabaseConnector(makeConfig({ readOnly: true }))
        const dbQuery = tools.find(t => t.name === 'db-query')!
        const result = await dbQuery.invoke({ sql })
        expect(result).toContain('not allowed')
        expect(result).toContain('read-only')
      })
    }

    it('allows SELECT queries in read-only mode', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 AS id' })
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalled()
    })

    it('allows WITH (CTE) queries in read-only mode', async () => {
      const query = mockQuery([{ cnt: 5 }])
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({
        sql: 'WITH active AS (SELECT * FROM users WHERE active) SELECT count(*) AS cnt FROM active',
      })
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalled()
    })

    it('defaults to read-only when readOnly is omitted', async () => {
      const tools = createDatabaseConnector(makeConfig())
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'DELETE FROM users' })
      expect(result).toContain('not allowed')
    })
  })

  // ---------------------------------------------------------------------------
  // Read-write mode
  // ---------------------------------------------------------------------------

  describe('read-write mode', () => {
    it('allows write queries when readOnly is false', async () => {
      const query = mockQuery([], 3)
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'DELETE FROM users WHERE active = false' })
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Result formatting
  // ---------------------------------------------------------------------------

  describe('result formatting', () => {
    it('formats results as a readable table', async () => {
      const query = mockQuery([
        { id: 1, name: 'Alice', email: 'alice@test.com' },
        { id: 2, name: 'Bob', email: 'bob@test.com' },
      ])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM users' })

      expect(result).toContain('id')
      expect(result).toContain('name')
      expect(result).toContain('email')
      expect(result).toContain('Alice')
      expect(result).toContain('Bob')
      expect(result).toContain('2 rows')
    })

    it('reports 0 rows for empty results', async () => {
      const tools = createDatabaseConnector(makeConfig({ query: mockQuery([]) }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM empty_table' })
      expect(result).toContain('0 rows')
    })

    it('handles NULL values in results', async () => {
      const query = mockQuery([{ id: 1, name: null }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM users' })
      expect(result).toContain('NULL')
    })

    it('includes duration in output', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 AS id' })
      expect(result).toMatch(/\d+ms/)
    })
  })

  // ---------------------------------------------------------------------------
  // Parameterized queries
  // ---------------------------------------------------------------------------

  describe('parameterized queries', () => {
    it('passes params to the query function', async () => {
      const query = mockQuery([{ id: 1, name: 'Alice' }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT * FROM users WHERE id = $1', params: [1] })
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        [1],
      )
    })

    it('defaults to empty params array', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT 1 AS id' })
      expect(query).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Max row limit
  // ---------------------------------------------------------------------------

  describe('max row limit', () => {
    it('wraps SELECT queries without LIMIT', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query, maxRows: 50 }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT * FROM users' })

      const calledSql = query.mock.calls[0]![0] as string
      expect(calledSql).toContain('LIMIT 50')
    })

    it('does not wrap queries that already have LIMIT', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query, maxRows: 50 }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT * FROM users LIMIT 10' })

      const calledSql = query.mock.calls[0]![0] as string
      expect(calledSql).not.toContain('LIMIT 50')
      expect(calledSql).toContain('LIMIT 10')
    })

    it('defaults to 1000 row limit', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT * FROM users' })

      const calledSql = query.mock.calls[0]![0] as string
      expect(calledSql).toContain('LIMIT 1000')
    })
  })

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('catches query errors and returns friendly message', async () => {
      const query = vi.fn().mockRejectedValue(new Error('relation "users" does not exist'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM users' })

      expect(result).toContain('Query error')
      expect(result).toContain('relation "users" does not exist')
    })

    it('handles non-Error thrown values', async () => {
      const query = vi.fn().mockRejectedValue('unexpected string error')
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(result).toContain('Query error')
      expect(result).toContain('unexpected string error')
    })
  })

  // ---------------------------------------------------------------------------
  // db-list-tables tool
  // ---------------------------------------------------------------------------

  describe('db-list-tables tool', () => {
    it('lists tables from public schema by default', async () => {
      const query = mockQuery([
        { table_name: 'users', table_schema: 'public' },
        { table_name: 'posts', table_schema: 'public' },
      ])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('public.users')
      expect(result).toContain('public.posts')
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        ['public'],
      )
    })

    it('lists tables from a custom schema', async () => {
      const query = mockQuery([
        { table_name: 'events', table_schema: 'analytics' },
      ])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({ schema: 'analytics' })

      expect(result).toContain('analytics.events')
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        ['analytics'],
      )
    })

    it('reports no tables found for empty schema', async () => {
      const tools = createDatabaseConnector(makeConfig({ query: mockQuery([]) }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('No tables found')
    })

    it('handles errors gracefully', async () => {
      const query = vi.fn().mockRejectedValue(new Error('permission denied'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('Error listing tables')
      expect(result).toContain('permission denied')
    })
  })

  // ---------------------------------------------------------------------------
  // db-describe-table tool
  // ---------------------------------------------------------------------------

  describe('db-describe-table tool', () => {
    it('describes table columns with types and constraints', async () => {
      // First call: describeTable (columns), second call: getTableInfo (row count)
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true },
            { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null, is_primary_key: false },
            { column_name: 'status', data_type: 'varchar', is_nullable: 'NO', column_default: "'active'", is_primary_key: false },
          ],
          rowCount: 3,
        })
        .mockResolvedValueOnce({
          rows: [{ estimate: 42000 }],
          rowCount: 1,
        })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'users' })

      expect(result).toContain('Table: public.users')
      expect(result).toContain('id')
      expect(result).toContain('integer')
      expect(result).toContain('NOT NULL')
      expect(result).toContain('PK')
      expect(result).toContain('name')
      expect(result).toContain('text')
      expect(result).toContain('NULL')
      expect(result).toContain("DEFAULT 'active'")
      expect(result).toContain('42000')
    })

    it('reports table not found for empty column list', async () => {
      const query = mockQuery([])
      // Mock the row count call too
      query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector(makeConfig({ query }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'nonexistent' })

      expect(result).toContain('not found')
    })

    it('handles errors gracefully', async () => {
      const query = vi.fn().mockRejectedValue(new Error('access denied'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'secret_table' })

      expect(result).toContain('Error describing table')
      expect(result).toContain('access denied')
    })
  })

  // ---------------------------------------------------------------------------
  // Tool metadata
  // ---------------------------------------------------------------------------

  describe('tool metadata', () => {
    it('uses custom database name in descriptions', () => {
      const tools = createDatabaseConnector(makeConfig({ databaseName: 'analytics_db' }))
      for (const tool of tools) {
        expect(tool.description).toContain('analytics_db')
      }
    })

    it('uses default database name when not specified', () => {
      const tools = createDatabaseConnector(makeConfig())
      for (const tool of tools) {
        expect(tool.description).toContain('database')
      }
    })

    it('creates three tools by default', () => {
      const tools = createDatabaseConnector(makeConfig())
      expect(tools).toHaveLength(3)
      expect(tools.map(t => t.name)).toEqual(['db-query', 'db-list-tables', 'db-describe-table'])
    })
  })

  // ---------------------------------------------------------------------------
  // Tool filtering
  // ---------------------------------------------------------------------------

  describe('tool filtering', () => {
    it('filters to only enabled tools', () => {
      const tools = createDatabaseConnector(makeConfig({ enabledTools: ['db-query'] }))
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('db-query')
    })

    it('returns all tools when enabledTools is undefined', () => {
      const tools = createDatabaseConnector(makeConfig())
      expect(tools).toHaveLength(3)
    })
  })

  // ---------------------------------------------------------------------------
  // DatabaseOperations (programmatic API)
  // ---------------------------------------------------------------------------

  describe('createDatabaseOperations', () => {
    function makeExecutor(queryFn: DatabaseConnectorConfig['query']) {
      return {
        async execute(sql: string, params?: unknown[]) {
          const result = await queryFn!(sql, params)
          const firstRow = result.rows[0] as Record<string, unknown> | undefined
          return {
            rows: result.rows as Record<string, unknown>[],
            rowCount: result.rowCount,
            fields: firstRow ? Object.keys(firstRow).map(n => ({ name: n, type: 'unknown' })) : [],
            duration: 1,
          }
        },
        async close() { /* noop */ },
      }
    }

    it('healthCheck returns true on success', async () => {
      const executor = makeExecutor(mockQuery([{ ok: 1 }]))
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(true)
    })

    it('healthCheck returns false on failure', async () => {
      const executor = makeExecutor(vi.fn().mockRejectedValue(new Error('connection refused')))
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(false)
    })

    it('listTables returns structured data', async () => {
      const executor = makeExecutor(
        mockQuery([
          { table_name: 'users', table_schema: 'public' },
          { table_name: 'posts', table_schema: 'public' },
        ]),
      )
      const ops = createDatabaseOperations(executor, {})
      const tables = await ops.listTables()
      expect(tables).toHaveLength(2)
      expect(tables[0]!.name).toBe('users')
      expect(tables[0]!.schema).toBe('public')
    })

    it('query throws in read-only mode for write statements', async () => {
      const executor = makeExecutor(mockQuery())
      const ops = createDatabaseOperations(executor, { readOnly: true })
      await expect(ops.query('DROP TABLE users')).rejects.toThrow('not allowed')
    })

    it('close calls executor close', async () => {
      const closeFn = vi.fn()
      const executor = {
        ...makeExecutor(mockQuery()),
        close: closeFn,
      }
      const ops = createDatabaseOperations(executor, {})
      await ops.close()
      expect(closeFn).toHaveBeenCalled()
    })
  })
})
