/**
 * Tests for `ConsolidationEngine` (MC-02).
 *
 * Uses a structurally-typed mock store mirroring `BaseStore`'s interface
 * — no LangGraph dependency required for these unit tests.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  ConsolidationEngine,
  type ConsolidationStore,
  type ConsolidationStoreItem,
} from '../consolidation-engine.js'

interface MockStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>
}

function createMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): MockStore {
  const data = new Map<string, Record<string, unknown>>()
  for (const { key, value } of records) {
    data.set(key, value)
  }
  return {
    data,
    search: vi.fn(async (_ns: string[]): Promise<ConsolidationStoreItem[]> => {
      return [...data.entries()].map(([key, value]) => ({ key, value }))
    }),
    put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
    }),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key)
    }),
  }
}

describe('ConsolidationEngine', () => {
  it('consolidates 4 entries with same key prefix into 1 summary', async () => {
    const store = createMockStore([
      { key: 'task:a', value: { text: 'task A done' } },
      { key: 'task:b', value: { text: 'task B done' } },
      { key: 'task:c', value: { text: 'task C done' } },
      { key: 'task:d', value: { text: 'task D done' } },
    ])

    const engine = new ConsolidationEngine()
    const result = await engine.consolidate('teamX', 'session', store)

    expect(result.summarized).toBe(4)
    expect(result.summaries).toEqual(['task:__summary__'])
    expect(result.provenance).toEqual({
      'task:__summary__': ['task:a', 'task:b', 'task:c', 'task:d'],
    })
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // Summary entry exists with joined text
    const summary = store.data.get('task:__summary__')
    expect(summary).toBeDefined()
    expect(summary!['kind']).toBe('summary')
    expect(typeof summary!['text']).toBe('string')
    expect(summary!['text']).toContain('task A done')
    expect(summary!['text']).toContain('task D done')
    expect(summary!['consolidatedFrom']).toEqual([
      'task:a',
      'task:b',
      'task:c',
      'task:d',
    ])
  })

  it('marks children with strength 0.1', async () => {
    const store = createMockStore([
      { key: 'task:1', value: { text: 'one' } },
      { key: 'task:2', value: { text: 'two' } },
      { key: 'task:3', value: { text: 'three' } },
    ])

    const engine = new ConsolidationEngine()
    await engine.consolidate('teamX', 'session', store)

    for (const childKey of ['task:1', 'task:2', 'task:3']) {
      const child = store.data.get(childKey)
      expect(child).toBeDefined()
      const decay = child!['_decay'] as Record<string, unknown>
      expect(decay).toBeDefined()
      expect(decay['strength']).toBe(0.1)
      expect(child!['consolidatedInto']).toBe('task:__summary__')
    }
  })

  it('returns correct provenance map across multiple clusters', async () => {
    const store = createMockStore([
      { key: 'task:a', value: { text: 'a' } },
      { key: 'task:b', value: { text: 'b' } },
      { key: 'task:c', value: { text: 'c' } },
      { key: 'result:1', value: { text: '1' } },
      { key: 'result:2', value: { text: '2' } },
      { key: 'result:3', value: { text: '3' } },
      { key: 'context:lonely', value: { text: 'lonely' } },
    ])

    const engine = new ConsolidationEngine()
    const result = await engine.consolidate('teamX', 'session', store)

    expect(result.summarized).toBe(6)
    expect(new Set(result.summaries)).toEqual(
      new Set(['task:__summary__', 'result:__summary__']),
    )
    expect(result.provenance['task:__summary__']).toEqual([
      'task:a',
      'task:b',
      'task:c',
    ])
    expect(result.provenance['result:__summary__']).toEqual([
      'result:1',
      'result:2',
      'result:3',
    ])
    // Lonely cluster (size 1) was not consolidated
    expect(store.data.get('context:lonely')).toBeDefined()
    expect(store.data.get('context:__summary__')).toBeUndefined()
  })

  it('returns 0 summarised on an empty store', async () => {
    const store = createMockStore()
    const engine = new ConsolidationEngine()
    const result = await engine.consolidate('teamX', 'empty', store)

    expect(result).toEqual({
      summarized: 0,
      summaries: [],
      provenance: {},
      durationMs: expect.any(Number) as unknown as number,
    })
  })

  it('uses llmJudge when supplied', async () => {
    const store = createMockStore([
      { key: 'task:a', value: { text: 'alpha' } },
      { key: 'task:b', value: { text: 'beta' } },
      { key: 'task:c', value: { text: 'gamma' } },
    ])
    const llmJudge = vi.fn(async () => 'LLM-derived summary text')
    const engine = new ConsolidationEngine({ llmJudge })

    await engine.consolidate('teamX', 'session', store)

    expect(llmJudge).toHaveBeenCalledTimes(1)
    const summary = store.data.get('task:__summary__')
    expect(summary!['text']).toBe('LLM-derived summary text')
  })

  it('falls back to join when llmJudge throws', async () => {
    const store = createMockStore([
      { key: 'task:a', value: { text: 'alpha' } },
      { key: 'task:b', value: { text: 'beta' } },
      { key: 'task:c', value: { text: 'gamma' } },
    ])
    const engine = new ConsolidationEngine({
      llmJudge: () => Promise.reject(new Error('judge failed')),
    })

    const result = await engine.consolidate('teamX', 'session', store)
    expect(result.summarized).toBe(3)
    const summary = store.data.get('task:__summary__')
    expect(summary!['text']).toContain('alpha')
    expect(summary!['text']).toContain('gamma')
  })

  it('skips already-written summary entries (idempotent)', async () => {
    const store = createMockStore([
      { key: 'task:a', value: { text: 'a' } },
      { key: 'task:b', value: { text: 'b' } },
      { key: 'task:c', value: { text: 'c' } },
    ])

    const engine = new ConsolidationEngine()
    await engine.consolidate('teamX', 'session', store)
    const second = await engine.consolidate('teamX', 'session', store)

    // Second pass should not re-summarise the existing summary entry.
    expect(second.summarized).toBe(0)
    expect(second.summaries).toEqual([])
  })

  it('returns a zero result when search throws', async () => {
    const store: ConsolidationStore = {
      search: () => Promise.reject(new Error('boom')),
      put: vi.fn(),
      delete: vi.fn(),
    }
    const engine = new ConsolidationEngine()
    const result = await engine.consolidate('s', 'n', store)
    expect(result.summarized).toBe(0)
    expect(result.summaries).toEqual([])
  })
})
