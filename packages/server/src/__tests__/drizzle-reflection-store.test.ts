/**
 * Tests for DrizzleReflectionStore — persistent reflection storage backed by
 * a chainable mock DB object (no real Postgres connection needed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DrizzleReflectionStore } from '../persistence/drizzle-reflection-store.js'
import type { ReflectionSummary, ReflectionPattern } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Chainable mock DB — mirrors the Drizzle query-builder pattern
// ---------------------------------------------------------------------------

function createMockDb() {
  let storage: Record<string, Record<string, unknown>> = {}
  const now = new Date('2026-04-16T12:00:00.000Z')

  function makeRow(data: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: data.runId ?? data.run_id,
      completedAt: data.completedAt instanceof Date ? data.completedAt : now,
      durationMs: data.durationMs ?? 0,
      totalSteps: data.totalSteps ?? 0,
      toolCallCount: data.toolCallCount ?? 0,
      errorCount: data.errorCount ?? 0,
      patterns: data.patterns ?? [],
      qualityScore: data.qualityScore ?? 0,
      createdAt: data.createdAt instanceof Date ? data.createdAt : now,
    }
  }

  function chainable() {
    let _values: Record<string, unknown> | null = null
    let _whereId: string | null = null
    let _limitN: number | null = null
    let _mode: 'select' | 'insert' | 'delete' = 'select'
    let _whereConditions: Array<{ field: string; value: unknown }> = []
    let _orderDesc = false

    const chain: Record<string, unknown> = {
      from(_tbl: unknown) {
        return chain
      },
      values(v: Record<string, unknown>) {
        _values = v
        return chain
      },
      where(condition: unknown) {
        if (condition && typeof condition === 'object' && '_mockConditions' in (condition as Record<string, unknown>)) {
          _whereConditions = (condition as { _mockConditions: Array<{ field: string; value: unknown }> })._mockConditions
        } else if (condition && typeof condition === 'object' && '_mockField' in (condition as Record<string, unknown>)) {
          const c = condition as { _mockField: string; _mockValue: unknown }
          _whereConditions = [{ field: c._mockField, value: c._mockValue }]
        }
        const idCond = _whereConditions.find((c) => c.field === 'run_id' || c.field === 'runId')
        if (idCond) _whereId = idCond.value as string
        return chain
      },
      limit(n: number) {
        _limitN = n
        return chain
      },
      orderBy(_col: unknown) {
        _orderDesc = true
        return chain
      },
      onConflictDoNothing() {
        return chain
      },
      async returning() {
        if (_mode === 'insert' && _values) {
          const row = makeRow(_values)
          const key = row.runId as string
          // ON CONFLICT DO NOTHING: skip if already exists
          if (!storage[key]) {
            storage[key] = row
          }
          return [storage[key]]
        }
        if (_mode === 'delete') {
          if (_whereId && storage[_whereId]) {
            const row = storage[_whereId]
            delete storage[_whereId]
            return [row]
          }
          return []
        }
        return []
      },
      // For select queries — chain resolves as a thenable
      then(resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) {
        try {
          let results = Object.values(storage)

          for (const cond of _whereConditions) {
            const field = cond.field === 'run_id' ? 'runId' : cond.field
            results = results.filter((r) => r[field] === cond.value)
          }

          if (_orderDesc) {
            results.sort((a, b) => {
              const aTime = (a.completedAt as Date).getTime()
              const bTime = (b.completedAt as Date).getTime()
              return bTime - aTime
            })
          }

          if (_limitN !== undefined && _limitN !== null) {
            results = results.slice(0, _limitN)
          }
          resolve(results)
        } catch (e) {
          if (reject) reject(e)
        }
      },
    }
    return { chain, setMode: (m: typeof _mode) => { _mode = m } }
  }

  // For insert().values().onConflictDoNothing(), we need the insert to
  // return the chain and then await the full chain (not .returning()).
  // The DrizzleReflectionStore awaits the chain directly after onConflictDoNothing().
  const db = {
    select() {
      const { chain, setMode } = chainable()
      setMode('select')
      return chain
    },
    insert(_tbl: unknown) {
      const { chain, setMode } = chainable()
      setMode('insert')
      // Make the chain itself thenable for await on onConflictDoNothing
      const originalOnConflict = chain.onConflictDoNothing as () => typeof chain
      chain.onConflictDoNothing = () => {
        const result = originalOnConflict.call(chain)
        // Add thenable that executes the insert
        ;(result as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
          reject?: (e: unknown) => void,
        ) => {
          try {
            if (_values) {
              const row = makeRow(_values as Record<string, unknown>)
              const key = row.runId as string
              if (!storage[key]) {
                storage[key] = row
              }
            }
            resolve(undefined)
          } catch (e) {
            if (reject) reject(e)
          }
        }
        return result
      }
      // Capture _values reference
      let _values: Record<string, unknown> | null = null
      const originalValues = chain.values as (v: Record<string, unknown>) => typeof chain
      chain.values = (v: Record<string, unknown>) => {
        _values = v
        return originalValues.call(chain, v)
      }
      return chain
    },
    delete(_tbl: unknown) {
      const { chain, setMode } = chainable()
      setMode('delete')
      return chain
    },
    _storage: storage,
    _reset() { storage = {}; db._storage = storage },
    _seed(runId: string, data: Partial<Record<string, unknown>>) {
      storage[runId] = makeRow({ runId, ...data })
    },
  }

  return db
}

// Mock drizzle-orm eq, desc functions
vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown) => ({
    _mockField: column.name,
    _mockValue: value,
  }),
  desc: (column: { name: string }) => ({
    _mockDesc: column.name,
  }),
  and: (...conditions: Array<{ _mockField: string; _mockValue: unknown }>) => ({
    _mockConditions: conditions.map((c) => ({ field: c._mockField, value: c._mockValue })),
  }),
}))

// Mock the schema import
vi.mock('../persistence/drizzle-schema.js', () => ({
  runReflections: {
    runId: { name: 'run_id' },
    completedAt: { name: 'completed_at' },
    durationMs: { name: 'duration_ms' },
    totalSteps: { name: 'total_steps' },
    toolCallCount: { name: 'tool_call_count' },
    errorCount: { name: 'error_count' },
    patterns: { name: 'patterns' },
    qualityScore: { name: 'quality_score' },
    createdAt: { name: 'created_at' },
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<ReflectionSummary> = {}): ReflectionSummary {
  return {
    runId: overrides.runId ?? 'run-1',
    completedAt: overrides.completedAt ?? new Date('2026-04-16T12:00:00.000Z'),
    durationMs: overrides.durationMs ?? 5000,
    totalSteps: overrides.totalSteps ?? 10,
    toolCallCount: overrides.toolCallCount ?? 5,
    errorCount: overrides.errorCount ?? 1,
    patterns: overrides.patterns ?? [],
    qualityScore: overrides.qualityScore ?? 0.85,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleReflectionStore', () => {
  let db: ReturnType<typeof createMockDb>
  let store: DrizzleReflectionStore

  beforeEach(() => {
    db = createMockDb()
    store = new DrizzleReflectionStore(db)
  })

  // --- save ---

  it('save: inserts a new reflection row', async () => {
    await store.save(makeSummary())
    expect(Object.keys(db._storage)).toHaveLength(1)
    expect(db._storage['run-1']).toBeDefined()
  })

  it('save: stores correct field values', async () => {
    await store.save(makeSummary({ runId: 'run-abc', durationMs: 3000, qualityScore: 0.9 }))
    const row = db._storage['run-abc']!
    expect(row.runId).toBe('run-abc')
    expect(row.durationMs).toBe(3000)
    expect(row.qualityScore).toBe(0.9)
  })

  it('save: duplicate runId is idempotent (ON CONFLICT DO NOTHING)', async () => {
    await store.save(makeSummary({ runId: 'run-1', qualityScore: 0.5 }))
    await store.save(makeSummary({ runId: 'run-1', qualityScore: 0.99 }))
    expect(Object.keys(db._storage)).toHaveLength(1)
    // First insert wins
    expect(db._storage['run-1']!.qualityScore).toBe(0.5)
  })

  it('save: stores patterns as JSON', async () => {
    const patterns: ReflectionPattern[] = [
      { type: 'repeated_tool', description: 'web_search x3', occurrences: 3, stepIndices: [0, 1, 2] },
    ]
    await store.save(makeSummary({ patterns }))
    const row = db._storage['run-1']!
    expect(row.patterns).toEqual(patterns)
  })

  it('save: stores empty patterns array', async () => {
    await store.save(makeSummary({ patterns: [] }))
    const row = db._storage['run-1']!
    expect(row.patterns).toEqual([])
  })

  it('save: multiple distinct runs', async () => {
    await store.save(makeSummary({ runId: 'run-1' }))
    await store.save(makeSummary({ runId: 'run-2' }))
    await store.save(makeSummary({ runId: 'run-3' }))
    expect(Object.keys(db._storage)).toHaveLength(3)
  })

  // --- get ---

  it('get: returns summary for existing runId', async () => {
    db._seed('run-1', {
      durationMs: 5000,
      totalSteps: 10,
      toolCallCount: 5,
      errorCount: 1,
      patterns: [],
      qualityScore: 0.85,
    })

    const result = await store.get('run-1')
    expect(result).toBeDefined()
    expect(result!.runId).toBe('run-1')
    expect(result!.durationMs).toBe(5000)
    expect(result!.qualityScore).toBe(0.85)
  })

  it('get: returns undefined for missing runId', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('get: returns completedAt as Date', async () => {
    db._seed('run-1', {
      completedAt: new Date('2026-04-16T15:00:00.000Z'),
      durationMs: 1000,
      totalSteps: 5,
      toolCallCount: 2,
      errorCount: 0,
      patterns: [],
      qualityScore: 0.9,
    })

    const result = await store.get('run-1')
    expect(result!.completedAt).toBeInstanceOf(Date)
  })

  it('get: returns patterns array from stored row', async () => {
    const patterns: ReflectionPattern[] = [
      { type: 'error_loop', description: 'retry x5', occurrences: 5, stepIndices: [3, 4, 5, 6, 7] },
    ]
    db._seed('run-1', {
      durationMs: 1000,
      totalSteps: 8,
      toolCallCount: 3,
      errorCount: 5,
      patterns,
      qualityScore: 0.3,
    })

    const result = await store.get('run-1')
    expect(result!.patterns).toEqual(patterns)
  })

  // --- list ---

  it('list: returns all reflections ordered by completedAt desc', async () => {
    db._seed('run-old', {
      completedAt: new Date('2026-04-15T10:00:00.000Z'),
      durationMs: 1000, totalSteps: 3, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.7,
    })
    db._seed('run-new', {
      completedAt: new Date('2026-04-16T10:00:00.000Z'),
      durationMs: 2000, totalSteps: 5, toolCallCount: 2, errorCount: 1, patterns: [], qualityScore: 0.9,
    })

    const results = await store.list()
    expect(results).toHaveLength(2)
    expect(results[0]!.runId).toBe('run-new')
    expect(results[1]!.runId).toBe('run-old')
  })

  it('list: respects limit parameter', async () => {
    db._seed('run-1', {
      completedAt: new Date('2026-04-14T10:00:00.000Z'),
      durationMs: 1000, totalSteps: 3, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.7,
    })
    db._seed('run-2', {
      completedAt: new Date('2026-04-15T10:00:00.000Z'),
      durationMs: 1000, totalSteps: 3, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.8,
    })
    db._seed('run-3', {
      completedAt: new Date('2026-04-16T10:00:00.000Z'),
      durationMs: 1000, totalSteps: 3, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.9,
    })

    const results = await store.list(2)
    expect(results).toHaveLength(2)
  })

  it('list: returns empty array when no reflections', async () => {
    const results = await store.list()
    expect(results).toEqual([])
  })

  // --- getPatterns ---

  it('getPatterns: returns patterns of specified type', async () => {
    db._seed('run-1', {
      durationMs: 1000, totalSteps: 5, toolCallCount: 2, errorCount: 1,
      patterns: [
        { type: 'repeated_tool', description: 'web_search x3', occurrences: 3, stepIndices: [0, 1, 2] },
        { type: 'error_loop', description: 'retry x2', occurrences: 2, stepIndices: [3, 4] },
      ],
      qualityScore: 0.6,
    })
    db._seed('run-2', {
      durationMs: 2000, totalSteps: 8, toolCallCount: 4, errorCount: 0,
      patterns: [
        { type: 'repeated_tool', description: 'db_query x4', occurrences: 4, stepIndices: [0, 1, 2, 3] },
        { type: 'successful_strategy', description: 'clean run', occurrences: 1, stepIndices: [0] },
      ],
      qualityScore: 0.95,
    })

    const repeatedPatterns = await store.getPatterns('repeated_tool')
    expect(repeatedPatterns).toHaveLength(2)
    expect(repeatedPatterns.every((p) => p.type === 'repeated_tool')).toBe(true)
  })

  it('getPatterns: returns empty array when no patterns match', async () => {
    db._seed('run-1', {
      durationMs: 1000, totalSteps: 5, toolCallCount: 2, errorCount: 0,
      patterns: [
        { type: 'successful_strategy', description: 'clean', occurrences: 1, stepIndices: [0] },
      ],
      qualityScore: 0.9,
    })

    const result = await store.getPatterns('error_loop')
    expect(result).toEqual([])
  })

  it('getPatterns: returns empty array when no reflections exist', async () => {
    const result = await store.getPatterns('slow_step')
    expect(result).toEqual([])
  })

  it('getPatterns: handles rows with empty patterns array', async () => {
    db._seed('run-1', {
      durationMs: 1000, totalSteps: 5, toolCallCount: 2, errorCount: 0,
      patterns: [],
      qualityScore: 0.9,
    })

    const result = await store.getPatterns('repeated_tool')
    expect(result).toEqual([])
  })
})
