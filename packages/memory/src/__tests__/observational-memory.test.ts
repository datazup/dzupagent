import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObservationalMemory } from '../observational-memory.js'
import type { ObservationalMemoryConfig } from '../observational-memory.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'
import type { MemoryService } from '../memory-service.js'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'

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
    search: vi.fn().mockImplementation((_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }))
      return Promise.resolve(items.slice(0, opts?.limit ?? items.length))
    }),
    put: vi.fn().mockImplementation((_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
      return Promise.resolve()
    }),
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

function createMockModel(responses: string[]) {
  let callIndex = 0
  const invoke = vi.fn().mockImplementation(() => {
    const idx = callIndex++
    const content = idx < responses.length ? responses[idx] : '[]'
    return Promise.resolve({ content })
  })

  return { invoke } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function createMockMemoryService(
  existingRecords: Record<string, unknown>[] = [],
): MemoryService & {
  put: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  formatForPrompt: ReturnType<typeof vi.fn>
} {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(existingRecords),
    search: vi.fn().mockResolvedValue(existingRecords),
    formatForPrompt: vi.fn().mockReturnValue('## Relevant Observations\n\nSome observation'),
  } as unknown as MemoryService & {
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    formatForPrompt: ReturnType<typeof vi.fn>
  }
}

function makeMessages(count: number): BaseMessage[] {
  const msgs: BaseMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(i % 2 === 0
      ? new HumanMessage(`Message ${i}`)
      : new AIMessage(`Response ${i}`),
    )
  }
  return msgs
}

/** LLM response that returns observations as JSON */
function observationResponse(observations: Array<{ text: string; category: string; confidence: number }>): string {
  return JSON.stringify(observations)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObservationalMemory', () => {
  let model: BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
  let memoryService: ReturnType<typeof createMockMemoryService>
  let store: ReturnType<typeof createMockStore>
  let sut: ObservationalMemory

  const defaultScope = { tenantId: 't1', observations: 'obs' }

  function createOM(overrides?: Partial<ObservationalMemoryConfig>): ObservationalMemory {
    return new ObservationalMemory({
      model,
      memoryService: memoryService as unknown as MemoryService,
      store,
      namespace: 'observations',
      scope: defaultScope,
      observerDebounceMs: 0, // disable debounce by default in tests
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    model = createMockModel([
      observationResponse([
        { text: 'User prefers dark mode', category: 'preference', confidence: 0.9 },
        { text: 'Project uses TypeScript', category: 'fact', confidence: 0.95 },
      ]),
    ])
    memoryService = createMockMemoryService()
    store = createMockStore()
    sut = createOM()
  })

  // -----------------------------------------------------------------------
  // observe() — threshold gating
  // -----------------------------------------------------------------------

  describe('observe()', () => {
    it('should return null when message count is below observerThreshold', async () => {
      sut = createOM({ observerThreshold: 10 })
      const messages = makeMessages(5)
      const result = await sut.observe(messages)
      expect(result).toBeNull()
    })

    it('should return null when exactly at threshold minus one (accumulates across calls)', async () => {
      sut = createOM({ observerThreshold: 10 })
      // First call with 4 messages
      const result1 = await sut.observe(makeMessages(4))
      expect(result1).toBeNull()
      // Second call with 5 messages (total = 9, still below 10)
      const result2 = await sut.observe(makeMessages(5))
      expect(result2).toBeNull()
    })

    it('should extract and store observations when threshold is reached', async () => {
      sut = createOM({ observerThreshold: 5 })
      const messages = makeMessages(6)
      const result = await sut.observe(messages)

      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBeGreaterThan(0)
      expect(memoryService.put).toHaveBeenCalled()
    })

    it('should accumulate message count across multiple observe() calls', async () => {
      sut = createOM({ observerThreshold: 10 })
      // First call: 6 messages (below 10)
      await sut.observe(makeMessages(6))
      // Second call: 5 messages (total 11, above 10)
      const result = await sut.observe(makeMessages(5))
      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBeGreaterThan(0)
    })

    it('should reset messagesSinceLastRun after a successful run', async () => {
      sut = createOM({ observerThreshold: 3 })
      // First run succeeds
      const result1 = await sut.observe(makeMessages(4))
      expect(result1).not.toBeNull()

      // Second call with just 2 messages (below threshold after reset)
      const result2 = await sut.observe(makeMessages(2))
      expect(result2).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // observe() — deduplication
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('should skip observations similar to existing memory (Jaccard > 0.7)', async () => {
      // Existing memory has a very similar observation
      memoryService = createMockMemoryService([
        { text: 'User prefers dark mode' },
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.skippedDuplicates).toBeGreaterThan(0)
      // "User prefers dark mode" should be skipped, "Project uses TypeScript" should be kept
      const addedTexts = result!.extracted.map(o => o.text)
      expect(addedTexts).not.toContain('User prefers dark mode')
    })

    it('should keep observations that are sufficiently different from existing', async () => {
      // Existing memory has something completely different
      memoryService = createMockMemoryService([
        { text: 'Codebase uses Python with Flask framework' },
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBe(2)
      expect(result!.skippedDuplicates).toBe(0)
    })

    it('should deduplicate within the same extraction batch', async () => {
      // Model returns two nearly identical observations (same words, slightly reordered)
      model = createMockModel([
        observationResponse([
          { text: 'the user prefers dark mode for the UI', category: 'preference', confidence: 0.9 },
          { text: 'the user prefers dark mode for UI', category: 'preference', confidence: 0.85 },
          { text: 'Project uses Rust programming language', category: 'fact', confidence: 0.95 },
        ]),
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      // The second observation has high Jaccard overlap with the first => skipped
      expect(result!.skippedDuplicates).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // observe() — reflector trigger
  // -----------------------------------------------------------------------

  describe('reflector trigger', () => {
    it('should trigger reflector when observation count exceeds reflectorThreshold', async () => {
      // Set very low thresholds for testing
      sut = createOM({
        observerThreshold: 1,
        reflectorThreshold: 1, // trigger after just 1 observation
      })

      // Mock memory service to return enough records for reflector
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
        { text: 'obs2', confidence: 0.8 },
      ])

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.triggeredReflector).toBe(true)
    })

    it('should not trigger reflector when below reflectorThreshold', async () => {
      sut = createOM({
        observerThreshold: 1,
        reflectorThreshold: 1000, // very high threshold
      })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.triggeredReflector).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // reflect()
  // -----------------------------------------------------------------------

  describe('reflect()', () => {
    it('should run SemanticConsolidator via reflect()', async () => {
      // Provide records so the reflector has something to work with
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
        { text: 'obs2', confidence: 0.8 },
      ])

      // The consolidator will call model.invoke
      model = createMockModel([
        JSON.stringify({ action: 'noop', reason: 'unique' }),
        JSON.stringify({ action: 'noop', reason: 'unique' }),
      ])
      sut = createOM()

      const result = await sut.reflect()

      expect(result.before).toBe(2)
      expect(result).toHaveProperty('after')
      expect(result).toHaveProperty('merged')
      expect(result).toHaveProperty('pruned')
      expect(result).toHaveProperty('llmCallsUsed')
    })

    it('should return zeroes when no observations exist', async () => {
      memoryService.get.mockResolvedValue([])
      sut = createOM()

      const result = await sut.reflect()

      expect(result).toEqual({ before: 0, after: 0, merged: 0, pruned: 0, llmCallsUsed: 0 })
    })

    it('should prune low-confidence entries when over reflectorTargetCount', async () => {
      // Create more records than the target count
      const records = Array.from({ length: 10 }, (_, i) => ({
        text: `observation ${i}`,
        confidence: i * 0.1, // 0.0, 0.1, 0.2, ... 0.9
      }))
      memoryService.get
        .mockResolvedValueOnce(records)     // first call: before count
        .mockResolvedValueOnce(records)     // second call: after consolidation
        .mockResolvedValueOnce(records.slice(5)) // third call: after pruning

      // Store also returns records for the pruning step
      store = createMockStore(
        records.map((r, i) => ({
          key: `obs-${i}`,
          value: r as unknown as Record<string, unknown>,
        })),
      )

      sut = createOM({
        reflectorTargetCount: 5,
      })

      const result = await sut.reflect()

      expect(result.before).toBe(10)
      expect(store.delete).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    it('should track observerRuns after observe()', async () => {
      sut = createOM({ observerThreshold: 1 })
      await sut.observe(makeMessages(2))

      const stats = sut.getStats()
      expect(stats.observerRuns).toBe(1)
      expect(stats.lastObserverRun).toBeTypeOf('number')
      expect(stats.totalObservations).toBeGreaterThan(0)
    })

    it('should track reflectorRuns after reflect()', async () => {
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
      ])
      sut = createOM()
      await sut.reflect()

      const stats = sut.getStats()
      expect(stats.reflectorRuns).toBe(1)
      expect(stats.lastReflectorRun).toBeTypeOf('number')
    })

    it('should return a copy (not a reference) of stats', () => {
      const stats1 = sut.getStats()
      const stats2 = sut.getStats()
      expect(stats1).toEqual(stats2)
      expect(stats1).not.toBe(stats2)
    })

    it('should start with zeroed stats', () => {
      const stats = sut.getStats()
      expect(stats).toEqual({
        totalObservations: 0,
        observerRuns: 0,
        reflectorRuns: 0,
        lastObserverRun: null,
        lastReflectorRun: null,
      })
    })
  })

  // -----------------------------------------------------------------------
  // getRelevantObservations()
  // -----------------------------------------------------------------------

  describe('getRelevantObservations()', () => {
    it('should search and format results as a string', async () => {
      memoryService.search.mockResolvedValue([
        { text: 'User prefers dark mode' },
      ])

      const result = await sut.getRelevantObservations('preferences', 3)

      expect(memoryService.search).toHaveBeenCalledWith(
        'observations',
        defaultScope,
        'preferences',
        3,
      )
      expect(result).toContain('Observations')
    })

    it('should return empty string when no results found', async () => {
      memoryService.search.mockResolvedValue([])

      const result = await sut.getRelevantObservations('nonexistent')
      expect(result).toBe('')
    })

    it('should return empty string on search error', async () => {
      memoryService.search.mockRejectedValue(new Error('search failed'))

      const result = await sut.getRelevantObservations('anything')
      expect(result).toBe('')
    })
  })

  // -----------------------------------------------------------------------
  // reset()
  // -----------------------------------------------------------------------

  describe('reset()', () => {
    it('should clear all counters and timestamps', async () => {
      sut = createOM({ observerThreshold: 1 })
      await sut.observe(makeMessages(2))

      // Verify stats are non-zero
      expect(sut.getStats().observerRuns).toBe(1)

      sut.reset()

      const stats = sut.getStats()
      expect(stats).toEqual({
        totalObservations: 0,
        observerRuns: 0,
        reflectorRuns: 0,
        lastObserverRun: null,
        lastReflectorRun: null,
      })
    })

    it('should reset messagesSinceLastRun so observe() requires fresh messages', async () => {
      sut = createOM({ observerThreshold: 5 })
      // Add 4 messages (below threshold)
      await sut.observe(makeMessages(4))

      // Reset clears the accumulated count
      sut.reset()

      // Now 4 messages again should still be below threshold
      const result = await sut.observe(makeMessages(4))
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Debounce
  // -----------------------------------------------------------------------

  describe('debounce', () => {
    it('should return null if called within observerDebounceMs', async () => {
      sut = createOM({
        observerThreshold: 1,
        observerDebounceMs: 60_000, // 1 minute
      })

      // First call succeeds
      const result1 = await sut.observe(makeMessages(2))
      expect(result1).not.toBeNull()

      // Second call within debounce window returns null
      const result2 = await sut.observe(makeMessages(2))
      expect(result2).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Non-fatal error handling
  // -----------------------------------------------------------------------

  describe('non-fatal error handling', () => {
    it('should return empty extracted array when LLM extraction fails', async () => {
      // ObservationExtractor.extract() catches LLM errors internally and returns []
      // So runObserver completes but with no observations extracted
      model = {
        invoke: vi.fn().mockRejectedValue(new Error('LLM down')),
      } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))
      expect(result).not.toBeNull()
      expect(result!.extracted).toEqual([])
      expect(result!.skippedDuplicates).toBe(0)
    })

    it('should return null when memoryService.get throws during observe', async () => {
      model = createMockModel([
        observationResponse([
          { text: 'Some observation', category: 'fact', confidence: 0.9 },
        ]),
      ])
      memoryService.get.mockRejectedValue(new Error('store connection lost'))
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))
      // runObserver calls memoryService.get for dedup — error is caught by observe()'s try/catch
      expect(result).toBeNull()
    })

    it('should not crash when memoryService.put throws during observe', async () => {
      memoryService.put.mockRejectedValue(new Error('write failed'))
      sut = createOM({ observerThreshold: 1 })

      // This should not throw — the outer try/catch in observe() handles it
      const result = await sut.observe(makeMessages(2))
      // It either returns null (caught) or partial result
      // The key assertion is no uncaught exception
      expect(true).toBe(true)
    })

    it('should return empty array from getObservations() on error', async () => {
      memoryService.get.mockRejectedValue(new Error('broken'))
      const result = await sut.getObservations()
      expect(result).toEqual([])
    })
  })
})
