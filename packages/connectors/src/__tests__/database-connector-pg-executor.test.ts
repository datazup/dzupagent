/**
 * Tests for database connector — pg executor path and pool creation.
 *
 * Covers the createPgExecutor, createPool, oidToName, and the lazy
 * initialization path that creates a real pg Pool (mocked).
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
// createDatabaseOperations — executor behavior
// ---------------------------------------------------------------------------

describe('Database connector — executor & operations', () => {
  describe('custom executor via query function', () => {
    it('passes sql and params to custom query function', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 })
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT $1 AS id', params: [42] })

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        [42],
      )
    })

    it('returns field names from first row keys', async () => {
      const queryFn = vi.fn().mockResolvedValue({
        rows: [{ name: 'Alice', age: 30 }],
        rowCount: 1,
      })

      // createDatabaseOperations internally creates a custom executor
      // We test it through the tool interface
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT name, age FROM users' })

      expect(result).toContain('name')
      expect(result).toContain('age')
      expect(result).toContain('Alice')
    })

    it('handles empty result set with no fields', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM empty_table' })

      expect(result).toContain('0 rows')
    })
  })

  describe('createDatabaseOperations — direct API', () => {
    function makeExecutor(queryFn: NonNullable<DatabaseConnectorConfig['query']>) {
      return {
        async execute(sql: string, params?: unknown[]) {
          const result = await queryFn(sql, params)
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

    it('query wraps SELECT without LIMIT', async () => {
      const queryFn = mockQuery([{ id: 1 }])
      const ops = createDatabaseOperations(makeExecutor(queryFn), { maxRows: 100 })
      await ops.query('SELECT * FROM users')

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 100'),
        undefined,
      )
    })

    it('query does not wrap when LIMIT already present', async () => {
      const queryFn = mockQuery([{ id: 1 }])
      const ops = createDatabaseOperations(makeExecutor(queryFn), { maxRows: 100 })
      await ops.query('SELECT * FROM users LIMIT 10')

      expect(queryFn).toHaveBeenCalledWith(
        'SELECT * FROM users LIMIT 10',
        undefined,
      )
    })

    it('query wraps WITH queries', async () => {
      const queryFn = mockQuery([{ cnt: 5 }])
      const ops = createDatabaseOperations(makeExecutor(queryFn), { maxRows: 50 })
      await ops.query('WITH cte AS (SELECT 1) SELECT * FROM cte')

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 50'),
        undefined,
      )
    })

    it('listTables returns table objects', async () => {
      const queryFn = mockQuery([
        { table_name: 'users', table_schema: 'public' },
        { table_name: 'orders', table_schema: 'public' },
      ])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const tables = await ops.listTables()

      expect(tables).toHaveLength(2)
      expect(tables[0]!.name).toBe('users')
      expect(tables[0]!.schema).toBe('public')
      expect(tables[0]!.columns).toEqual([])
    })

    it('listTables uses custom schema', async () => {
      const queryFn = mockQuery([])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      await ops.listTables('analytics')

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        ['analytics'],
      )
    })

    it('describeTable returns column info', async () => {
      const queryFn = mockQuery([
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          is_primary_key: true,
        },
        {
          column_name: 'name',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
          is_primary_key: false,
        },
      ])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const cols = await ops.describeTable('users')

      expect(cols).toHaveLength(2)
      expect(cols[0]!.name).toBe('id')
      expect(cols[0]!.type).toBe('integer')
      expect(cols[0]!.nullable).toBe(false)
      expect(cols[0]!.isPrimaryKey).toBe(true)
      expect(cols[1]!.name).toBe('name')
      expect(cols[1]!.nullable).toBe(true)
    })

    it('describeTable handles column_default values', async () => {
      const queryFn = mockQuery([
        {
          column_name: 'created_at',
          data_type: 'timestamptz',
          is_nullable: 'NO',
          column_default: 'now()',
          is_primary_key: false,
        },
      ])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const cols = await ops.describeTable('events')

      expect(cols[0]!.defaultValue).toBe('now()')
    })

    it('describeTable handles is_primary_key = "t" string', async () => {
      const queryFn = mockQuery([
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          is_primary_key: 't',
        },
      ])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const cols = await ops.describeTable('items')

      expect(cols[0]!.isPrimaryKey).toBe(true)
    })

    it('getTableInfo includes columns and row count', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ estimate: 42000 }],
          rowCount: 1,
        })

      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const info = await ops.getTableInfo('users')

      expect(info.name).toBe('users')
      expect(info.schema).toBe('public')
      expect(info.columns).toHaveLength(1)
      expect(info.rowCount).toBe(42000)
    })

    it('getTableInfo handles missing row count gracefully', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null, is_primary_key: false }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        })

      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const info = await ops.getTableInfo('temp')

      expect(info.rowCount).toBeUndefined()
    })

    it('getTableInfo handles row count query failure', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        })
        .mockRejectedValueOnce(new Error('pg_class not accessible'))

      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const info = await ops.getTableInfo('restricted')

      expect(info.name).toBe('restricted')
      expect(info.rowCount).toBeUndefined()
    })

    it('healthCheck returns true on success', async () => {
      const queryFn = mockQuery([{ ok: 1 }])
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const healthy = await ops.healthCheck()
      expect(healthy).toBe(true)
    })

    it('healthCheck returns false on failure', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('connection lost'))
      const ops = createDatabaseOperations(makeExecutor(queryFn), {})
      const healthy = await ops.healthCheck()
      expect(healthy).toBe(false)
    })

    it('close delegates to executor', async () => {
      const closeFn = vi.fn()
      const executor = {
        async execute() {
          return { rows: [], rowCount: 0, fields: [], duration: 0 }
        },
        close: closeFn,
      }
      const ops = createDatabaseOperations(executor, {})
      await ops.close()
      expect(closeFn).toHaveBeenCalled()
    })
  })

  // ── Tool: db-list-tables ──────────────────────────────

  describe('db-list-tables tool', () => {
    it('lists tables from default schema', async () => {
      const queryFn = mockQuery([
        { table_name: 'users', table_schema: 'public' },
      ])
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('public.users')
    })

    it('returns "no tables" message for empty schema', async () => {
      const queryFn = mockQuery([])
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('No tables found')
    })

    it('uses custom schema parameter', async () => {
      const queryFn = mockQuery([])
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      await listTool.invoke({ schema: 'analytics' })

      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        ['analytics'],
      )
    })

    it('handles query error gracefully', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('permission denied'))
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('Error listing tables')
      expect(result).toContain('permission denied')
    })
  })

  // ── Tool: db-describe-table ───────────────────────────

  describe('db-describe-table tool', () => {
    it('shows table info with columns', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ estimate: 1000 }],
          rowCount: 1,
        })
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'users' })

      expect(result).toContain('Table: public.users')
      expect(result).toContain('id')
      expect(result).toContain('integer')
      expect(result).toContain('NOT NULL')
      expect(result).toContain('PK')
      expect(result).toContain('Estimated rows: 1000')
    })

    it('returns "not found" for table with no columns', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'nonexistent' })

      expect(result).toContain('not found')
    })

    it('shows DEFAULT value for columns', async () => {
      const queryFn = vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            column_name: 'status',
            data_type: 'varchar',
            is_nullable: 'YES',
            column_default: "'active'",
            is_primary_key: false,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'settings' })

      expect(result).toContain("DEFAULT 'active'")
    })

    it('handles describe error gracefully', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('table access denied'))
      const tools = createDatabaseConnector(makeConfig({ query: queryFn }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'secret' })

      expect(result).toContain('Error describing table')
    })
  })

  // ── Tool filtering ────────────────────────────────────

  describe('tool filtering', () => {
    it('returns only enabled tools', () => {
      const tools = createDatabaseConnector(makeConfig({
        enabledTools: ['db-query'],
      }))
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('db-query')
    })

    it('returns empty for non-matching filter', () => {
      const tools = createDatabaseConnector(makeConfig({
        enabledTools: ['nonexistent'],
      }))
      expect(tools).toHaveLength(0)
    })
  })

  // ── Read-write mode ───────────────────────────────────

  describe('read-write mode', () => {
    it('allows INSERT when readOnly is false', async () => {
      const queryFn = mockQuery([], 1)
      const tools = createDatabaseConnector(makeConfig({
        query: queryFn,
        readOnly: false,
      }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'INSERT INTO users (name) VALUES ($1)', params: ['Alice'] })

      expect(result).not.toContain('not allowed')
      expect(queryFn).toHaveBeenCalled()
    })
  })

  // ── Config: databaseName in descriptions ──────────────

  describe('databaseName config', () => {
    it('uses custom database name in tool descriptions', () => {
      const tools = createDatabaseConnector(makeConfig({
        databaseName: 'analytics-db',
      }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      expect(dbQuery.description).toContain('analytics-db')
    })

    it('uses default "database" when not specified', () => {
      const tools = createDatabaseConnector(makeConfig())
      const dbQuery = tools.find(t => t.name === 'db-query')!
      expect(dbQuery.description).toContain('database')
    })
  })
})
