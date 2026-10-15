/**
 * Tests for `ConsolidationEngine` (MC-02).
 *
 * Uses the shared InMemoryStore double (DZUPAGENT-TEST-H-09), which honours
 * namespace-prefix search and the default limit like a real `BaseStore`.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  ConsolidationEngine,
  type ConsolidationStore,
} from '../consolidation-engine.js'
import { createStoreDouble } from './helpers/store-double.js'
import type { StoreDouble } from './helpers/store-double.js'

interface MockStore extends ConsolidationStore {
  double: StoreDouble
}

/**
 * Shared InMemoryStore double (DZUPAGENT-TEST-H-09): `search` honours the
 * namespace prefix and the default limit of 10, so records seeded under one
 * namespace are invisible to a consolidation of another. Fixtures are seeded
 * under the tuple the engine derives from `consolidate(scope, namespace)`.
 */
async function createMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
  namespace: string[] = ['teamX', 'session'],
): Promise<MockStore> {
  const double = createStoreDouble()
  for (const { key, value } of records) {
    await double.seed(namespace, key, value)
  }
  return Object.assign(double.store, { double }) as unknown as MockStore
}

describe('ConsolidationEngine', () => {
  it('consolidates 4 entries with same key prefix into 1 summary', async () => {
    const store = await createMockStore([
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
    expect(result.status).toBe('completed')
    expect(result.degradations).toEqual([])

    // Summary entry exists with joined text
    const summary = (await store.double.valueOf('task:__summary__'))
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
    const store = await createMockStore([
      { key: 'task:1', value: { text: 'one' } },
      { key: 'task:2', value: { text: 'two' } },
      { key: 'task:3', value: { text: 'three' } },
    ])

    const engine = new ConsolidationEngine()
    await engine.consolidate('teamX', 'session', store)

    for (const childKey of ['task:1', 'task:2', 'task:3']) {
      const child = (await store.double.valueOf(childKey))
      expect(child).toBeDefined()
      const decay = child!['_decay'] as Record<string, unknown>
      expect(decay).toBeDefined()
      expect(decay['strength']).toBe(0.1)
      expect(child!['consolidatedInto']).toBe('task:__summary__')
    }
  })

  it('returns correct provenance map across multiple clusters', async () => {
    const store = await createMockStore([
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
    expect((await store.double.valueOf('context:lonely'))).toBeDefined()
    expect((await store.double.valueOf('context:__summary__'))).toBeUndefined()
  })

  it('returns 0 summarised on an empty store', async () => {
    const store = await createMockStore()
    const engine = new ConsolidationEngine()
    const result = await engine.consolidate('teamX', 'empty', store)

    expect(result).toEqual({
      summarized: 0,
      summaries: [],
      provenance: {},
      durationMs: expect.any(Number) as unknown as number,
      status: 'completed',
      degradations: [],
    })
  })

  it('uses llmJudge when supplied', async () => {
    const store = await createMockStore([
      { key: 'task:a', value: { text: 'alpha' } },
      { key: 'task:b', value: { text: 'beta' } },
      { key: 'task:c', value: { text: 'gamma' } },
    ])
    const llmJudge = vi.fn(async () => 'LLM-derived summary text')
    const engine = new ConsolidationEngine({ llmJudge })

    await engine.consolidate('teamX', 'session', store)

    expect(llmJudge).toHaveBeenCalledTimes(1)
    const summary = (await store.double.valueOf('task:__summary__'))
    expect(summary!['text']).toBe('LLM-derived summary text')
  })

  it('falls back to join when llmJudge throws', async () => {
    const store = await createMockStore([
      { key: 'task:a', value: { text: 'alpha' } },
      { key: 'task:b', value: { text: 'beta' } },
      { key: 'task:c', value: { text: 'gamma' } },
    ])
    const engine = new ConsolidationEngine({
      llmJudge: () => Promise.reject(new Error('judge failed')),
    })

    const result = await engine.consolidate('teamX', 'session', store)
    expect(result.summarized).toBe(3)
    expect(result.status).toBe('degraded')
    expect(result.degradations).toEqual([
      {
        operation: 'summarize',
        impact: 'fallback-used',
        reason: 'backend-error',
        errorId: expect.any(String),
        target: 'task',
      },
    ])
    const summary = (await store.double.valueOf('task:__summary__'))
    expect(summary!['text']).toContain('alpha')
    expect(summary!['text']).toContain('gamma')
  })

  it('reports a partial result when a consolidated child cannot be marked', async () => {
    const store = await createMockStore([
      { key: 'task:a', value: { text: 'alpha' } },
      { key: 'task:b', value: { text: 'beta' } },
      { key: 'task:c', value: { text: 'gamma' } },
    ])
    ;(store.put as ReturnType<typeof vi.fn>).mockImplementation(
      async (namespace: string[], key: string, value: Record<string, unknown>) => {
        if (key === 'task:b') throw new Error('child update failed')
        await store.double.seed(namespace, key, value)
      },
    )

    const result = await new ConsolidationEngine().consolidate(
      'teamX',
      'session',
      store,
    )

    expect(result.summarized).toBe(3)
    expect(result.status).toBe('degraded')
    expect(result.degradations).toEqual([
      {
        operation: 'put',
        impact: 'partial-result',
        reason: 'backend-error',
        errorId: expect.any(String),
        target: 'task:b',
      },
    ])
  })

  it('skips already-written summary entries (idempotent)', async () => {
    const store = await createMockStore([
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

  it('merges a second run over disjoint children into the prior summary (AGENT-H-42)', async () => {
    const store = await createMockStore([
      { key: 'task:a', value: { text: 'first A' } },
      { key: 'task:b', value: { text: 'first B' } },
      { key: 'task:c', value: { text: 'first C' } },
    ])
    const engine = new ConsolidationEngine()
    await engine.consolidate('teamX', 'session', store)
    const firstSummary = await store.double.valueOf('task:__summary__')

    await store.double.seed(['teamX', 'session'], 'task:d', { text: 'second D' })
    await store.double.seed(['teamX', 'session'], 'task:e', { text: 'second E' })
    await store.double.seed(['teamX', 'session'], 'task:f', { text: 'second F' })
    const second = await engine.consolidate('teamX', 'session', store)

    expect(second.summaries).toEqual(['task:__summary__'])
    expect(second.provenance['task:__summary__']).toEqual(['task:d', 'task:e', 'task:f'])
    const summary = await store.double.valueOf('task:__summary__')
    expect(summary?.['consolidatedFrom']).toEqual([
      'task:a', 'task:b', 'task:c', 'task:d', 'task:e', 'task:f',
    ])
    const text = summary?.['text'] as string
    for (const part of ['first A', 'first B', 'first C', 'second D', 'second E', 'second F']) {
      expect(text).toContain(part)
    }
    expect(summary?.['createdAt']).toBe(firstSummary?.['createdAt'])
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
    expect(result.status).toBe('degraded')
    expect(result.degradations).toEqual([
      {
        operation: 'search',
        impact: 'source-unavailable',
        reason: 'backend-error',
        errorId: expect.any(String),
        target: 's/n',
      },
    ])
  })
})
