/**
 * Tests for DuckDBEngine and MemoryAnalytics.
 *
 * Since @duckdb/duckdb-wasm is an optional peer dependency that requires
 * a WASM runtime, these tests use DuckDBEngine._createFromConnection()
 * to inject mock db/connection objects. This validates the engine's
 * table registration, query dispatch, cleanup, and error handling logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tableFromArrays, type Table } from 'apache-arrow'
import { DuckDBEngine } from '../../analytics/duckdb-engine.js'
import type { AnalyticsResult } from '../../analytics/duckdb-engine.js'
import { MemoryAnalytics } from '../../analytics/memory-analytics.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock query result with toArray().
 * Avoids Arrow's type inference issues by using a simple stub table.
 */
function createMockResult<T extends Record<string, unknown>>(
  rows: T[],
): Table & { toArray(): T[] } {
  // Create a minimal Arrow table (just needs to be a valid Table object)
  const stub = tableFromArrays({ _stub: new Int32Array(rows.length || 1) })

  Object.defineProperty(stub, 'toArray', {
    value: () => rows,
    writable: false,
    enumerable: false,
    configurable: true,
  })

  return stub as Table & { toArray(): T[] }
}

function createMockConnection() {
  const insertArrowTable = vi.fn<(table: Table, opts: { name: string; create: boolean }) => Promise<void>>()
    .mockResolvedValue(undefined)
  const query = vi.fn<(sql: string) => Promise<Table & { toArray(): Record<string, unknown>[] }>>()
    .mockResolvedValue(createMockResult([]))
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  return { insertArrowTable, query, close }
}

function createMockDb() {
  const terminate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return { terminate }
}

function createEngine(
  db = createMockDb(),
  connection = createMockConnection(),
): { engine: DuckDBEngine; db: ReturnType<typeof createMockDb>; connection: ReturnType<typeof createMockConnection> } {
  const engine = DuckDBEngine._createFromConnection(db, connection)
  return { engine, db, connection }
}

// ---------------------------------------------------------------------------
// Test data helper
// ---------------------------------------------------------------------------

function buildTestTable(
  records: Array<{
    id: string
    namespace: string
    text?: string
    decay_strength?: number
    importance?: number
    is_active?: boolean
    system_created_at?: number
  }>,
): Table {
  return tableFromArrays({
    id: records.map((r) => r.id),
    namespace: records.map((r) => r.namespace),
    text: records.map((r) => r.text ?? `Text for ${r.id}`),
    decay_strength: new Float64Array(records.map((r) => r.decay_strength ?? 1.0)),
    importance: new Float64Array(records.map((r) => r.importance ?? 0.5)),
    is_active: records.map((r) => r.is_active ?? true),
    system_created_at: records.map((r) => r.system_created_at ?? Date.now()),
  })
}

// ---------------------------------------------------------------------------
// Tests: DuckDBEngine
// ---------------------------------------------------------------------------

describe('DuckDBEngine', () => {
  describe('_createFromConnection', () => {
    it('creates an engine instance from mock db and connection', () => {
      const { engine } = createEngine()
      expect(engine).toBeInstanceOf(DuckDBEngine)
    })
  })

  describe('query', () => {
    it('registers table, executes SQL, and returns AnalyticsResult', async () => {
      const expectedRows = [{ namespace: 'test', count: 5 }]
      const { engine, connection } = createEngine()
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'test' },
        { id: '2', namespace: 'test' },
      ])

      const result: AnalyticsResult<{ namespace: string; count: number }> = await engine.query(
        table,
        'SELECT namespace, COUNT(*) as count FROM memory GROUP BY namespace',
      )

      expect(result.rows).toEqual(expectedRows)
      expect(result.rowCount).toBe(1)
      expect(result.executionMs).toBeGreaterThanOrEqual(0)
      expect(result.arrowTable).toBeDefined()

      // Verify table was registered
      expect(connection.insertArrowTable).toHaveBeenCalledWith(table, {
        name: 'memory',
        create: true,
      })

      await engine.close()
    })

    it('uses custom alias when provided', async () => {
      const { engine, connection } = createEngine()
      connection.query.mockResolvedValueOnce(createMockResult([]))

      const table = buildTestTable([{ id: '1', namespace: 'ns' }])
      await engine.query(table, 'SELECT * FROM my_table', 'my_table')

      expect(connection.insertArrowTable).toHaveBeenCalledWith(table, {
        name: 'my_table',
        create: true,
      })

      await engine.close()
    })

    it('cleans up table even if query fails', async () => {
      const { engine, connection } = createEngine()
      // First call is the actual query (fails), second is DROP TABLE in cleanup
      connection.query
        .mockRejectedValueOnce(new Error('SQL syntax error'))
        .mockResolvedValue(createMockResult([]))

      const table = buildTestTable([{ id: '1', namespace: 'ns' }])

      await expect(
        engine.query(table, 'INVALID SQL'),
      ).rejects.toThrow('SQL syntax error')

      // The table should have been unregistered (DROP TABLE called)
      const dropCalls = connection.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DROP TABLE'),
      )
      expect(dropCalls.length).toBeGreaterThan(0)

      await engine.close()
    })

    it('re-registers table if alias already exists', async () => {
      const { engine, connection } = createEngine()
      connection.query.mockResolvedValue(createMockResult([]))

      const table1 = buildTestTable([{ id: '1', namespace: 'ns' }])
      const table2 = buildTestTable([{ id: '2', namespace: 'ns2' }])

      await engine.query(table1, 'SELECT * FROM memory')
      await engine.query(table2, 'SELECT * FROM memory')

      // insertArrowTable called twice (once per query)
      expect(connection.insertArrowTable).toHaveBeenCalledTimes(2)

      await engine.close()
    })
  })

  describe('queryMulti', () => {
    it('registers multiple tables and executes cross-table SQL', async () => {
      const expectedRows = [
        { source: 'agent_a', total: 10 },
        { source: 'agent_b', total: 20 },
      ]
      const { engine, connection } = createEngine()
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const tables = new Map<string, Table>()
      tables.set('agent_a', buildTestTable([{ id: '1', namespace: 'ns' }]))
      tables.set('agent_b', buildTestTable([{ id: '2', namespace: 'ns' }]))

      const result = await engine.queryMulti(
        tables,
        'SELECT * FROM agent_a UNION ALL SELECT * FROM agent_b',
      )

      expect(result.rows).toEqual(expectedRows)
      expect(connection.insertArrowTable).toHaveBeenCalledTimes(2)

      await engine.close()
    })

    it('cleans up all tables on error', async () => {
      const { engine, connection } = createEngine()
      connection.query
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockResolvedValue(createMockResult([]))

      const tables = new Map<string, Table>()
      tables.set('t1', buildTestTable([{ id: '1', namespace: 'ns' }]))
      tables.set('t2', buildTestTable([{ id: '2', namespace: 'ns' }]))

      await expect(
        engine.queryMulti(tables, 'BAD SQL'),
      ).rejects.toThrow('Query failed')

      await engine.close()
    })
  })

  describe('close', () => {
    it('closes connection and terminates DB', async () => {
      const { engine, db, connection } = createEngine()
      await engine.close()

      expect(connection.close).toHaveBeenCalledOnce()
      expect(db.terminate).toHaveBeenCalledOnce()
    })

    it('handles close errors gracefully', async () => {
      const db = createMockDb()
      const connection = createMockConnection()
      db.terminate.mockRejectedValueOnce(new Error('terminate failed'))
      connection.close.mockRejectedValueOnce(new Error('close failed'))

      const engine = DuckDBEngine._createFromConnection(db, connection)
      // Should not throw
      await engine.close()
    })

    it('drops registered tables during close', async () => {
      const { engine, connection } = createEngine()

      // Register a table via query
      connection.query.mockResolvedValue(createMockResult([]))
      const table = buildTestTable([{ id: '1', namespace: 'ns' }])
      await engine.query(table, 'SELECT * FROM memory')

      // Close should attempt to DROP registered tables
      await engine.close()

      const dropCalls = connection.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DROP TABLE'),
      )
      expect(dropCalls.length).toBeGreaterThanOrEqual(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: MemoryAnalytics
// ---------------------------------------------------------------------------

describe('MemoryAnalytics', () => {
  let connection: ReturnType<typeof createMockConnection>
  let analytics: MemoryAnalytics

  beforeEach(() => {
    const db = createMockDb()
    connection = createMockConnection()
    connection.query.mockResolvedValue(createMockResult([]))
    const engine = DuckDBEngine._createFromConnection(db, connection)
    analytics = MemoryAnalytics.fromEngine(engine)
  })

  describe('fromEngine', () => {
    it('creates analytics from existing engine', () => {
      expect(analytics).toBeInstanceOf(MemoryAnalytics)
    })
  })

  describe('decayTrends', () => {
    it('executes decay trend query with hour buckets', async () => {
      const expectedRows = [
        {
          namespace: 'test',
          bucket: '1700000000000',
          avg_strength: 0.85,
          min_strength: 0.5,
          max_strength: 1.0,
          count: 10,
        },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'test', decay_strength: 0.8 },
      ])

      const result = await analytics.decayTrends(table, 'hour')
      expect(result.rows).toEqual(expectedRows)

      // Verify the SQL contains the hour interval (3600000 ms)
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('3600000'),
      )
      expect(sqlCall).toBeTruthy()
    })

    it('supports day bucket size', async () => {
      connection.query.mockResolvedValue(createMockResult([]))
      const table = buildTestTable([{ id: '1', namespace: 'test', decay_strength: 0.5 }])

      await analytics.decayTrends(table, 'day')
      const dayCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('86400000'),
      )
      expect(dayCall).toBeTruthy()
    })

    it('supports week bucket size', async () => {
      connection.query.mockResolvedValue(createMockResult([]))
      const table = buildTestTable([{ id: '1', namespace: 'test', decay_strength: 0.5 }])

      await analytics.decayTrends(table, 'week')
      const weekCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('604800000'),
      )
      expect(weekCall).toBeTruthy()
    })
  })

  describe('namespaceStats', () => {
    it('executes namespace statistics query', async () => {
      const expectedRows = [
        {
          namespace: 'lessons',
          total_memories: 25,
          active_memories: 20,
          avg_strength: 0.9,
          avg_importance: 0.7,
          oldest_created: 1700000000000,
          newest_created: 1700100000000,
        },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'lessons', importance: 0.7 },
      ])

      const result = await analytics.namespaceStats(table)
      expect(result.rows).toEqual(expectedRows)

      // Verify SQL groups by namespace
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('GROUP BY namespace'),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('expiringMemories', () => {
    it('queries for memories expiring within the horizon', async () => {
      const expectedRows = [
        { id: '1', namespace: 'test', decay_strength: 0.15, expires_in_ms: 3600000 },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'test', decay_strength: 0.15 },
      ])

      const result = await analytics.expiringMemories(table, 3600000)
      expect(result.rows).toEqual(expectedRows)

      // Verify SQL uses exponential decay formula
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('EXP'),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('agentPerformance', () => {
    it('queries single table for agent performance', async () => {
      const expectedRows = [
        {
          agent_id: 'agent-1',
          total_memories: 50,
          avg_importance: 0.8,
          categories: ['lesson', 'convention'],
          active_ratio: 0.9,
        },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'test', importance: 0.8 },
      ])

      const result = await analytics.agentPerformance(table)
      expect(result.rows).toEqual(expectedRows)
    })

    it('queries multi-table for cross-agent comparison', async () => {
      const expectedRows = [
        { agent_id: 'agent-a', total_memories: 30, avg_importance: 0.7, categories: [], active_ratio: 0.8 },
        { agent_id: 'agent-b', total_memories: 20, avg_importance: 0.6, categories: [], active_ratio: 0.7 },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const frames = new Map<string, Table>()
      frames.set('agent-a', buildTestTable([{ id: '1', namespace: 'test' }]))
      frames.set('agent-b', buildTestTable([{ id: '2', namespace: 'test' }]))

      const result = await analytics.agentPerformance(frames)
      expect(result.rows).toEqual(expectedRows)

      // Verify multi-table registration
      expect(connection.insertArrowTable).toHaveBeenCalledTimes(2)
    })
  })

  describe('usagePatterns', () => {
    it('executes usage pattern histogram query', async () => {
      const expectedRows = [
        { bucket_start: 1700000000000, access_count: 15, unique_memories: 5 },
        { bucket_start: 1700003600000, access_count: 8, unique_memories: 3 },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([{ id: '1', namespace: 'test' }])

      const result = await analytics.usagePatterns(table, 3600000)
      expect(result.rows).toEqual(expectedRows)

      // Verify bucket size in SQL
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('3600000'),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('duplicateCandidates', () => {
    it('finds duplicate candidates with default prefix length', async () => {
      const expectedRows = [
        {
          id_a: '1',
          id_b: '2',
          text_a: 'This is a long text that is duplicated...',
          text_b: 'This is a long text that is duplicated with minor changes...',
          namespace: 'test',
        },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'test', text: 'This is duplicated' },
        { id: '2', namespace: 'test', text: 'This is duplicated too' },
      ])

      const result = await analytics.duplicateCandidates(table)
      expect(result.rows).toEqual(expectedRows)

      // Verify default prefix length of 100
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('LEFT(a.text, 100)'),
      )
      expect(sqlCall).toBeTruthy()
    })

    it('uses custom prefix length', async () => {
      connection.query.mockResolvedValueOnce(createMockResult([]))

      const table = buildTestTable([{ id: '1', namespace: 'test' }])
      await analytics.duplicateCandidates(table, 50)

      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('LEFT(a.text, 50)'),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('custom', () => {
    it('passes through custom SQL to the engine', async () => {
      const expectedRows = [{ total: 42 }]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([{ id: '1', namespace: 'test' }])

      const result = await analytics.custom<{ total: number }>(
        table,
        'SELECT COUNT(*) AS total FROM memory',
      )
      expect(result.rows).toEqual(expectedRows)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: AnalyticsResult type contract
// ---------------------------------------------------------------------------

describe('AnalyticsResult', () => {
  it('has the expected shape', async () => {
    const rows = [{ namespace: 'test', count: 5 }]
    const { engine, connection } = createEngine()
    connection.query.mockResolvedValueOnce(createMockResult(rows))

    const table = buildTestTable([{ id: '1', namespace: 'test' }])
    const result = await engine.query(table, 'SELECT * FROM memory')

    // Verify all fields exist
    expect(result).toHaveProperty('arrowTable')
    expect(result).toHaveProperty('rows')
    expect(result).toHaveProperty('executionMs')
    expect(result).toHaveProperty('rowCount')
    expect(typeof result.executionMs).toBe('number')
    expect(typeof result.rowCount).toBe('number')
    expect(Array.isArray(result.rows)).toBe(true)

    await engine.close()
  })
})
