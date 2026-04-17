/**
 * Extended database connector tests — covers connection error handling,
 * query timeout simulation, transaction-like error paths, consecutive queries,
 * parameter sanitization, edge cases in operations, and executor behavior.
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

// ---------------------------------------------------------------------------
// Connection error handling
// ---------------------------------------------------------------------------

describe('Database connector — extended', () => {
  describe('connection error handling', () => {
    it('reports connection refused error through db-query tool', async () => {
      const query = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(result).toContain('Query error')
      expect(result).toContain('ECONNREFUSED')
    })

    it('reports authentication failure', async () => {
      const query = vi.fn().mockRejectedValue(new Error('password authentication failed for user "test"'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(result).toContain('Query error')
      expect(result).toContain('password authentication failed')
    })

    it('reports SSL connection error', async () => {
      const query = vi.fn().mockRejectedValue(new Error('SSL connection error: self signed certificate'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(result).toContain('Query error')
      expect(result).toContain('SSL connection error')
    })

    it('healthCheck returns false when connection fails', async () => {
      const executor = makeExecutor(vi.fn().mockRejectedValue(new Error('timeout')))
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(false)
    })

    it('healthCheck returns true when connection succeeds', async () => {
      const executor = makeExecutor(mockQuery([{ ok: 1 }]))
      const ops = createDatabaseOperations(executor, {})
      expect(await ops.healthCheck()).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Query timeout
  // ---------------------------------------------------------------------------

  describe('query timeout', () => {
    it('reports timeout error through db-query tool', async () => {
      const query = vi.fn().mockRejectedValue(new Error('Query read timeout'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT pg_sleep(120)' })

      expect(result).toContain('Query error')
      expect(result).toContain('timeout')
    })

    it('reports statement timeout from pg', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('canceling statement due to statement timeout'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM huge_table' })

      expect(result).toContain('Query error')
      expect(result).toContain('statement timeout')
    })
  })

  // ---------------------------------------------------------------------------
  // Transaction rollback path
  // ---------------------------------------------------------------------------

  describe('transaction error paths', () => {
    it('reports constraint violation error', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('duplicate key value violates unique constraint "users_email_key"'),
      )
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({
        sql: 'INSERT INTO users (email) VALUES ($1)',
        params: ['dup@test.com'],
      })

      expect(result).toContain('Query error')
      expect(result).toContain('unique constraint')
    })

    it('reports foreign key violation', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('insert or update on table "orders" violates foreign key constraint'),
      )
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({
        sql: 'INSERT INTO orders (user_id) VALUES ($1)',
        params: [99999],
      })

      expect(result).toContain('Query error')
      expect(result).toContain('foreign key constraint')
    })

    it('reports check constraint violation', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('new row violates check constraint "age_positive"'),
      )
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({
        sql: 'INSERT INTO users (age) VALUES ($1)',
        params: [-1],
      })

      expect(result).toContain('Query error')
      expect(result).toContain('check constraint')
    })
  })

  // ---------------------------------------------------------------------------
  // Multiple consecutive queries
  // ---------------------------------------------------------------------------

  describe('multiple consecutive queries', () => {
    it('executes multiple queries in sequence through the same tool', async () => {
      let callCount = 0
      const query = vi.fn().mockImplementation(async () => {
        callCount++
        return { rows: [{ n: callCount }], rowCount: 1 }
      })
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const r1 = await dbQuery.invoke({ sql: 'SELECT 1 AS n' })
      const r2 = await dbQuery.invoke({ sql: 'SELECT 2 AS n' })
      const r3 = await dbQuery.invoke({ sql: 'SELECT 3 AS n' })

      expect(r1).toContain('1 rows')
      expect(r2).toContain('1 rows')
      expect(r3).toContain('1 rows')
      expect(query).toHaveBeenCalledTimes(3)
    })

    it('handles a mix of successes and failures', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const r1 = await dbQuery.invoke({ sql: 'SELECT 1 AS id' })
      expect(r1).toContain('id')

      const r2 = await dbQuery.invoke({ sql: 'SELECT 2 AS id' })
      expect(r2).toContain('Query error')
      expect(r2).toContain('connection lost')

      const r3 = await dbQuery.invoke({ sql: 'SELECT 3 AS id' })
      expect(r3).toContain('id')
    })
  })

  // ---------------------------------------------------------------------------
  // Parameter sanitization (no SQL injection through params)
  // ---------------------------------------------------------------------------

  describe('parameter sanitization', () => {
    it('passes SQL injection attempt as a safe parameter value', async () => {
      const query = mockQuery([])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({
        sql: 'SELECT * FROM users WHERE name = $1',
        params: ["'; DROP TABLE users; --"],
      })

      // The injection string is passed as a parameter, not interpolated into SQL
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE name = $1'),
        ["'; DROP TABLE users; --"],
      )
    })

    it('handles numeric parameter values', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({
        sql: 'SELECT * FROM users WHERE id = $1 AND age > $2',
        params: [42, 18],
      })

      expect(query).toHaveBeenCalledWith(
        expect.any(String),
        [42, 18],
      )
    })

    it('handles null parameter values', async () => {
      const query = mockQuery([])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({
        sql: 'SELECT * FROM users WHERE deleted_at IS $1',
        params: [null],
      })

      expect(query).toHaveBeenCalledWith(
        expect.any(String),
        [null],
      )
    })

    it('handles boolean parameter values', async () => {
      const query = mockQuery([{ id: 1, active: true }])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({
        sql: 'SELECT * FROM users WHERE active = $1',
        params: [true],
      })

      expect(query).toHaveBeenCalledWith(
        expect.any(String),
        [true],
      )
    })
  })

  // ---------------------------------------------------------------------------
  // DatabaseOperations programmatic API — additional
  // ---------------------------------------------------------------------------

  describe('createDatabaseOperations — additional', () => {
    it('listTables passes custom schema parameter', async () => {
      const query = mockQuery([{ table_name: 'events', table_schema: 'analytics' }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      const tables = await ops.listTables('analytics')

      expect(tables).toHaveLength(1)
      expect(tables[0]!.name).toBe('events')
      expect(tables[0]!.schema).toBe('analytics')
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        ['analytics'],
      )
    })

    it('describeTable returns column info', async () => {
      const query = mockQuery([
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true },
        { column_name: 'email', data_type: 'text', is_nullable: 'YES', column_default: null, is_primary_key: false },
      ])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      const cols = await ops.describeTable('users')

      expect(cols).toHaveLength(2)
      expect(cols[0]!.name).toBe('id')
      expect(cols[0]!.type).toBe('integer')
      expect(cols[0]!.nullable).toBe(false)
      expect(cols[0]!.isPrimaryKey).toBe(true)
      expect(cols[1]!.name).toBe('email')
      expect(cols[1]!.nullable).toBe(true)
    })

    it('describeTable passes custom schema', async () => {
      const query = mockQuery([])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      await ops.describeTable('events', 'analytics')

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.columns'),
        ['events', 'analytics'],
      )
    })

    it('getTableInfo includes row count estimate', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ estimate: 50000 }],
          rowCount: 1,
        })

      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      const info = await ops.getTableInfo('users')

      expect(info.name).toBe('users')
      expect(info.schema).toBe('public')
      expect(info.columns).toHaveLength(1)
      expect(info.rowCount).toBe(50000)
    })

    it('getTableInfo omits rowCount when pg_class query fails', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
        })
        .mockRejectedValueOnce(new Error('pg_class not accessible'))

      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      const info = await ops.getTableInfo('users')

      expect(info.name).toBe('users')
      expect(info.columns).toHaveLength(1)
      expect(info.rowCount).toBeUndefined()
    })

    it('getTableInfo omits rowCount when estimate is null', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: false }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ estimate: null }],
          rowCount: 1,
        })

      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, {})
      const info = await ops.getTableInfo('users')

      expect(info.rowCount).toBeUndefined()
    })

    it('query enforces row limit on SELECT without LIMIT', async () => {
      const query = mockQuery([{ id: 1 }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, { maxRows: 100 })
      await ops.query('SELECT * FROM users')

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 100'),
        undefined,
      )
    })

    it('query does not add LIMIT to queries that already have one', async () => {
      const query = mockQuery([{ id: 1 }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, { maxRows: 100 })
      await ops.query('SELECT * FROM users LIMIT 10')

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 10'),
        undefined,
      )
      const calledSql = query.mock.calls[0]![0] as string
      expect(calledSql).not.toContain('LIMIT 100')
    })

    it('query allows EXPLAIN in read-only mode', async () => {
      const query = mockQuery([{ 'QUERY PLAN': 'Seq Scan' }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, { readOnly: true })
      const result = await ops.query('EXPLAIN SELECT * FROM users')

      expect(result.rows).toHaveLength(1)
    })

    it('query allows SHOW in read-only mode', async () => {
      const query = mockQuery([{ setting: 'UTF8' }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, { readOnly: true })
      const result = await ops.query('SHOW client_encoding')

      expect(result.rows).toHaveLength(1)
    })

    it('query allows VALUES in read-only mode', async () => {
      const query = mockQuery([{ column1: 1, column2: 'a' }])
      const executor = makeExecutor(query)
      const ops = createDatabaseOperations(executor, { readOnly: true })
      const result = await ops.query("VALUES (1, 'a'), (2, 'b')")

      expect(result.rows).toHaveLength(1)
    })

    it('close calls executor close', async () => {
      const closeFn = vi.fn()
      const executor = {
        ...makeExecutor(mockQuery()),
        close: closeFn,
      }
      const ops = createDatabaseOperations(executor, {})
      await ops.close()
      expect(closeFn).toHaveBeenCalledOnce()
    })
  })

  // ---------------------------------------------------------------------------
  // db-list-tables error paths
  // ---------------------------------------------------------------------------

  describe('db-list-tables — additional error paths', () => {
    it('handles connection timeout in list tables', async () => {
      const query = vi.fn().mockRejectedValue(new Error('Connection timed out'))
      const tools = createDatabaseConnector(makeConfig({ query }))
      const listTool = tools.find(t => t.name === 'db-list-tables')!
      const result = await listTool.invoke({})

      expect(result).toContain('Error listing tables')
      expect(result).toContain('timed out')
    })
  })

  // ---------------------------------------------------------------------------
  // db-describe-table additional cases
  // ---------------------------------------------------------------------------

  describe('db-describe-table — additional cases', () => {
    it('shows column with default value', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'created_at', data_type: 'timestamp', is_nullable: 'NO', column_default: 'now()', is_primary_key: false },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ estimate: 100 }], rowCount: 1 })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'logs' })

      expect(result).toContain('created_at')
      expect(result).toContain('DEFAULT now()')
    })

    it('passes custom schema to describe', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: true }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ estimate: 10 }], rowCount: 1 })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const describeTool = tools.find(t => t.name === 'db-describe-table')!
      const result = await describeTool.invoke({ table: 'events', schema: 'analytics' })

      expect(result).toContain('Table: analytics.events')
    })
  })

  // ---------------------------------------------------------------------------
  // Read-only edge cases
  // ---------------------------------------------------------------------------

  describe('read-only edge cases', () => {
    it('blocks MERGE statement in read-only mode', async () => {
      const tools = createDatabaseConnector(makeConfig({ readOnly: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'MERGE INTO target USING source ON target.id = source.id' })
      expect(result).toContain('not allowed')
    })

    it('blocks COPY statement in read-only mode', async () => {
      const tools = createDatabaseConnector(makeConfig({ readOnly: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'COPY users TO STDOUT' })
      expect(result).toContain('not allowed')
    })

    it('blocks case-insensitive write keywords', async () => {
      const tools = createDatabaseConnector(makeConfig({ readOnly: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const r1 = await dbQuery.invoke({ sql: 'insert into users (name) values ($1)' })
      expect(r1).toContain('not allowed')

      const r2 = await dbQuery.invoke({ sql: '  DELETE FROM users' })
      expect(r2).toContain('not allowed')
    })

    it('allows write queries when readOnly is explicitly false', async () => {
      const query = mockQuery([], 5)
      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({
        sql: 'INSERT INTO users (name) VALUES ($1)',
        params: ['Alice'],
      })
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // W18-B3 — additional coverage: empty results, transaction-like sequences,
  // pool exhaustion, concurrent queries, executor close, custom executor edges
  // ---------------------------------------------------------------------------

  describe('empty result handling', () => {
    it('returns "0 rows" for SELECT with no matching rows', async () => {
      const query = mockQuery([])
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM users WHERE 1=0' })
      expect(result).toContain('0 rows')
    })

    it('returns formatted output even when rowCount > 0 but rows empty', async () => {
      // Some drivers return rowCount > 0 from DELETE-like paths even with no SELECT rows
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 5 })
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 WHERE false' })
      // Output should still report rowCount-based message
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)
    })

    it('listTables programmatic API returns empty array for empty schema', async () => {
      const executor = makeExecutor(mockQuery([]))
      const ops = createDatabaseOperations(executor, {})
      const tables = await ops.listTables('empty_schema')
      expect(tables).toEqual([])
    })

    it('describeTable programmatic API returns empty array for non-existent table', async () => {
      const executor = makeExecutor(mockQuery([]))
      const ops = createDatabaseOperations(executor, {})
      const cols = await ops.describeTable('nonexistent')
      expect(cols).toEqual([])
    })
  })

  describe('transaction-like sequences', () => {
    /**
     * The connector exposes individual queries — full transaction support is
     * driver-specific. Verify that a sequence of "BEGIN; INSERT; INSERT; COMMIT"
     * style operations behaves correctly when executed as separate calls.
     */
    it('executes a full successful sequence (BEGIN/INSERT/INSERT/COMMIT)', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      // Note: BEGIN/COMMIT contain no WRITE keywords so they pass even in read-only —
      // here we use readOnly=false to allow INSERT
      const r1 = await dbQuery.invoke({ sql: 'BEGIN' })
      const r2 = await dbQuery.invoke({ sql: 'INSERT INTO accounts(id) VALUES ($1)', params: [1] })
      const r3 = await dbQuery.invoke({ sql: 'INSERT INTO accounts(id) VALUES ($1)', params: [2] })
      const r4 = await dbQuery.invoke({ sql: 'COMMIT' })

      expect(r1).not.toContain('Query error')
      expect(r2).not.toContain('Query error')
      expect(r3).not.toContain('Query error')
      expect(r4).not.toContain('Query error')
      expect(query).toHaveBeenCalledTimes(4)
    })

    it('reports failure mid-transaction (caller can issue ROLLBACK)', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // INSERT 1 OK
        .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // ROLLBACK

      const tools = createDatabaseConnector(makeConfig({ query, readOnly: false }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const r1 = await dbQuery.invoke({ sql: 'BEGIN' })
      const r2 = await dbQuery.invoke({ sql: 'INSERT INTO t(id) VALUES (1)' })
      const r3 = await dbQuery.invoke({ sql: 'INSERT INTO t(id) VALUES (1)' })
      const r4 = await dbQuery.invoke({ sql: 'ROLLBACK' })

      expect(r1).not.toContain('Query error')
      expect(r2).not.toContain('Query error')
      expect(r3).toContain('Query error')
      expect(r3).toContain('duplicate key')
      expect(r4).not.toContain('Query error')
    })
  })

  describe('connection pool exhaustion', () => {
    it('reports pool exhausted error', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('timeout exceeded when trying to connect'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })
      expect(result).toContain('Query error')
      expect(result).toContain('timeout exceeded')
    })

    it('reports too many clients error from PostgreSQL', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('sorry, too many clients already'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })
      expect(result).toContain('Query error')
      expect(result).toContain('too many clients')
    })
  })

  describe('concurrent queries', () => {
    it('handles parallel db-query invocations', async () => {
      let counter = 0
      const query = vi.fn().mockImplementation(async () => {
        const id = ++counter
        await new Promise(resolve => setTimeout(resolve, 1))
        return { rows: [{ id }], rowCount: 1 }
      })
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const results = await Promise.all([
        dbQuery.invoke({ sql: 'SELECT 1 AS id' }),
        dbQuery.invoke({ sql: 'SELECT 2 AS id' }),
        dbQuery.invoke({ sql: 'SELECT 3 AS id' }),
      ])

      expect(results).toHaveLength(3)
      expect(query).toHaveBeenCalledTimes(3)
      for (const r of results) {
        expect(r).toContain('1 rows')
      }
    })

    it('handles mixed parallel success/failure', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      const results = await Promise.all([
        dbQuery.invoke({ sql: 'SELECT 1 AS id' }),
        dbQuery.invoke({ sql: 'SELECT 2 AS id' }),
        dbQuery.invoke({ sql: 'SELECT 3 AS id' }),
      ])

      expect(results[0]).not.toContain('Query error')
      expect(results[1]).toContain('deadlock')
      expect(results[2]).not.toContain('Query error')
    })
  })

  describe('custom executor edge cases', () => {
    it('custom executor receives resolved result with field info derived from rows', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ a: 1, b: 'two', c: true }],
        rowCount: 1,
      })
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(result).toContain('a')
      expect(result).toContain('b')
      expect(result).toContain('c')
    })

    it('custom executor close() is a no-op (does not throw)', async () => {
      const executor = makeExecutor(mockQuery())
      const ops = createDatabaseOperations(executor, {})
      await expect(ops.close()).resolves.toBeUndefined()
    })

    it('custom query function reuses ops on subsequent calls (lazy init)', async () => {
      let createdCount = 0
      const query = vi.fn().mockImplementation(async () => {
        createdCount++
        return { rows: [{ n: createdCount }], rowCount: 1 }
      })

      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!

      await dbQuery.invoke({ sql: 'SELECT 1 AS n' })
      await dbQuery.invoke({ sql: 'SELECT 2 AS n' })

      // Each invocation runs the query exactly once — no duplicate work
      expect(query).toHaveBeenCalledTimes(2)
    })
  })

  describe('SSL config variations', () => {
    /**
     * Verify the connector tolerates various SSL config shapes when the
     * custom query path is used — these flow through DatabaseConnectorConfig
     * but should not affect the custom executor path.
     */
    it('accepts boolean ssl=true with custom query', async () => {
      const query = mockQuery([{ ok: 1 }])
      const tools = createDatabaseConnector(makeConfig({ query, ssl: true }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 AS ok' })
      expect(result).toContain('ok')
    })

    it('accepts ssl object config with custom query', async () => {
      const query = mockQuery([{ ok: 1 }])
      const tools = createDatabaseConnector(makeConfig({
        query,
        ssl: { rejectUnauthorized: false },
      }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 AS ok' })
      expect(result).toContain('ok')
    })
  })

  describe('PostgreSQL-specific error codes', () => {
    it('reports relation not found error', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('relation "nonexistent_table" does not exist'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FROM nonexistent_table' })
      expect(result).toContain('relation')
      expect(result).toContain('does not exist')
    })

    it('reports column not found error', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('column "missing_col" does not exist'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT missing_col FROM t' })
      expect(result).toContain('column')
      expect(result).toContain('does not exist')
    })

    it('reports syntax error', async () => {
      const query = vi.fn().mockRejectedValue(
        new Error('syntax error at or near "FORM"'),
      )
      const tools = createDatabaseConnector(makeConfig({ query }))
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT * FORM users' })
      expect(result).toContain('syntax error')
    })
  })
})
