/**
 * Contract tests for {@link LearningStore} implementations.
 *
 * The same suite runs against both InMemoryLearningStore and FileLearningStore
 * to guarantee behavioural equivalence.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, existsSync, writeFileSync } from 'node:fs'
import { InMemoryLearningStore } from '../learning/in-memory-learning-store.js'
import { FileLearningStore } from '../learning/file-learning-store.js'
import type { LearningStore } from '../learning/learning-store.js'
import type { ExecutionRecord, ProviderProfile, FailurePattern } from '../learning/adapter-learning-loop.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    providerId: 'claude',
    taskType: 'code',
    tags: ['code'],
    success: true,
    durationMs: 100,
    inputTokens: 50,
    outputTokens: 100,
    costCents: 0.5,
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeProfile(overrides?: Partial<ProviderProfile>): ProviderProfile {
  return {
    providerId: 'claude',
    totalExecutions: 42,
    successRate: 0.95,
    avgDurationMs: 120,
    avgCostCents: 0.4,
    avgQualityScore: 0.9,
    specialties: ['code'],
    weaknesses: [],
    trend: 'stable',
    ...overrides,
  }
}

function makePattern(overrides?: Partial<FailurePattern>): FailurePattern {
  return {
    patternId: 'claude:rate_limit:1000',
    providerId: 'claude',
    errorType: 'rate_limit',
    frequency: 5,
    firstSeen: new Date('2025-01-01'),
    lastSeen: new Date('2025-01-02'),
    suggestedAction: { action: 'retry', backoffMs: 1000, reason: 'rate limited' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Contract test runner
// ---------------------------------------------------------------------------

function runStoreTests(
  name: string,
  createStore: () => { store: LearningStore; cleanup: () => void },
): void {
  describe(name, () => {
    let store: LearningStore
    let cleanup: () => void

    afterEach(() => {
      cleanup()
    })

    // -- Records ----------------------------------------------------------

    it('saves and loads records', () => {
      ;({ store, cleanup } = createStore())
      const rec = makeRecord()
      store.saveRecord('claude', rec)

      const loaded = store.loadRecords('claude', 10)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toEqual(rec)
    })

    it('loadRecords returns empty array for unknown provider', () => {
      ;({ store, cleanup } = createStore())
      expect(store.loadRecords('unknown', 10)).toEqual([])
    })

    it('loadRecords respects limit', () => {
      ;({ store, cleanup } = createStore())
      for (let i = 0; i < 10; i++) {
        store.saveRecord('claude', makeRecord({ timestamp: i }))
      }

      const loaded = store.loadRecords('claude', 3)
      expect(loaded).toHaveLength(3)
      // Should return the 3 most recent (oldest-first within the slice)
      expect(loaded[0]!.timestamp).toBe(7)
      expect(loaded[1]!.timestamp).toBe(8)
      expect(loaded[2]!.timestamp).toBe(9)
    })

    // -- Profiles ---------------------------------------------------------

    it('saves and gets profiles', () => {
      ;({ store, cleanup } = createStore())
      const profile = makeProfile()
      store.saveProfile('claude', profile)

      expect(store.getProfile('claude')).toEqual(profile)
    })

    it('getProfile returns undefined for unknown provider', () => {
      ;({ store, cleanup } = createStore())
      expect(store.getProfile('unknown')).toBeUndefined()
    })

    it('saveProfile overwrites previous profile', () => {
      ;({ store, cleanup } = createStore())
      store.saveProfile('claude', makeProfile({ successRate: 0.5 }))
      store.saveProfile('claude', makeProfile({ successRate: 0.9 }))

      expect(store.getProfile('claude')?.successRate).toBe(0.9)
    })

    // -- Failure patterns -------------------------------------------------

    it('saves and gets failure patterns', () => {
      ;({ store, cleanup } = createStore())
      const patterns = [makePattern(), makePattern({ patternId: 'claude:timeout:2000', errorType: 'timeout' })]
      store.saveFailurePatterns('claude', patterns)

      const loaded = store.getFailurePatterns('claude')
      expect(loaded).toHaveLength(2)
    })

    it('getFailurePatterns returns empty array for unknown provider', () => {
      ;({ store, cleanup } = createStore())
      expect(store.getFailurePatterns('unknown')).toEqual([])
    })

    // -- Export / Import --------------------------------------------------

    it('export/import round-trip preserves data', () => {
      ;({ store, cleanup } = createStore())

      store.saveRecord('claude', makeRecord({ timestamp: 1 }))
      store.saveRecord('gemini', makeRecord({ providerId: 'gemini', timestamp: 2 }))
      store.saveProfile('claude', makeProfile())
      store.saveFailurePatterns('claude', [makePattern()])

      const snapshot = store.exportAll()
      expect(snapshot.version).toBe(1)
      expect(snapshot.exportedAt).toBeGreaterThan(0)

      // Import into a fresh store of the same type
      const { store: store2, cleanup: cleanup2 } = createStore()
      store2.importAll(snapshot)

      expect(store2.loadRecords('claude', 100)).toHaveLength(1)
      expect(store2.loadRecords('gemini', 100)).toHaveLength(1)
      expect(store2.getProfile('claude')).toEqual(makeProfile())
      expect(store2.getFailurePatterns('claude')).toHaveLength(1)

      cleanup2()
    })

    it('importAll replaces existing data', () => {
      ;({ store, cleanup } = createStore())

      store.saveRecord('claude', makeRecord({ timestamp: 1 }))
      store.saveRecord('claude', makeRecord({ timestamp: 2 }))

      const snapshot = store.exportAll()
      // Clear by importing an empty-ish snapshot
      store.importAll({ version: 1, exportedAt: 0, records: {}, profiles: {}, failurePatterns: {} })

      expect(store.loadRecords('claude', 100)).toHaveLength(0)

      // Re-import original
      store.importAll(snapshot)
      expect(store.loadRecords('claude', 100)).toHaveLength(2)
    })

    // -- Compaction -------------------------------------------------------

    it('compact removes old records beyond the limit', () => {
      ;({ store, cleanup } = createStore())
      for (let i = 0; i < 20; i++) {
        store.saveRecord('claude', makeRecord({ timestamp: i }))
      }

      const result = store.compact(5)
      expect(result.removedCount).toBe(15)
      expect(store.loadRecords('claude', 100)).toHaveLength(5)
      // Should keep the newest 5
      expect(store.loadRecords('claude', 100)[0]!.timestamp).toBe(15)
    })

    it('compact returns zero when no compaction needed', () => {
      ;({ store, cleanup } = createStore())
      store.saveRecord('claude', makeRecord())

      const result = store.compact(100)
      expect(result.removedCount).toBe(0)
    })

    it('compact handles multiple providers', () => {
      ;({ store, cleanup } = createStore())
      for (let i = 0; i < 10; i++) {
        store.saveRecord('claude', makeRecord({ timestamp: i }))
        store.saveRecord('gemini', makeRecord({ providerId: 'gemini', timestamp: i }))
      }

      const result = store.compact(3)
      expect(result.removedCount).toBe(14)
      expect(store.loadRecords('claude', 100)).toHaveLength(3)
      expect(store.loadRecords('gemini', 100)).toHaveLength(3)
    })
  })
}

// ---------------------------------------------------------------------------
// Run against both implementations
// ---------------------------------------------------------------------------

runStoreTests('InMemoryLearningStore', () => {
  const store = new InMemoryLearningStore()
  return { store, cleanup: () => store.dispose() }
})

runStoreTests('FileLearningStore', () => {
  const filePath = join(tmpdir(), `test-learning-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  // Use a very long flush interval so tests don't auto-flush
  const store = new FileLearningStore(filePath, 999_999)
  return {
    store,
    cleanup: () => {
      store.dispose()
      if (existsSync(filePath)) unlinkSync(filePath)
    },
  }
})

// ---------------------------------------------------------------------------
// FileLearningStore-specific tests
// ---------------------------------------------------------------------------

describe('FileLearningStore (persistence)', () => {
  const filePath = join(tmpdir(), `test-learning-persist-${Date.now()}.json`)

  afterEach(() => {
    if (existsSync(filePath)) unlinkSync(filePath)
  })

  it('persists data across instances via dispose flush', () => {
    const store1 = new FileLearningStore(filePath, 999_999)
    store1.saveRecord('claude', makeRecord({ timestamp: 42 }))
    store1.saveProfile('claude', makeProfile())
    store1.dispose()

    // New instance should read persisted data
    const store2 = new FileLearningStore(filePath, 999_999)
    const records = store2.loadRecords('claude', 100)
    expect(records).toHaveLength(1)
    expect(records[0]!.timestamp).toBe(42)
    expect(store2.getProfile('claude')).toBeDefined()
    store2.dispose()
  })

  it('handles corrupted file gracefully', () => {
    writeFileSync(filePath, '!!!not json!!!', 'utf-8')

    const store = new FileLearningStore(filePath, 999_999)
    // Should start fresh, not throw
    expect(store.loadRecords('claude', 10)).toEqual([])
    store.dispose()
  })
})
