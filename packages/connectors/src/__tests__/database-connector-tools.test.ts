/**
 * Database connector tool invocation tests — covers tool func() handlers,
 * custom query executor, formatting, error handling, lazy init, and
 * additional operations coverage.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createDatabaseConnector,
  createDatabaseConnectorToolkit,
  createDatabaseOperations,
} from '../database/db-connector.js'

describe('Database connector — tool invocations', () => {
  function mockQuery(
    result: { rows: Record<string, unknown>[]; rowCount: number } = { rows: [], rowCount: 0 },
  ) {
    return vi.fn().mockResolvedValue(result)
  }

  function tool(name: string, config = {}) {
    const query = mockQuery({ rows: [{ id: 1 }], rowCount: 1 })
    const tools = createDatabaseConnector({ query, ...config })
    return { tool: tools.find(t => t.name === name)!, query }
  }

  // ── db-query ──────────────────────────────────────────

  describe('db-query', () => {
    it('returns formatted results for successful query', async () => {
      const { tool: t } = tool('db-query')
      const result = await t.invoke({ sql: 'SELECT 1 AS id', params: [] })
      expect(result).toContain('id')
      expect(result).toContain('1 rows')
    })

    it('returns error message for write query in read-only mode', async () => {
      const { tool: t } = tool('db-query')
      const result = await t.invoke({ sql: 'DROP TABLE users' })
      expect(result).toContain('Query error')
      expect(result).toContain('Write operations not allowed')
    })

    it('returns 0 rows message for empty result', async () => {
      const query = mockQuery({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-query')!
      const result = await t.invoke({ sql: 'SELECT * FROM empty', params: [] })
      expect(result).toContain('0 rows')
    })

    it('returns error message when query throws', async () => {
      const query = vi.fn().mockRejectedValue(new Error('connection lost'))
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-query')!
      const result = await t.invoke({ sql: 'SELECT 1', params: [] })
      expect(result).toContain('Query error')
      expect(result).toContain('connection lost')
    })

    it('handles non-Error thrown values', async () => {
      const query = vi.fn().mockRejectedValue('raw error string')
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-query')!
      const result = await t.invoke({ sql: 'SELECT 1' })
      expect(result).toContain('Query error')
      expect(result).toContain('raw error string')
    })

    it('formats multiple columns and rows', async () => {
      const query = mockQuery({
        rows: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
        rowCount: 2,
      })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-query')!
      const result = await t.invoke({ sql: 'SELECT * FROM users' })
      expect(result).toContain('name | age')
      expect(result).toContain('Alice | 30')
      expect(result).toContain('Bob | 25')
      expect(result).toContain('2 rows')
    })

    it('formats NULL values', async () => {
      const query = mockQuery({
        rows: [{ name: null, value: undefined }],
        rowCount: 1,
      })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-query')!
      const result = await t.invoke({ sql: 'SELECT * FROM t' })
      expect(result).toContain('NULL')
    })
  })

  // ── db-list-tables ────────────────────────────────────

  describe('db-list-tables', () => {
    it('returns formatted table list', async () => {
      const query = mockQuery({
        rows: [
          { table_name: 'users', table_schema: 'public' },
          { table_name: 'orders', table_schema: 'public' },
        ],
        rowCount: 2,
      })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-list-tables')!
      const result = await t.invoke({})
      expect(result).toContain('public.users')
      expect(result).toContain('public.orders')
    })

    it('returns no tables message when schema is empty', async () => {
      const query = mockQuery({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-list-tables')!
      const result = await t.invoke({ schema: 'empty_schema' })
      expect(result).toContain('No tables found')
      expect(result).toContain('empty_schema')
    })

    it('returns error message on failure', async () => {
      const query = vi.fn().mockRejectedValue(new Error('permission denied'))
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-list-tables')!
      const result = await t.invoke({})
      expect(result).toContain('Error listing tables')
      expect(result).toContain('permission denied')
    })
  })

  // ── db-describe-table ─────────────────────────────────

  describe('db-describe-table', () => {
    it('returns formatted table description', async () => {
      let callCount = 0
      const query = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // describeTable
          return {
            rows: [
              { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true },
              { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: "'unnamed'", is_primary_key: false },
            ],
            rowCount: 2,
          }
        }
        // getTableInfo -> rowCount
        return { rows: [{ estimate: 1000 }], rowCount: 1 }
      })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-describe-table')!
      const result = await t.invoke({ table: 'users' })
      expect(result).toContain('Table: public.users')
      expect(result).toContain('id')
      expect(result).toContain('PK')
      expect(result).toContain('NOT NULL')
      expect(result).toContain("DEFAULT 'unnamed'")
    })

    it('returns not found message for empty columns', async () => {
      const query = mockQuery({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-describe-table')!
      const result = await t.invoke({ table: 'nonexistent' })
      expect(result).toContain('not found or has no columns')
    })

    it('returns error message on failure', async () => {
      const query = vi.fn().mockRejectedValue(new Error('timeout'))
      const tools = createDatabaseConnector({ query })
      const t = tools.find(t => t.name === 'db-describe-table')!
      const result = await t.invoke({ table: 'users' })
      expect(result).toContain('Error describing table')
    })
  })

  // ── createDatabaseOperations ──────────────────────────

  describe('createDatabaseOperations', () => {
    it('wraps SELECT queries with LIMIT when no LIMIT present', async () => {
      const executeFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [], duration: 0 })
      const executor = { execute: executeFn, close: vi.fn() }
      const ops = createDatabaseOperations(executor, { readOnly: true, maxRows: 100 })
      await ops.query('SELECT * FROM users')
      expect(executeFn).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 100'),
        undefined,
      )
    })

    it('does not add LIMIT when query already has LIMIT', async () => {
      const executeFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [], duration: 0 })
      const executor = { execute: executeFn, close: vi.fn() }
      const ops = createDatabaseOperations(executor, { readOnly: true, maxRows: 100 })
      await ops.query('SELECT * FROM users LIMIT 10')
      expect(executeFn).toHaveBeenCalledWith('SELECT * FROM users LIMIT 10', undefined)
    })

    it('allows write queries when readOnly is false', async () => {
      const executeFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [], duration: 0 })
      const executor = { execute: executeFn, close: vi.fn() }
      const ops = createDatabaseOperations(executor, { readOnly: false })
      await ops.query('INSERT INTO t VALUES (1)')
      expect(executeFn).toHaveBeenCalled()
    })

    it('healthCheck returns true on success', async () => {
      const executor = {
        execute: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1, fields: [], duration: 0 }),
        close: vi.fn(),
      }
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(true)
    })

    it('healthCheck returns false on failure', async () => {
      const executor = {
        execute: vi.fn().mockRejectedValue(new Error('down')),
        close: vi.fn(),
      }
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(false)
    })

    it('getTableInfo handles missing row count gracefully', async () => {
      const executeFn = vi.fn()
        // describeTable
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
          fields: [],
          duration: 0,
        })
        // rowCount query fails
        .mockRejectedValueOnce(new Error('pg_class not accessible'))
      const executor = { execute: executeFn, close: vi.fn() }
      const ops = createDatabaseOperations(executor, {})
      const info = await ops.getTableInfo('users')
      expect(info.name).toBe('users')
      expect(info.columns).toHaveLength(1)
      // rowCount should be undefined when query fails
      expect(info.rowCount).toBeUndefined()
    })

    it('close calls executor close', async () => {
      const closeFn = vi.fn()
      const executor = { execute: vi.fn(), close: closeFn }
      const ops = createDatabaseOperations(executor, {})
      await ops.close()
      expect(closeFn).toHaveBeenCalled()
    })
  })

  // ── Toolkit factory ──────────────────────────────────

  describe('createDatabaseConnectorToolkit', () => {
    it('returns toolkit with name and tools', () => {
      const tk = createDatabaseConnectorToolkit({
        query: mockQuery({ rows: [], rowCount: 0 }),
      })
      expect(tk.name).toBe('database')
      expect(tk.tools).toHaveLength(3)
    })

    it('filters tools via enabledTools', () => {
      const tk = createDatabaseConnectorToolkit({
        query: mockQuery({ rows: [], rowCount: 0 }),
        enabledTools: ['db-query'],
      })
      expect(tk.tools).toHaveLength(1)
      expect(tk.tools[0]!.name).toBe('db-query')
    })

    it('uses custom databaseName in tool descriptions', () => {
      const tk = createDatabaseConnectorToolkit({
        query: mockQuery({ rows: [], rowCount: 0 }),
        databaseName: 'analytics_db',
      })
      const desc = tk.tools[0]!.description
      expect(desc).toContain('analytics_db')
    })
  })

  // ── Lazy initialization ──────────────────────────────

  describe('lazy initialization', () => {
    it('reuses ops on second call', async () => {
      const queryFn = mockQuery({ rows: [{ id: 1 }], rowCount: 1 })
      const tools = createDatabaseConnector({ query: queryFn })
      const t = tools.find(t => t.name === 'db-query')!

      await t.invoke({ sql: 'SELECT 1' })
      await t.invoke({ sql: 'SELECT 2' })

      // queryFn is called once for each query invocation
      expect(queryFn).toHaveBeenCalledTimes(2)
    })
  })
})
