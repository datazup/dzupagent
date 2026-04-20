import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../../memory-service.js'
import { ReferenceTracker } from '../reference-tracker.js'

// ---------------------------------------------------------------------------
// Minimal in-memory BaseStore fake
// ---------------------------------------------------------------------------

class FakeStore {
  private readonly data = new Map<string, Map<string, Record<string, unknown>>>()

  private nsKey(ns: string[]): string {
    return ns.join('|')
  }

  async put(ns: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const k = this.nsKey(ns)
    const bucket = this.data.get(k) ?? new Map<string, Record<string, unknown>>()
    bucket.set(key, value)
    this.data.set(k, bucket)
  }

  async get(ns: string[], key: string): Promise<{ value: Record<string, unknown> } | null> {
    const bucket = this.data.get(this.nsKey(ns))
    const value = bucket?.get(key)
    return value ? { value } : null
  }

  async search(
    ns: string[],
    opts?: { query?: string; limit?: number },
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    const bucket = this.data.get(this.nsKey(ns))
    if (!bucket) return []
    const items = [...bucket.entries()].map(([key, value]) => ({ key, value }))
    if (opts?.query) {
      const q = opts.query.toLowerCase()
      const filtered = items.filter(i => {
        const text = typeof i.value['text'] === 'string' ? i.value['text'] : ''
        return text.toLowerCase().includes(q)
      })
      return opts.limit ? filtered.slice(0, opts.limit) : filtered
    }
    return opts?.limit ? items.slice(0, opts.limit) : items
  }

  async delete(ns: string[], key: string): Promise<void> {
    this.data.get(this.nsKey(ns))?.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryService reference-tracker integration', () => {
  let store: FakeStore
  let tracker: ReferenceTracker
  let service: MemoryService

  beforeEach(async () => {
    store = new FakeStore()
    tracker = new ReferenceTracker({ now: () => 12345 })
    service = new MemoryService(
      store as unknown as BaseStore,
      [
        { name: 'lessons', scopeKeys: ['tenant', 'kind'], searchable: true },
        { name: 'decisions', scopeKeys: ['tenant', 'kind'], searchable: false },
      ],
      { rejectUnsafe: false, referenceTracker: tracker },
    )

    await service.put('lessons', { tenant: 't1', kind: 'lessons' }, 'l1', { text: 'always prefer typed errors', _key: 'l1' })
    await service.put('lessons', { tenant: 't1', kind: 'lessons' }, 'l2', { text: 'memory writes must be non-fatal', _key: 'l2' })
    await service.put('decisions', { tenant: 't1', kind: 'decisions' }, 'd1', { note: 'chose Postgres', _key: 'd1' })
  })

  it('records a citation for each result returned by search()', async () => {
    const results = await service.search(
      'lessons',
      { tenant: 't1', kind: 'lessons' },
      'typed',
      5,
      { runId: 'run-search' },
    )

    expect(results.length).toBeGreaterThan(0)

    // Fire-and-forget: yield the microtask queue so tracker writes complete
    await new Promise(resolve => setImmediate(resolve))

    const refs = await tracker.getReferencesForRun('run-search')
    expect(refs.length).toBe(results.length)
    expect(refs[0]!.retrievalContext.namespace).toBe('lessons')
    expect(refs[0]!.retrievalContext.query).toBe('typed')
    expect(refs[0]!.retrievedAt).toBe(12345)
  })

  it('records citations for get() when readContext is provided', async () => {
    const results = await service.get(
      'decisions',
      { tenant: 't1', kind: 'decisions' },
      undefined,
      { runId: 'run-get' },
    )
    expect(results).toHaveLength(1)

    await new Promise(resolve => setImmediate(resolve))

    const refs = await tracker.getReferencesForRun('run-get')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.retrievalContext.namespace).toBe('decisions')
    expect(refs[0]!.retrievalContext.query).toBeUndefined()
  })

  it('records citations for get() with a specific key', async () => {
    await service.get('lessons', { tenant: 't1', kind: 'lessons' }, 'l1', { runId: 'run-key' })
    await new Promise(resolve => setImmediate(resolve))

    const refs = await tracker.getReferencesForRun('run-key')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.memoryEntryId).toBe('l1')
  })

  it('does not track when readContext is omitted', async () => {
    await service.search('lessons', { tenant: 't1', kind: 'lessons' }, 'typed', 5)
    await new Promise(resolve => setImmediate(resolve))

    // Nothing should have been recorded
    const refs = await tracker.getReferencesForRun('run-search')
    expect(refs).toEqual([])
  })

  it('does not track when no tracker is configured', async () => {
    const serviceNoTracker = new MemoryService(
      store as unknown as BaseStore,
      [{ name: 'lessons', scopeKeys: ['tenant', 'kind'], searchable: true }],
      { rejectUnsafe: false },
    )
    // Should complete without error even with readContext present
    const results = await serviceNoTracker.search(
      'lessons',
      { tenant: 't1', kind: 'lessons' },
      'typed',
      5,
      { runId: 'run-no-tracker' },
    )
    expect(results.length).toBeGreaterThan(0)
  })

  it('tracker errors do not break the search hot path', async () => {
    const brokenTracker = new ReferenceTracker({
      store: {
        record: () => Promise.reject(new Error('redis down')),
        listByRun: () => Promise.resolve([]),
        listByEntry: () => Promise.resolve([]),
        clearRun: () => Promise.resolve(),
      },
    })
    const svc = new MemoryService(
      store as unknown as BaseStore,
      [{ name: 'lessons', scopeKeys: ['tenant', 'kind'], searchable: true }],
      { rejectUnsafe: false, referenceTracker: brokenTracker },
    )

    const results = await svc.search(
      'lessons',
      { tenant: 't1', kind: 'lessons' },
      'typed',
      5,
      { runId: 'run-broken' },
    )
    expect(results.length).toBeGreaterThan(0)
  })

  it('bidirectional query: getRunsCitingMemory works across runs', async () => {
    await service.get('lessons', { tenant: 't1', kind: 'lessons' }, 'l1', { runId: 'run-A' })
    await service.get('lessons', { tenant: 't1', kind: 'lessons' }, 'l1', { runId: 'run-B' })
    await new Promise(resolve => setImmediate(resolve))

    const citers = await tracker.getRunsCitingMemory('l1')
    expect(citers.map(r => r.runId).sort()).toEqual(['run-A', 'run-B'])
  })

  it('records rank metadata for each returned entry', async () => {
    await service.search(
      'lessons',
      { tenant: 't1', kind: 'lessons' },
      'memory',
      5,
      { runId: 'run-rank' },
    )
    await new Promise(resolve => setImmediate(resolve))

    const refs = await tracker.getReferencesForRun('run-rank')
    const ranks = refs.map(r => r.retrievalContext.rank).sort()
    // Ranks are 0-indexed; we get one entry back (only l2 mentions "memory")
    expect(ranks).toEqual([0])
  })
})
