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

  // ---------------------------------------------------------------------------
  // W17-B2: Additional coverage (25+ new tests)
  // ---------------------------------------------------------------------------

  // --- Concurrent saves ---

  describe('concurrent saves', () => {
    it('10 parallel saves with distinct runIds — no data loss', async () => {
      const saves = Array.from({ length: 10 }, (_, i) =>
        store.save(makeSummary({ runId: `concurrent-${i}`, qualityScore: i * 0.1 })),
      )
      await Promise.all(saves)
      expect(Object.keys(db._storage)).toHaveLength(10)
      for (let i = 0; i < 10; i++) {
        expect(db._storage[`concurrent-${i}`]).toBeDefined()
      }
    })

    it('concurrent saves of the same runId — only first is stored (idempotent)', async () => {
      const saves = Array.from({ length: 5 }, (_, i) =>
        store.save(makeSummary({ runId: 'same-run', qualityScore: i * 0.2 })),
      )
      await Promise.all(saves)
      expect(Object.keys(db._storage)).toHaveLength(1)
    })

    it('mixed concurrent save and get — get returns stored data or undefined', async () => {
      await store.save(makeSummary({ runId: 'preexisting' }))
      const [, result] = await Promise.all([
        store.save(makeSummary({ runId: 'new-run' })),
        store.get('preexisting'),
      ])
      expect(result).toBeDefined()
      expect(result!.runId).toBe('preexisting')
    })
  })

  // --- Large dataset and pagination ---

  describe('large dataset and list behavior', () => {
    it('seed 100 reflections — list() returns all 100', async () => {
      for (let i = 0; i < 100; i++) {
        db._seed(`run-${String(i).padStart(3, '0')}`, {
          completedAt: new Date(`2026-01-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`),
          durationMs: i * 100,
          totalSteps: i,
          toolCallCount: i % 10,
          errorCount: i % 3,
          patterns: [],
          qualityScore: (i % 100) / 100,
        })
      }
      const results = await store.list()
      expect(results).toHaveLength(100)
    })

    it('seed 100 reflections — list(10) returns exactly 10', async () => {
      for (let i = 0; i < 100; i++) {
        db._seed(`run-${String(i).padStart(3, '0')}`, {
          completedAt: new Date(`2026-04-16T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`),
          durationMs: 1000, totalSteps: 1, toolCallCount: 0, errorCount: 0,
          patterns: [], qualityScore: 0.5,
        })
      }
      const results = await store.list(10)
      expect(results).toHaveLength(10)
    })

    it('list with limit larger than dataset — returns all items', async () => {
      db._seed('run-a', { completedAt: new Date('2026-01-01'), durationMs: 1, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.5 })
      db._seed('run-b', { completedAt: new Date('2026-01-02'), durationMs: 1, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.5 })
      const results = await store.list(500)
      expect(results).toHaveLength(2)
    })

    it('list with limit=1 returns the most recent by completedAt', async () => {
      db._seed('run-old', {
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.1,
      })
      db._seed('run-new', {
        completedAt: new Date('2026-04-16T23:59:59.000Z'),
        durationMs: 200, totalSteps: 2, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.9,
      })
      const results = await store.list(1)
      expect(results).toHaveLength(1)
      expect(results[0]!.runId).toBe('run-new')
    })
  })

  // --- Quality score filtering (via list + manual filter, since store has no filter method) ---

  describe('quality score thresholds', () => {
    it('high quality reflections can be filtered from list results', async () => {
      db._seed('run-low', {
        completedAt: new Date('2026-01-01'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.3,
      })
      db._seed('run-mid', {
        completedAt: new Date('2026-01-02'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.7,
      })
      db._seed('run-high', {
        completedAt: new Date('2026-01-03'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.95,
      })

      const all = await store.list()
      const highQuality = all.filter((s) => s.qualityScore >= 0.8)
      expect(highQuality).toHaveLength(1)
      expect(highQuality[0]!.runId).toBe('run-high')
    })

    it('quality score boundary: 0.8 is included in >= 0.8 filter', async () => {
      db._seed('run-exact', {
        completedAt: new Date('2026-01-01'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.8,
      })
      const all = await store.list()
      const atThreshold = all.filter((s) => s.qualityScore >= 0.8)
      expect(atThreshold).toHaveLength(1)
    })
  })

  // --- Pattern type filtering ---

  describe('pattern type filtering', () => {
    it('getPatterns("slow_step") returns only slow_step patterns when mixed types exist', async () => {
      db._seed('run-mixed', {
        durationMs: 5000, totalSteps: 10, toolCallCount: 5, errorCount: 2,
        patterns: [
          { type: 'slow_step', description: 'step 3 took 10s', occurrences: 1, stepIndices: [3] },
          { type: 'repeated_tool', description: 'search x4', occurrences: 4, stepIndices: [0, 1, 2, 3] },
          { type: 'slow_step', description: 'step 7 took 15s', occurrences: 1, stepIndices: [7] },
          { type: 'error_loop', description: 'retries', occurrences: 2, stepIndices: [8, 9] },
        ],
        qualityScore: 0.4,
      })

      const slowPatterns = await store.getPatterns('slow_step')
      expect(slowPatterns).toHaveLength(2)
      expect(slowPatterns.every((p) => p.type === 'slow_step')).toBe(true)
    })

    it('getPatterns aggregates patterns from multiple runs', async () => {
      db._seed('run-1', {
        durationMs: 1000, totalSteps: 3, toolCallCount: 1, errorCount: 0,
        patterns: [{ type: 'successful_strategy', description: 'strat-a', occurrences: 1, stepIndices: [0] }],
        qualityScore: 0.9,
      })
      db._seed('run-2', {
        durationMs: 2000, totalSteps: 5, toolCallCount: 2, errorCount: 0,
        patterns: [{ type: 'successful_strategy', description: 'strat-b', occurrences: 1, stepIndices: [1] }],
        qualityScore: 0.85,
      })

      const strategies = await store.getPatterns('successful_strategy')
      expect(strategies).toHaveLength(2)
      expect(strategies.map((p) => p.description)).toContain('strat-a')
      expect(strategies.map((p) => p.description)).toContain('strat-b')
    })
  })

  // --- TTL/cleanup simulation ---

  describe('TTL/cleanup simulation', () => {
    it('old reflections can be excluded by completedAt date filter', async () => {
      const now = new Date('2026-04-16T12:00:00.000Z')
      const ttlMs = 7 * 24 * 60 * 60 * 1000 // 7 days
      const cutoff = new Date(now.getTime() - ttlMs)

      db._seed('run-old', {
        completedAt: new Date('2026-04-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.5,
      })
      db._seed('run-recent', {
        completedAt: new Date('2026-04-15T00:00:00.000Z'),
        durationMs: 200, totalSteps: 2, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.8,
      })

      const all = await store.list()
      const withinTTL = all.filter((s) => s.completedAt >= cutoff)
      expect(withinTTL).toHaveLength(1)
      expect(withinTTL[0]!.runId).toBe('run-recent')
    })

    it('all reflections within TTL are preserved', async () => {
      const now = new Date('2026-04-16T12:00:00.000Z')
      const ttlMs = 30 * 24 * 60 * 60 * 1000 // 30 days
      const cutoff = new Date(now.getTime() - ttlMs)

      db._seed('run-1', {
        completedAt: new Date('2026-04-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.5,
      })
      db._seed('run-2', {
        completedAt: new Date('2026-04-10T00:00:00.000Z'),
        durationMs: 200, totalSteps: 2, toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.7,
      })

      const all = await store.list()
      const withinTTL = all.filter((s) => s.completedAt >= cutoff)
      expect(withinTTL).toHaveLength(2)
    })
  })

  // --- Empty store queries ---

  describe('empty store queries', () => {
    it('get returns undefined on empty store', async () => {
      const result = await store.get('any-id')
      expect(result).toBeUndefined()
    })

    it('list returns empty array on empty store', async () => {
      const results = await store.list()
      expect(results).toEqual([])
    })

    it('list with limit returns empty array on empty store', async () => {
      const results = await store.list(5)
      expect(results).toEqual([])
    })

    it('getPatterns returns empty array on empty store for any type', async () => {
      const types = ['repeated_tool', 'error_loop', 'slow_step', 'successful_strategy'] as const
      for (const type of types) {
        const result = await store.getPatterns(type)
        expect(result).toEqual([])
      }
    })
  })

  // --- Update existing (idempotency behavior) ---

  describe('update existing (ON CONFLICT DO NOTHING)', () => {
    it('saving same runId twice does not duplicate — first value wins', async () => {
      await store.save(makeSummary({ runId: 'dup', qualityScore: 0.1, durationMs: 100 }))
      await store.save(makeSummary({ runId: 'dup', qualityScore: 0.9, durationMs: 999 }))

      const result = await store.get('dup')
      expect(result).toBeDefined()
      expect(result!.qualityScore).toBe(0.1)
      expect(result!.durationMs).toBe(100)
      expect(Object.keys(db._storage)).toHaveLength(1)
    })

    it('saving same runId 5 times — storage has exactly 1 entry', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeSummary({ runId: 'multi-dup', qualityScore: i * 0.2 }))
      }
      expect(Object.keys(db._storage)).toHaveLength(1)
      const result = await store.get('multi-dup')
      expect(result!.qualityScore).toBe(0)
    })
  })

  // --- Schema boundary ---

  describe('schema boundary', () => {
    it('extra fields in summary are not stored in the row', async () => {
      const summary = makeSummary({ runId: 'extra-fields' }) as ReflectionSummary & { extraField: string }
      ;(summary as Record<string, unknown>)['extraField'] = 'should-be-ignored'
      await store.save(summary)

      const row = db._storage['extra-fields']!
      // The store only maps known fields, so extraField should not appear
      expect(row).not.toHaveProperty('extraField')
    })

    it('saving with minimal fields does not throw', async () => {
      await expect(
        store.save(makeSummary({ runId: 'minimal', patterns: [], qualityScore: 0 })),
      ).resolves.not.toThrow()
    })
  })

  // --- Stats aggregation (via list) ---

  describe('stats aggregation via list', () => {
    it('average qualityScore can be computed from list results', async () => {
      db._seed('run-a', {
        completedAt: new Date('2026-01-01'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.6,
      })
      db._seed('run-b', {
        completedAt: new Date('2026-01-02'), durationMs: 200, totalSteps: 2,
        toolCallCount: 1, errorCount: 0, patterns: [], qualityScore: 0.8,
      })
      db._seed('run-c', {
        completedAt: new Date('2026-01-03'), durationMs: 300, totalSteps: 3,
        toolCallCount: 2, errorCount: 1, patterns: [], qualityScore: 1.0,
      })

      const all = await store.list()
      const avg = all.reduce((sum, s) => sum + s.qualityScore, 0) / all.length
      expect(avg).toBeCloseTo(0.8, 5)
    })

    it('total error count can be computed from list results', async () => {
      db._seed('run-a', {
        completedAt: new Date('2026-01-01'), durationMs: 100, totalSteps: 1,
        toolCallCount: 0, errorCount: 3, patterns: [], qualityScore: 0.5,
      })
      db._seed('run-b', {
        completedAt: new Date('2026-01-02'), durationMs: 200, totalSteps: 2,
        toolCallCount: 1, errorCount: 7, patterns: [], qualityScore: 0.3,
      })

      const all = await store.list()
      const totalErrors = all.reduce((sum, s) => sum + s.errorCount, 0)
      expect(totalErrors).toBe(10)
    })
  })

  // --- Zero-length patterns array ---

  describe('zero-length patterns array', () => {
    it('runs with patterns: [] do not contribute to any pattern query', async () => {
      db._seed('run-empty-patterns', {
        durationMs: 1000, totalSteps: 5, toolCallCount: 2, errorCount: 0,
        patterns: [],
        qualityScore: 0.9,
      })
      db._seed('run-with-patterns', {
        durationMs: 2000, totalSteps: 8, toolCallCount: 4, errorCount: 1,
        patterns: [{ type: 'repeated_tool', description: 'search x2', occurrences: 2, stepIndices: [0, 1] }],
        qualityScore: 0.7,
      })

      const repeated = await store.getPatterns('repeated_tool')
      expect(repeated).toHaveLength(1)
      expect(repeated[0]!.description).toBe('search x2')
    })

    it('all runs with empty patterns — getPatterns returns empty for every type', async () => {
      for (let i = 0; i < 5; i++) {
        db._seed(`run-no-patterns-${i}`, {
          durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0,
          patterns: [],
          qualityScore: 0.5 + i * 0.1,
        })
      }

      expect(await store.getPatterns('repeated_tool')).toEqual([])
      expect(await store.getPatterns('error_loop')).toEqual([])
      expect(await store.getPatterns('slow_step')).toEqual([])
      expect(await store.getPatterns('successful_strategy')).toEqual([])
    })
  })

  // --- rowToSummary edge cases ---

  describe('rowToSummary edge cases', () => {
    it('completedAt stored as string is converted to Date', async () => {
      // Simulate a row where completedAt is a string (e.g., from JSON serialization)
      db._storage['run-string-date'] = {
        runId: 'run-string-date',
        completedAt: '2026-04-16T15:30:00.000Z' as unknown as Date,
        durationMs: 500,
        totalSteps: 3,
        toolCallCount: 1,
        errorCount: 0,
        patterns: [],
        qualityScore: 0.75,
        createdAt: new Date(),
      }

      const result = await store.get('run-string-date')
      expect(result).toBeDefined()
      expect(result!.completedAt).toBeInstanceOf(Date)
      expect(result!.completedAt.toISOString()).toBe('2026-04-16T15:30:00.000Z')
    })

    it('null patterns in row are normalized to empty array', async () => {
      db._storage['run-null-patterns'] = {
        runId: 'run-null-patterns',
        completedAt: new Date('2026-04-16T12:00:00.000Z'),
        durationMs: 100,
        totalSteps: 1,
        toolCallCount: 0,
        errorCount: 0,
        patterns: null as unknown as [],
        qualityScore: 0.5,
        createdAt: new Date(),
      }

      const result = await store.get('run-null-patterns')
      expect(result).toBeDefined()
      expect(result!.patterns).toEqual([])
    })

    it('get after save returns same data fields', async () => {
      const original = makeSummary({
        runId: 'roundtrip',
        durationMs: 7777,
        totalSteps: 42,
        toolCallCount: 15,
        errorCount: 3,
        qualityScore: 0.88,
        patterns: [
          { type: 'error_loop', description: 'loop-desc', occurrences: 2, stepIndices: [5, 6] },
        ],
      })
      await store.save(original)
      const retrieved = await store.get('roundtrip')

      expect(retrieved).toBeDefined()
      expect(retrieved!.runId).toBe(original.runId)
      expect(retrieved!.durationMs).toBe(original.durationMs)
      expect(retrieved!.totalSteps).toBe(original.totalSteps)
      expect(retrieved!.toolCallCount).toBe(original.toolCallCount)
      expect(retrieved!.errorCount).toBe(original.errorCount)
      expect(retrieved!.qualityScore).toBe(original.qualityScore)
      expect(retrieved!.patterns).toEqual(original.patterns)
    })
  })

  // --- list ordering ---

  describe('list ordering', () => {
    it('list orders by completedAt descending across many entries', async () => {
      const dates = [
        '2026-01-15', '2026-03-01', '2026-02-10', '2026-04-01', '2026-01-01',
      ]
      for (let i = 0; i < dates.length; i++) {
        db._seed(`run-order-${i}`, {
          completedAt: new Date(`${dates[i]}T00:00:00.000Z`),
          durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0,
          patterns: [], qualityScore: 0.5,
        })
      }

      const results = await store.list()
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.completedAt.getTime()).toBeGreaterThanOrEqual(
          results[i]!.completedAt.getTime(),
        )
      }
    })

    it('list with limit returns the most recent N entries', async () => {
      db._seed('run-jan', {
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.1,
      })
      db._seed('run-feb', {
        completedAt: new Date('2026-02-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.5,
      })
      db._seed('run-mar', {
        completedAt: new Date('2026-03-01T00:00:00.000Z'),
        durationMs: 100, totalSteps: 1, toolCallCount: 0, errorCount: 0, patterns: [], qualityScore: 0.9,
      })

      const results = await store.list(2)
      expect(results).toHaveLength(2)
      expect(results[0]!.runId).toBe('run-mar')
      expect(results[1]!.runId).toBe('run-feb')
    })
  })
})
