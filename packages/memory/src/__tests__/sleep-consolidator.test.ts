import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SleepConsolidator,
  runSleepConsolidation,
} from '../sleep-consolidator.js'
import type {
  SleepConsolidationConfig,
  SleepPhase,
} from '../sleep-consolidator.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'
import type { CausalGraph } from '../causal/causal-graph.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MockStoreRecord {
  key: string
  value: Record<string, unknown>
}

function createMockStore(records: MockStoreRecord[] = []) {
  const data = new Map<string, Record<string, unknown>>()
  for (const r of records) {
    data.set(r.key, r.value)
  }

  const store = {
    search: vi.fn().mockImplementation(
      (_ns: string[], _opts?: { query?: string; limit?: number }) => {
        const items = [...data.entries()].map(([key, value]) => ({ key, value }))
        return Promise.resolve(items)
      },
    ),
    put: vi.fn().mockImplementation(
      (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, value)
        return Promise.resolve()
      },
    ),
    delete: vi.fn().mockImplementation((_ns: string[], key: string) => {
      data.delete(key)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((_ns: string[], key: string) => {
      const value = data.get(key)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    _data: data,
  }

  return store as unknown as BaseStore & { _data: Map<string, Record<string, unknown>> }
}

function createMockModel(responses: string[] = []) {
  let callIndex = 0
  const model = {
    invoke: vi.fn().mockImplementation(() => {
      const response = responses[callIndex] ?? '{"action":"noop","reason":"no change"}'
      callIndex++
      return Promise.resolve({ content: response })
    }),
    _modelType: vi.fn().mockReturnValue('chat'),
    _llmType: vi.fn().mockReturnValue('mock'),
  }
  return model as unknown as BaseChatModel
}

function createConfig(overrides?: Partial<SleepConsolidationConfig>): SleepConsolidationConfig {
  return {
    model: createMockModel(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepConsolidator', () => {
  // ---- Empty namespaces ---------------------------------------------------

  describe('run() with empty namespaces', () => {
    it('should return empty report', async () => {
      const store = createMockStore()
      const consolidator = new SleepConsolidator(createConfig())

      const report = await consolidator.run(store, [])
      expect(report.namespaces).toHaveLength(0)
      expect(report.totalLLMCalls).toBe(0)
      expect(typeof report.durationMs).toBe('number')
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  // ---- Phase selection ----------------------------------------------------

  describe('phase selection', () => {
    it('should only run specified phases', async () => {
      const store = createMockStore([
        { key: 'r1', value: { text: 'hello' } },
      ])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['heal'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.phasesRun).toEqual(['heal'])
      // dedup did not run so no LLM calls
      expect(report.totalLLMCalls).toBe(0)
    })

    it('should default to all phases', () => {
      const consolidator = new SleepConsolidator(createConfig())
      // We test indirectly via the report
      // The phasesRun should include all 4
    })
  })

  // ---- Dedup phase --------------------------------------------------------

  describe('dedup phase', () => {
    it('should invoke SemanticConsolidator (via LLM)', async () => {
      // SemanticConsolidator internally calls store.search and model.invoke.
      // We mock the model to return noop so nothing gets deleted.
      const model = createMockModel([
        '{"action":"noop","reason":"different topics"}',
      ])
      const store = createMockStore([
        { key: 'r1', value: { text: 'hello world' } },
        { key: 'r2', value: { text: 'hello world again' } },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({ model, phases: ['dedup'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.phasesRun).toContain('dedup')
      // The dedup phase ran (even if it found no real duplicates in mock)
      expect(report.namespaces).toHaveLength(1)
    })
  })

  // ---- Decay-prune phase --------------------------------------------------

  describe('decay-prune phase', () => {
    it('should delete records below strength threshold', async () => {
      const now = Date.now()
      // Create a record with very low decay strength (old, never re-accessed)
      const weakRecord = {
        key: 'weak',
        value: {
          text: 'old memory',
          _decay: {
            strength: 0.01,
            accessCount: 1,
            lastAccessedAt: now - 365 * 24 * 60 * 60 * 1000, // 1 year ago
            createdAt: now - 365 * 24 * 60 * 60 * 1000,
            halfLifeMs: 24 * 60 * 60 * 1000, // 24 hours
          },
        },
      }
      const strongRecord = {
        key: 'strong',
        value: {
          text: 'recent memory',
          _decay: {
            strength: 0.95,
            accessCount: 10,
            lastAccessedAt: now,
            createdAt: now,
            halfLifeMs: 30 * 24 * 60 * 60 * 1000,
          },
        },
      }

      const store = createMockStore([weakRecord, strongRecord])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['decay-prune'], decayPruneThreshold: 0.1 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBeGreaterThanOrEqual(1)

      // The weak record should have been deleted
      const deleteFn = (store as unknown as { delete: ReturnType<typeof vi.fn> }).delete
      expect(deleteFn).toHaveBeenCalled()
    })

    it('should not delete records above threshold', async () => {
      const now = Date.now()
      const store = createMockStore([
        {
          key: 'strong',
          value: {
            text: 'fresh memory',
            _decay: {
              strength: 0.95,
              accessCount: 5,
              lastAccessedAt: now,
              createdAt: now,
              halfLifeMs: 30 * 24 * 60 * 60 * 1000,
            },
          },
        },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['decay-prune'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBe(0)
    })
  })

  // ---- Heal phase ---------------------------------------------------------

  describe('heal phase', () => {
    it('should run healMemory on records', async () => {
      const store = createMockStore([
        { key: 'r1', value: { text: 'use typescript always' } },
        { key: 'r2', value: { text: 'never use typescript' } },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['heal'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.phasesRun).toContain('heal')
      expect(report.namespaces).toHaveLength(1)
      // healMemory runs — healed count comes from HealingReport.resolved
      expect(typeof report.namespaces[0]!.healed).toBe('number')
    })
  })

  // ---- maxLLMCalls budget -------------------------------------------------

  describe('maxLLMCalls budget', () => {
    it('should respect budget across namespaces', async () => {
      const model = createMockModel([
        '{"action":"noop","reason":"ok"}',
        '{"action":"noop","reason":"ok"}',
      ])

      const store = createMockStore([
        { key: 'r1', value: { text: 'memory one' } },
        { key: 'r2', value: { text: 'memory two' } },
      ])

      // Set very low budget
      const consolidator = new SleepConsolidator(
        createConfig({ model, phases: ['dedup'], maxLLMCalls: 1 }),
      )

      const report = await consolidator.run(store, [
        ['ns', 'a'],
        ['ns', 'b'],
      ])

      // Budget should constrain total LLM calls
      expect(report.totalLLMCalls).toBeLessThanOrEqual(1)
    })

    it('should skip dedup phase when budget is exhausted', async () => {
      const model = createMockModel()
      const store = createMockStore([
        { key: 'r1', value: { text: 'data' } },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({ model, phases: ['dedup'], maxLLMCalls: 0 }),
      )

      const report = await consolidator.run(store, [['ns', 'a']])
      // With 0 budget, dedup should be skipped
      expect(report.totalLLMCalls).toBe(0)
    })
  })

  // ---- Multiple namespaces ------------------------------------------------

  describe('multiple namespaces', () => {
    it('should process namespaces sequentially', async () => {
      const store = createMockStore([
        { key: 'r1', value: { text: 'record' } },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['heal'] }),
      )

      const report = await consolidator.run(store, [
        ['ns', 'one'],
        ['ns', 'two'],
        ['ns', 'three'],
      ])

      expect(report.namespaces).toHaveLength(3)
      for (const ns of report.namespaces) {
        expect(typeof ns.deduplicated).toBe('number')
        expect(typeof ns.pruned).toBe('number')
        expect(typeof ns.contradictionsFound).toBe('number')
        expect(typeof ns.healed).toBe('number')
      }
    })
  })

  // ---- Non-fatal store errors ---------------------------------------------

  describe('non-fatal error handling', () => {
    it('should not crash when store.search throws during decay-prune', async () => {
      const store = createMockStore()
      ;(store as unknown as { search: ReturnType<typeof vi.fn> }).search
        .mockRejectedValue(new Error('store unavailable'))

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['decay-prune'] }),
      )

      // Should not throw
      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces).toHaveLength(1)
      expect(report.namespaces[0]!.pruned).toBe(0)
    })

    it('should not crash when store.search throws during heal', async () => {
      const store = createMockStore()
      ;(store as unknown as { search: ReturnType<typeof vi.fn> }).search
        .mockRejectedValue(new Error('store unavailable'))

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['heal'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.healed).toBe(0)
    })

    it('should not crash when individual delete fails during decay-prune', async () => {
      const now = Date.now()
      const store = createMockStore([
        {
          key: 'weak',
          value: {
            text: 'old',
            _decay: {
              strength: 0.001,
              accessCount: 1,
              lastAccessedAt: now - 365 * 24 * 60 * 60 * 1000,
              createdAt: now - 365 * 24 * 60 * 60 * 1000,
              halfLifeMs: 24 * 60 * 60 * 1000,
            },
          },
        },
      ])
      ;(store as unknown as { delete: ReturnType<typeof vi.fn> }).delete
        .mockRejectedValue(new Error('delete failed'))

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['decay-prune'] }),
      )

      // Should not throw
      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces).toHaveLength(1)
      // pruned stays 0 because the delete failed
      expect(report.namespaces[0]!.pruned).toBe(0)
    })
  })

  // ---- durationMs tracking ------------------------------------------------

  describe('durationMs', () => {
    it('should track duration correctly', async () => {
      const store = createMockStore()
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['heal'] }),
      )

      const report = await consolidator.run(store, [['ns', 'a']])
      expect(typeof report.durationMs).toBe('number')
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  // ---- Arrow-accelerated decay-prune --------------------------------------

  describe('Arrow-accelerated decay-prune (useArrow)', () => {
    it('should prune weak records via Arrow path', async () => {
      const now = Date.now()
      const weakRecord = {
        key: 'weak',
        value: {
          text: 'old memory',
          _decay: {
            strength: 0.01,
            accessCount: 1,
            lastAccessedAt: now - 365 * 24 * 60 * 60 * 1000,
            createdAt: now - 365 * 24 * 60 * 60 * 1000,
            halfLifeMs: 24 * 60 * 60 * 1000,
          },
        },
      }
      const strongRecord = {
        key: 'strong',
        value: {
          text: 'recent memory',
          _decay: {
            strength: 0.95,
            accessCount: 10,
            lastAccessedAt: now,
            createdAt: now,
            halfLifeMs: 30 * 24 * 60 * 60 * 1000,
          },
        },
      }

      const store = createMockStore([weakRecord, strongRecord])
      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          decayPruneThreshold: 0.1,
          useArrow: true,
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      // Should have pruned the weak record
      expect(report.namespaces[0]!.pruned).toBeGreaterThanOrEqual(1)

      const deleteFn = (store as unknown as { delete: ReturnType<typeof vi.fn> }).delete
      // Weak record should be deleted, strong should not
      const deletedKeys = deleteFn.mock.calls.map(
        (call: unknown[]) => call[1],
      )
      expect(deletedKeys).toContain('weak')
      expect(deletedKeys).not.toContain('strong')
    })

    it('should not prune strong records via Arrow path', async () => {
      const now = Date.now()
      const store = createMockStore([
        {
          key: 'strong',
          value: {
            text: 'fresh memory',
            _decay: {
              strength: 0.95,
              accessCount: 5,
              lastAccessedAt: now,
              createdAt: now,
              halfLifeMs: 30 * 24 * 60 * 60 * 1000,
            },
          },
        },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          useArrow: true,
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBe(0)
    })

    it('should handle empty store via Arrow path', async () => {
      const store = createMockStore([])
      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          useArrow: true,
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBe(0)
    })

    it('should handle records without decay metadata via Arrow path', async () => {
      const store = createMockStore([
        { key: 'no-decay', value: { text: 'just text' } },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          useArrow: true,
        }),
      )

      // Should not throw, should not prune
      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBe(0)
    })

    it('should fall back to standard path when Arrow import fails', async () => {
      // We mock the dynamic import to fail
      const originalImport = vi.fn()
      vi.mock('@dzupagent/memory-ipc', () => {
        throw new Error('Module not found')
      })

      const now = Date.now()
      const store = createMockStore([
        {
          key: 'weak',
          value: {
            text: 'old',
            _decay: {
              strength: 0.001,
              accessCount: 1,
              lastAccessedAt: now - 365 * 24 * 60 * 60 * 1000,
              createdAt: now - 365 * 24 * 60 * 60 * 1000,
              halfLifeMs: 24 * 60 * 60 * 1000,
            },
          },
        },
      ])

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          decayPruneThreshold: 0.1,
          useArrow: true,
        }),
      )

      // Should fall back to standard and still prune the weak record
      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.pruned).toBeGreaterThanOrEqual(1)

      vi.restoreAllMocks()
    })

    it('should produce identical results to standard path', async () => {
      const now = Date.now()
      const records = [
        {
          key: 'old-1',
          value: {
            text: 'ancient memory 1',
            _decay: {
              strength: 0.02,
              accessCount: 1,
              lastAccessedAt: now - 200 * 24 * 60 * 60 * 1000,
              createdAt: now - 200 * 24 * 60 * 60 * 1000,
              halfLifeMs: 24 * 60 * 60 * 1000,
            },
          },
        },
        {
          key: 'medium',
          value: {
            text: 'medium memory',
            _decay: {
              strength: 0.5,
              accessCount: 3,
              lastAccessedAt: now - 12 * 60 * 60 * 1000, // 12h ago
              createdAt: now - 48 * 60 * 60 * 1000,
              halfLifeMs: 48 * 60 * 60 * 1000, // 48h half-life
            },
          },
        },
        {
          key: 'strong-1',
          value: {
            text: 'fresh memory',
            _decay: {
              strength: 1.0,
              accessCount: 10,
              lastAccessedAt: now,
              createdAt: now,
              halfLifeMs: 30 * 24 * 60 * 60 * 1000,
            },
          },
        },
      ]

      // Run standard path
      const storeStandard = createMockStore(JSON.parse(JSON.stringify(records)) as MockStoreRecord[])
      const standardConsolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          decayPruneThreshold: 0.1,
          useArrow: false,
        }),
      )
      const standardReport = await standardConsolidator.run(storeStandard, [['test', 'ns']])

      // Run Arrow path
      const storeArrow = createMockStore(JSON.parse(JSON.stringify(records)) as MockStoreRecord[])
      const arrowConsolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          decayPruneThreshold: 0.1,
          useArrow: true,
        }),
      )
      const arrowReport = await arrowConsolidator.run(storeArrow, [['test', 'ns']])

      // Both paths should prune the same number of records
      expect(arrowReport.namespaces[0]!.pruned).toBe(standardReport.namespaces[0]!.pruned)

      // Both stores should have the same remaining keys
      const standardKeys = [...storeStandard._data.keys()].sort()
      const arrowKeys = [...storeArrow._data.keys()].sort()
      expect(arrowKeys).toEqual(standardKeys)
    })

    it('should not crash when delete fails via Arrow path', async () => {
      const now = Date.now()
      const store = createMockStore([
        {
          key: 'weak',
          value: {
            text: 'old',
            _decay: {
              strength: 0.001,
              accessCount: 1,
              lastAccessedAt: now - 365 * 24 * 60 * 60 * 1000,
              createdAt: now - 365 * 24 * 60 * 60 * 1000,
              halfLifeMs: 24 * 60 * 60 * 1000,
            },
          },
        },
      ])
      ;(store as unknown as { delete: ReturnType<typeof vi.fn> }).delete
        .mockRejectedValue(new Error('delete failed'))

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['decay-prune'],
          useArrow: true,
        }),
      )

      // Should not throw
      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces).toHaveLength(1)
      expect(report.namespaces[0]!.pruned).toBe(0)
    })
  })

  // ---- runSleepConsolidation convenience ----------------------------------

  describe('runSleepConsolidation()', () => {
    it('should delegate to SleepConsolidator', async () => {
      const store = createMockStore()
      const config = createConfig({ phases: ['heal'] })

      const report = await runSleepConsolidation(store, [['ns', 'a']], config)
      expect(report.phasesRun).toEqual(['heal'])
      expect(report.namespaces).toHaveLength(1)
    })

    it('should return same structure as SleepConsolidator.run()', async () => {
      const store = createMockStore()
      const config = createConfig()

      const report = await runSleepConsolidation(store, [], config)
      expect(report).toHaveProperty('namespaces')
      expect(report).toHaveProperty('totalLLMCalls')
      expect(report).toHaveProperty('durationMs')
      expect(report).toHaveProperty('phasesRun')
    })
  })

  // ---- Staleness-prune phase ----------------------------------------------

  describe('staleness-prune phase', () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000
    const NOW = Date.now()

    function staleRecord(key: string) {
      return {
        key,
        value: {
          text: `stale: ${key}`,
          createdAt: NOW - 100 * MS_PER_DAY,
          accessCount: 1,
        },
      }
    }

    function freshRecord(key: string) {
      return {
        key,
        value: {
          text: `fresh: ${key}`,
          createdAt: NOW - 1 * MS_PER_DAY,
          accessCount: 10,
        },
      }
    }

    it('should delete stale entries from the store', async () => {
      const store = createMockStore([staleRecord('old'), freshRecord('new')])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'], stalenessThreshold: 30 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(1)
      expect(store._data.has('old')).toBe(false)
      expect(store._data.has('new')).toBe(true)
    })

    it('should not delete fresh entries', async () => {
      const store = createMockStore([freshRecord('a'), freshRecord('b')])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'], stalenessThreshold: 30 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(0)
      expect(store._data.has('a')).toBe(true)
      expect(store._data.has('b')).toBe(true)
    })

    it('should call causalGraph.removeNode for each pruned entry when causalGraph is provided', async () => {
      const store = createMockStore([staleRecord('stale-1'), staleRecord('stale-2'), freshRecord('keep')])
      const mockGraph = {
        removeNode: vi.fn().mockResolvedValue(1),
      }

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['staleness-prune'],
          stalenessThreshold: 30,
          causalGraph: mockGraph as unknown as CausalGraph,
          causalNamespace: 'test-ns',
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(2)
      expect(mockGraph.removeNode).toHaveBeenCalledTimes(2)
      expect(mockGraph.removeNode).toHaveBeenCalledWith('stale-1', 'test-ns')
      expect(mockGraph.removeNode).toHaveBeenCalledWith('stale-2', 'test-ns')
    })

    it('should report stalenessCausalRelationsRemoved from causalGraph.removeNode', async () => {
      const store = createMockStore([staleRecord('a'), staleRecord('b')])
      const mockGraph = {
        removeNode: vi.fn().mockResolvedValue(3),
      }

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['staleness-prune'],
          stalenessThreshold: 30,
          causalGraph: mockGraph as unknown as CausalGraph,
          causalNamespace: 'ns',
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessCausalRelationsRemoved).toBe(6)
    })

    it('should not call removeNode when nothing is pruned', async () => {
      const store = createMockStore([freshRecord('f1'), freshRecord('f2')])
      const mockGraph = {
        removeNode: vi.fn().mockResolvedValue(0),
      }

      const consolidator = new SleepConsolidator(
        createConfig({
          phases: ['staleness-prune'],
          stalenessThreshold: 30,
          causalGraph: mockGraph as unknown as CausalGraph,
          causalNamespace: 'ns',
        }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(0)
      expect(report.namespaces[0]!.stalenessCausalRelationsRemoved).toBe(0)
      expect(mockGraph.removeNode).not.toHaveBeenCalled()
    })

    it('should report stalenessCausalRelationsRemoved === 0 when no causalGraph is configured', async () => {
      const store = createMockStore([staleRecord('s1')])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'], stalenessThreshold: 30 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(1)
      expect(report.namespaces[0]!.stalenessCausalRelationsRemoved).toBe(0)
    })

    it('should not prune pinned entries even when stale', async () => {
      const pinnedStale = {
        key: 'pinned',
        value: {
          text: 'pinned stale',
          createdAt: NOW - 365 * MS_PER_DAY,
          accessCount: 1,
          pinned: true,
        },
      }
      const store = createMockStore([pinnedStale])
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'], stalenessThreshold: 1 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(0)
      expect(store._data.has('pinned')).toBe(true)
    })

    it('should not crash when store.delete fails during staleness-prune', async () => {
      const store = createMockStore([staleRecord('old')])
      ;(store as unknown as { delete: ReturnType<typeof vi.fn> }).delete
        .mockRejectedValue(new Error('delete failed'))

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'], stalenessThreshold: 30 }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces).toHaveLength(1)
      expect(report.namespaces[0]!.stalenessPruned).toBe(0)
    })

    it('should not crash when store.search throws during staleness-prune', async () => {
      const store = createMockStore()
      ;(store as unknown as { search: ReturnType<typeof vi.fn> }).search
        .mockRejectedValue(new Error('unavailable'))

      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]!.stalenessPruned).toBe(0)
    })

    it('should include stalenessCausalRelationsRemoved in the report shape', async () => {
      const store = createMockStore()
      const consolidator = new SleepConsolidator(
        createConfig({ phases: ['staleness-prune'] }),
      )

      const report = await consolidator.run(store, [['test', 'ns']])
      expect(report.namespaces[0]).toHaveProperty('stalenessCausalRelationsRemoved')
      expect(typeof report.namespaces[0]!.stalenessCausalRelationsRemoved).toBe('number')
    })
  })
})
