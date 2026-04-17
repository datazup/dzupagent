/**
 * Coverage tests for DuckDBEngine and MemoryAnalytics — error paths,
 * agentPerformance with empty Map, close, and uncovered branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tableFromArrays, type Table } from 'apache-arrow'
import { DuckDBEngine } from '../../analytics/duckdb-engine.js'
import { MemoryAnalytics } from '../../analytics/memory-analytics.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockResult<T extends Record<string, unknown>>(
  rows: T[],
): Table & { toArray(): T[] } {
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
  return {
    insertArrowTable: vi.fn<(table: Table, opts: { name: string; create: boolean }) => Promise<void>>()
      .mockResolvedValue(undefined),
    query: vi.fn<(sql: string) => Promise<Table & { toArray(): Record<string, unknown>[] }>>()
      .mockResolvedValue(createMockResult([])),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

function createMockDb() {
  return { terminate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }
}

function buildTestTable(
  records: Array<{ id: string; namespace: string; text?: string }>,
): Table {
  return tableFromArrays({
    id: records.map((r) => r.id),
    namespace: records.map((r) => r.namespace),
    text: records.map((r) => r.text ?? `Text for ${r.id}`),
  })
}

// ---------------------------------------------------------------------------
// DuckDBEngine — additional coverage
// ---------------------------------------------------------------------------

describe('DuckDBEngine — coverage', () => {
  describe('close — cleanup error handling', () => {
    it('handles DROP TABLE error during close gracefully', async () => {
      const db = createMockDb()
      const connection = createMockConnection()

      const engine = DuckDBEngine._createFromConnection(db, connection)

      // Register a table via query
      connection.query.mockResolvedValue(createMockResult([]))
      const table = buildTestTable([{ id: '1', namespace: 'ns' }])
      await engine.query(table, 'SELECT * FROM memory')

      // Make DROP TABLE fail
      connection.query.mockRejectedValueOnce(new Error('DROP failed'))

      // Close should not throw
      await engine.close()
      expect(db.terminate).toHaveBeenCalled()
    })
  })

  describe('registerTable — re-registration path', () => {
    it('drops and re-registers when alias already exists', async () => {
      const db = createMockDb()
      const connection = createMockConnection()
      const engine = DuckDBEngine._createFromConnection(db, connection)

      connection.query.mockResolvedValue(createMockResult([]))

      const table = buildTestTable([{ id: '1', namespace: 'ns' }])

      // First query registers 'memory'
      await engine.query(table, 'SELECT 1 FROM memory')
      // The unregister in finally should drop it, but if we query again with same alias
      // it should handle gracefully
      await engine.query(table, 'SELECT 1 FROM memory')

      await engine.close()
    })
  })

  describe('unregisterTable — no-op for unregistered alias', () => {
    it('does not throw when alias was never registered', async () => {
      const db = createMockDb()
      const connection = createMockConnection()
      const engine = DuckDBEngine._createFromConnection(db, connection)

      // Close without any queries (nothing registered)
      await engine.close()
      expect(connection.close).toHaveBeenCalled()
    })
  })

  describe('queryMulti — cleanup on partial registration failure', () => {
    it('cleans up registered tables when insertArrowTable fails midway', async () => {
      const db = createMockDb()
      const connection = createMockConnection()
      const engine = DuckDBEngine._createFromConnection(db, connection)

      // Second insertArrowTable call fails
      connection.insertArrowTable
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('insert failed'))

      const tables = new Map<string, Table>()
      tables.set('t1', buildTestTable([{ id: '1', namespace: 'ns' }]))
      tables.set('t2', buildTestTable([{ id: '2', namespace: 'ns' }]))

      await expect(
        engine.queryMulti(tables, 'SELECT * FROM t1'),
      ).rejects.toThrow('insert failed')

      // Should still be able to close
      await engine.close()
    })
  })
})

// ---------------------------------------------------------------------------
// MemoryAnalytics — additional coverage
// ---------------------------------------------------------------------------

describe('MemoryAnalytics — coverage', () => {
  let connection: ReturnType<typeof createMockConnection>
  let analytics: MemoryAnalytics

  beforeEach(() => {
    const db = createMockDb()
    connection = createMockConnection()
    connection.query.mockResolvedValue(createMockResult([]))
    const engine = DuckDBEngine._createFromConnection(db, connection)
    analytics = MemoryAnalytics.fromEngine(engine)
  })

  describe('agentPerformance — empty Map throws', () => {
    it('throws when given an empty Map', async () => {
      const emptyMap = new Map<string, Table>()
      await expect(
        analytics.agentPerformance(emptyMap),
      ).rejects.toThrow('agentPerformance requires at least one table')
    })
  })

  describe('agentPerformance — single table path', () => {
    it('executes single-table query with COALESCE for unknown agent', async () => {
      const expectedRows = [
        {
          agent_id: 'unknown',
          total_memories: 3,
          avg_importance: 0.5,
          categories: [],
          active_ratio: 1.0,
        },
      ]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([
        { id: '1', namespace: 'ns' },
        { id: '2', namespace: 'ns' },
      ])

      const result = await analytics.agentPerformance(table)
      expect(result.rows).toEqual(expectedRows)

      // Verify SQL uses COALESCE(agent_id, 'unknown')
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("COALESCE(agent_id, 'unknown')"),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('agentPerformance — multi-table path with SQL injection safety', () => {
    it('escapes agent IDs with single quotes in UNION ALL SQL', async () => {
      connection.query.mockResolvedValueOnce(createMockResult([]))

      const frames = new Map<string, Table>()
      frames.set("agent-with-'quote", buildTestTable([{ id: '1', namespace: 'ns' }]))

      await analytics.agentPerformance(frames)

      // Verify the SQL escapes the single quote
      const sqlCall = connection.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("agent-with-''quote"),
      )
      expect(sqlCall).toBeTruthy()
    })
  })

  describe('close', () => {
    it('releases resources', async () => {
      // Should not throw
      await analytics.close()
    })
  })

  describe('custom — passes arbitrary SQL', () => {
    it('delegates to engine.query', async () => {
      const expectedRows = [{ sum_val: 100 }]
      connection.query.mockResolvedValueOnce(createMockResult(expectedRows))

      const table = buildTestTable([{ id: '1', namespace: 'ns' }])
      const result = await analytics.custom<{ sum_val: number }>(
        table,
        'SELECT SUM(1) AS sum_val FROM memory',
      )
      expect(result.rows).toEqual(expectedRows)
    })
  })
})
