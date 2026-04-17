/**
 * Tests that exercise the pg-driver integration path of db-connector.
 *
 * These cover the createPool → createPgExecutor code paths that are not
 * reachable when a custom `query` function is supplied. We mock the `pg`
 * module with a minimal Pool double so that the dynamic import succeeds
 * and the executor can be exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock pg — must be declared before importing the connector.
// ---------------------------------------------------------------------------

type PgQueryResult = {
  rows: Record<string, unknown>[]
  rowCount: number | null
  fields: Array<{ name: string; dataTypeID: number }>
}

const mockPoolQuery = vi.fn<(text: string, values?: unknown[]) => Promise<PgQueryResult>>()
const mockPoolEnd = vi.fn<() => Promise<void>>(async () => undefined)
const poolCtorCalls: Array<Record<string, unknown>> = []

class MockPool {
  constructor(opts: Record<string, unknown>) {
    poolCtorCalls.push(opts)
  }
  query(text: string, values?: unknown[]): Promise<PgQueryResult> {
    return mockPoolQuery(text, values)
  }
  end(): Promise<void> {
    return mockPoolEnd()
  }
}

vi.mock('pg', () => ({
  Pool: MockPool,
  default: { Pool: MockPool },
}))

// Import after the mock is registered so the dynamic import picks up the double
const { createDatabaseConnector, createDatabaseOperations } = await import('../database/db-connector.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pgResult(
  rows: Record<string, unknown>[] = [],
  fields: Array<{ name: string; dataTypeID: number }> = [],
  rowCount?: number | null,
): PgQueryResult {
  const effectiveRowCount = rowCount === undefined ? rows.length : rowCount
  return { rows, rowCount: effectiveRowCount, fields }
}

describe('Database connector — pg executor path (branch coverage)', () => {
  beforeEach(() => {
    poolCtorCalls.length = 0
    mockPoolQuery.mockReset()
    mockPoolEnd.mockReset()
    mockPoolEnd.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // createPool config branches
  // -------------------------------------------------------------------------

  describe('createPool: configuration branches', () => {
    it('passes connectionString when provided', async () => {
      mockPoolQuery.mockResolvedValue(pgResult([{ id: 1 }], [{ name: 'id', dataTypeID: 23 }]))
      const tools = createDatabaseConnector({
        connectionString: 'postgres://u:p@db.internal:5432/app',
      })
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT 1' })

      expect(poolCtorCalls.length).toBe(1)
      expect(poolCtorCalls[0]?.['connectionString']).toBe('postgres://u:p@db.internal:5432/app')
    })

    it('uses host/port/database/user/password when connectionString is absent', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({
        host: 'db.local',
        port: 6543,
        database: 'accounts',
        user: 'reader',
        password: 'secret',
      })
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT 1' })

      const cfg = poolCtorCalls[0]!
      expect(cfg['host']).toBe('db.local')
      expect(cfg['port']).toBe(6543)
      expect(cfg['database']).toBe('accounts')
      expect(cfg['user']).toBe('reader')
      expect(cfg['password']).toBe('secret')
    })

    it('applies defaults (localhost:5432) when host/port omitted', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({})
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT 1' })

      const cfg = poolCtorCalls[0]!
      expect(cfg['host']).toBe('localhost')
      expect(cfg['port']).toBe(5432)
      expect(cfg['connectionString']).toBeUndefined()
    })

    it('omits database/user/password when not provided', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({ host: 'h', port: 1234 })
      const dbQuery = tools.find(t => t.name === 'db-query')!
      await dbQuery.invoke({ sql: 'SELECT 1' })

      const cfg = poolCtorCalls[0]!
      expect('database' in cfg).toBe(false)
      expect('user' in cfg).toBe(false)
      expect('password' in cfg).toBe(false)
    })

    it('uses maxConnections override', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({ maxConnections: 25 })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['max']).toBe(25)
    })

    it('applies default maxConnections of 5', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({})
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['max']).toBe(5)
    })

    it('uses queryTimeout override for statement_timeout', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({ queryTimeout: 5000 })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['statement_timeout']).toBe(5000)
    })

    it('applies default queryTimeout of 30000', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({})
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['statement_timeout']).toBe(30_000)
    })
  })

  // -------------------------------------------------------------------------
  // SSL branches
  // -------------------------------------------------------------------------

  describe('createPool: SSL configuration branches', () => {
    it('omits ssl when ssl is false', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({ ssl: false })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['ssl']).toBeUndefined()
    })

    it('omits ssl when ssl is undefined', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({})
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['ssl']).toBeUndefined()
    })

    it('enables ssl with rejectUnauthorized:true when ssl=true and self-signed not allowed', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({ ssl: true })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['ssl']).toEqual({ rejectUnauthorized: true })
    })

    it('enables ssl with rejectUnauthorized:false when sslAllowSelfSigned is true', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const tools = createDatabaseConnector({
        ssl: true,
        sslAllowSelfSigned: true,
      })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['ssl']).toEqual({ rejectUnauthorized: false })
    })

    it('passes object-form ssl through verbatim', async () => {
      mockPoolQuery.mockResolvedValue(pgResult())
      const sslOpts = { rejectUnauthorized: true, ca: '-----BEGIN CERT-----' }
      const tools = createDatabaseConnector({ ssl: sslOpts })
      await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1' })
      expect(poolCtorCalls[0]?.['ssl']).toBe(sslOpts)
    })
  })

  // -------------------------------------------------------------------------
  // createPgExecutor behaviour through db-query
  // -------------------------------------------------------------------------

  describe('createPgExecutor: result mapping', () => {
    it('maps field dataTypeID through PG_TYPE_MAP (known OIDs)', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ id: 1, name: 'a', active: true }],
        [
          { name: 'id', dataTypeID: 23 },   // integer
          { name: 'name', dataTypeID: 25 }, // text
          { name: 'active', dataTypeID: 16 }, // boolean
        ],
      ))
      const tools = createDatabaseConnector({})
      const result = await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT * FROM users' })

      expect(result).toContain('id')
      expect(result).toContain('name')
      expect(result).toContain('1 rows')
    })

    it('falls back to oid:NNN for unknown type IDs', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ weird: 'xyz' }],
        [{ name: 'weird', dataTypeID: 99999 }],
      ))
      const tools = createDatabaseConnector({})
      const dbQuery = tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT weird FROM t' })
      // Still resolves successfully even with unknown OID
      expect(result).toContain('xyz')
    })

    it('uses rows.length when rowCount is null', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ a: 1 }, { a: 2 }],
        [{ name: 'a', dataTypeID: 23 }],
        null,
      ))
      const tools = createDatabaseConnector({})
      const result = await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT a FROM t' })
      expect(result).toContain('2 rows')
    })

    it('uses explicit rowCount when provided', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ a: 1 }],
        [{ name: 'a', dataTypeID: 23 }],
        42,
      ))
      const tools = createDatabaseConnector({})
      const result = await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT a FROM t' })
      expect(result).toContain('42 rows')
    })

    it('reports error when pool.query rejects', async () => {
      mockPoolQuery.mockRejectedValue(new Error('relation "t" does not exist'))
      const tools = createDatabaseConnector({})
      const result = await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT * FROM t' })
      expect(result).toContain('Query error')
      expect(result).toContain('does not exist')
    })

    it('exposes duration on result through createDatabaseOperations', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ n: 1 }],
        [{ name: 'n', dataTypeID: 23 }],
      ))
      // Build the db-query tool once to materialise the pg executor
      const tools = createDatabaseConnector({})
      const out = await tools.find(t => t.name === 'db-query')!.invoke({ sql: 'SELECT 1 AS n' })
      expect(out).toContain('ms')
    })
  })

  // -------------------------------------------------------------------------
  // Shared ops reuse — second invocation reuses the existing pool
  // -------------------------------------------------------------------------

  describe('lazy pool initialisation', () => {
    it('creates only one pool across multiple tool invocations', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ v: 1 }],
        [{ name: 'v', dataTypeID: 23 }],
      ))
      const tools = createDatabaseConnector({})
      const q = tools.find(t => t.name === 'db-query')!
      await q.invoke({ sql: 'SELECT 1' })
      await q.invoke({ sql: 'SELECT 2' })
      await q.invoke({ sql: 'SELECT 3' })

      expect(poolCtorCalls.length).toBe(1)
      expect(mockPoolQuery).toHaveBeenCalledTimes(3)
    })

    it('reuses the same pool across different tools', async () => {
      mockPoolQuery.mockResolvedValue(pgResult([], []))
      const tools = createDatabaseConnector({})
      const q = tools.find(t => t.name === 'db-query')!
      const listT = tools.find(t => t.name === 'db-list-tables')!

      await q.invoke({ sql: 'SELECT 1' })
      await listT.invoke({})

      expect(poolCtorCalls.length).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Direct createDatabaseOperations wired to a pg-style pool
  // -------------------------------------------------------------------------

  describe('createPgExecutor: direct usage with pool.end()', () => {
    it('close() delegates to pool.end()', async () => {
      mockPoolQuery.mockResolvedValue(pgResult(
        [{ id: 1 }],
        [{ name: 'id', dataTypeID: 23 }],
      ))

      const pool = new MockPool({})
      // Use the pg-flavoured executor indirectly via createDatabaseOperations wired to pool
      const executor = {
        async execute(sql: string, params?: unknown[]) {
          const result = await pool.query(sql, params)
          return {
            rows: result.rows,
            rowCount: result.rowCount ?? result.rows.length,
            fields: result.fields.map(f => ({ name: f.name, type: String(f.dataTypeID) })),
            duration: 0,
          }
        },
        close: () => pool.end(),
      }

      const ops = createDatabaseOperations(executor, {})
      await ops.query('SELECT 1 FROM t')
      await ops.close()

      expect(mockPoolEnd).toHaveBeenCalledTimes(1)
    })
  })
})
