import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryCacheBackend, type CacheBackend } from '@dzupagent/cache'
import {
  ReferenceTracker,
  InMemoryReferenceStore,
  RedisReferenceStore,
  deriveMemoryEntryId,
  type ReferenceStore,
  type ReferenceRecord,
} from '../reference-tracker.js'

// ---------------------------------------------------------------------------
// InMemoryReferenceStore
// ---------------------------------------------------------------------------

describe('InMemoryReferenceStore', () => {
  let store: InMemoryReferenceStore

  beforeEach(() => {
    store = new InMemoryReferenceStore()
  })

  it('records and returns a citation by run', async () => {
    await store.record({
      runId: 'run-1',
      memoryEntryId: 'mem-a',
      retrievedAt: 1000,
      retrievalContext: { query: 'hello', rank: 0 },
    })

    const refs = await store.listByRun('run-1')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      runId: 'run-1',
      memoryEntryId: 'mem-a',
      retrievedAt: 1000,
    })
    expect(refs[0]!.retrievalContext.query).toBe('hello')
  })

  it('records and returns a citation by entry', async () => {
    await store.record({
      runId: 'run-1',
      memoryEntryId: 'mem-a',
      retrievedAt: 1000,
      retrievalContext: {},
    })
    await store.record({
      runId: 'run-2',
      memoryEntryId: 'mem-a',
      retrievedAt: 2000,
      retrievalContext: {},
    })

    const runs = await store.listByEntry('mem-a')
    expect(runs).toHaveLength(2)
    // Most recent first
    expect(runs[0]!.runId).toBe('run-2')
    expect(runs[1]!.runId).toBe('run-1')
  })

  it('sorts results most-recent first', async () => {
    await store.record({ runId: 'r', memoryEntryId: 'a', retrievedAt: 100, retrievalContext: {} })
    await store.record({ runId: 'r', memoryEntryId: 'b', retrievedAt: 300, retrievalContext: {} })
    await store.record({ runId: 'r', memoryEntryId: 'c', retrievedAt: 200, retrievalContext: {} })

    const refs = await store.listByRun('r')
    expect(refs.map(x => x.memoryEntryId)).toEqual(['b', 'c', 'a'])
  })

  it('respects limit, sinceMs and untilMs', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.record({
        runId: 'r',
        memoryEntryId: `e${i}`,
        retrievedAt: i * 100,
        retrievalContext: {},
      })
    }

    const limited = await store.listByRun('r', { limit: 2 })
    expect(limited).toHaveLength(2)

    const windowed = await store.listByRun('r', { sinceMs: 200, untilMs: 400 })
    expect(windowed.map(x => x.memoryEntryId).sort()).toEqual(['e2', 'e3', 'e4'])
  })

  it('returns empty arrays for unknown run / entry', async () => {
    expect(await store.listByRun('nope')).toEqual([])
    expect(await store.listByEntry('nope')).toEqual([])
  })

  it('clearRun removes run and reverse index', async () => {
    await store.record({ runId: 'run-1', memoryEntryId: 'mem-a', retrievedAt: 1, retrievalContext: {} })
    await store.record({ runId: 'run-2', memoryEntryId: 'mem-a', retrievedAt: 2, retrievalContext: {} })
    await store.record({ runId: 'run-1', memoryEntryId: 'mem-b', retrievedAt: 3, retrievalContext: {} })

    await store.clearRun('run-1')

    expect(await store.listByRun('run-1')).toEqual([])
    expect(await store.listByEntry('mem-b')).toEqual([])

    const remaining = await store.listByEntry('mem-a')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.runId).toBe('run-2')
  })
})

// ---------------------------------------------------------------------------
// ReferenceTracker facade
// ---------------------------------------------------------------------------

describe('ReferenceTracker', () => {
  it('delegates to the store with clock-provided timestamps', async () => {
    const tracker = new ReferenceTracker({ now: () => 42 })
    await tracker.trackReference('run-x', 'mem-y', { query: 'q' })

    const refs = await tracker.getReferencesForRun('run-x')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.retrievedAt).toBe(42)
    expect(refs[0]!.retrievalContext.query).toBe('q')
  })

  it('getRunsCitingMemory returns bidirectional view', async () => {
    const tracker = new ReferenceTracker()
    await tracker.trackReference('run-1', 'mem-a')
    await tracker.trackReference('run-2', 'mem-a')

    const runs = await tracker.getRunsCitingMemory('mem-a')
    expect(runs.map(r => r.runId).sort()).toEqual(['run-1', 'run-2'])
  })

  it('trackReferences records a batch in one shot', async () => {
    const tracker = new ReferenceTracker({ now: () => 7 })
    await tracker.trackReferences('run-batch', [
      { entryId: 'a' },
      { entryId: 'b', ctx: { rank: 1 } },
      { entryId: '' }, // filtered out
    ])

    const refs = await tracker.getReferencesForRun('run-batch')
    expect(refs).toHaveLength(2)
    expect(refs.every(r => r.retrievedAt === 7)).toBe(true)
  })

  it('no-ops on empty runId or entryId', async () => {
    const tracker = new ReferenceTracker()
    await tracker.trackReference('', 'mem-a')
    await tracker.trackReference('run-1', '')
    await tracker.trackReferences('', [{ entryId: 'x' }])
    expect(await tracker.getReferencesForRun('run-1')).toEqual([])
  })

  it('swallows store errors and returns [] on query failures', async () => {
    const failingStore: ReferenceStore = {
      record: vi.fn().mockRejectedValue(new Error('boom')),
      listByRun: vi.fn().mockRejectedValue(new Error('boom')),
      listByEntry: vi.fn().mockRejectedValue(new Error('boom')),
      clearRun: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const onError = vi.fn()
    const tracker = new ReferenceTracker({ store: failingStore, onError })

    // None of these should throw
    await tracker.trackReference('r', 'e')
    await tracker.trackReferences('r', [{ entryId: 'e' }])
    expect(await tracker.getReferencesForRun('r')).toEqual([])
    expect(await tracker.getRunsCitingMemory('e')).toEqual([])
    await tracker.clearRun('r')

    expect(onError).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// deriveMemoryEntryId
// ---------------------------------------------------------------------------

describe('deriveMemoryEntryId', () => {
  it('prefers _key', () => {
    expect(deriveMemoryEntryId({ _key: 'k1', id: 'ignored' }, 0)).toBe('k1')
  })

  it('falls back to id', () => {
    expect(deriveMemoryEntryId({ id: 'i1' }, 0)).toBe('i1')
  })

  it('falls back to key', () => {
    expect(deriveMemoryEntryId({ key: 'k2' }, 0)).toBe('k2')
  })

  it('uses provenance contentHash when available', () => {
    const record = { _provenance: { contentHash: 'abc123' } }
    expect(deriveMemoryEntryId(record, 0)).toBe('hash:abc123')
  })

  it('falls back to idx:{rank}', () => {
    expect(deriveMemoryEntryId({ some: 'data' }, 5)).toBe('idx:5')
  })

  it('ignores empty string ids', () => {
    expect(deriveMemoryEntryId({ _key: '', id: '' }, 2)).toBe('idx:2')
  })
})

// ---------------------------------------------------------------------------
// RedisReferenceStore (backed by a CacheBackend)
// ---------------------------------------------------------------------------

describe('RedisReferenceStore', () => {
  it('writes to run sorted set, entry sorted set, and context value', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache, { prefix: 'test' })

    await store.record({
      runId: 'run-1',
      memoryEntryId: 'mem-a',
      retrievedAt: 5000,
      retrievalContext: { query: 'why' },
    })

    expect(await cache.zcard('test:run:run-1')).toBe(1)
    expect(await cache.zcard('test:entry:mem-a')).toBe(1)
    expect(await cache.zrangebyscore('test:run:run-1', 0, 10000)).toEqual(['mem-a@5000'])
    expect(await cache.zrangebyscore('test:entry:mem-a', 0, 10000)).toEqual(['run-1@5000'])

    const ctxRaw = await cache.get('test:ctx:run-1:mem-a@5000')
    expect(ctxRaw).not.toBeNull()
    expect(JSON.parse(ctxRaw!)).toEqual({ query: 'why' })
  })

  it('listByRun returns most-recent-first with context', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache, { prefix: 'test' })

    await store.record({ runId: 'r', memoryEntryId: 'a', retrievedAt: 100, retrievalContext: { rank: 0 } })
    await store.record({ runId: 'r', memoryEntryId: 'b', retrievedAt: 300, retrievalContext: { rank: 1 } })
    await store.record({ runId: 'r', memoryEntryId: 'c', retrievedAt: 200, retrievalContext: { rank: 2 } })

    const refs = await store.listByRun('r')
    expect(refs.map(x => x.memoryEntryId)).toEqual(['b', 'c', 'a'])
    expect(refs[0]!.retrievalContext.rank).toBe(1)
  })

  it('listByEntry returns most-recent-first', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache)

    await store.record({ runId: 'r1', memoryEntryId: 'mem', retrievedAt: 100, retrievalContext: {} })
    await store.record({ runId: 'r2', memoryEntryId: 'mem', retrievedAt: 200, retrievalContext: {} })

    const runs = await store.listByEntry('mem')
    expect(runs.map(r => r.runId)).toEqual(['r2', 'r1'])
  })

  it('applies sinceMs / untilMs window via zrangebyscore', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache)

    for (let i = 1; i <= 5; i++) {
      await store.record({ runId: 'r', memoryEntryId: `e${i}`, retrievedAt: i * 100, retrievalContext: {} })
    }

    const refs = await store.listByRun('r', { sinceMs: 200, untilMs: 400 })
    expect(refs.map(r => r.memoryEntryId).sort()).toEqual(['e2', 'e3', 'e4'])
  })

  it('parses invalid context JSON as {}', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache)

    await store.record({ runId: 'r', memoryEntryId: 'e', retrievedAt: 1, retrievalContext: { rank: 9 } })
    // Corrupt the context value
    await cache.set('dz:refs:ctx:r:e@1', '{not-json')

    const refs = await store.listByRun('r')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.retrievalContext).toEqual({})
  })

  it('swallows backend errors and invokes onError', async () => {
    const onError = vi.fn()
    const badCache: CacheBackend = {
      get: vi.fn().mockRejectedValue(new Error('nope')),
      set: vi.fn().mockRejectedValue(new Error('nope')),
      delete: vi.fn().mockRejectedValue(new Error('nope')),
      clear: vi.fn().mockRejectedValue(new Error('nope')),
      stats: vi.fn().mockResolvedValue({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      zadd: vi.fn().mockRejectedValue(new Error('nope')),
      zrangebyscore: vi.fn().mockRejectedValue(new Error('nope')),
      zrem: vi.fn().mockRejectedValue(new Error('nope')),
      zcard: vi.fn().mockResolvedValue(0),
    }
    const store = new RedisReferenceStore(badCache, { onError })

    await store.record({ runId: 'r', memoryEntryId: 'e', retrievedAt: 1, retrievalContext: {} })
    const refs = await store.listByRun('r')
    expect(refs).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('clearRun removes run sorted set, ctx values, and reverse-index entries', async () => {
    const cache = new InMemoryCacheBackend()
    const store = new RedisReferenceStore(cache, { prefix: 'test' })

    await store.record({ runId: 'r', memoryEntryId: 'a', retrievedAt: 1, retrievalContext: { rank: 0 } })
    await store.record({ runId: 'r', memoryEntryId: 'b', retrievedAt: 2, retrievalContext: { rank: 1 } })
    // A second run citing 'a' must survive clearRun('r')
    await store.record({ runId: 'r2', memoryEntryId: 'a', retrievedAt: 3, retrievalContext: { rank: 0 } })

    await store.clearRun('r')

    expect(await cache.zcard('test:run:r')).toBe(0)
    expect(await cache.get('test:ctx:r:a@1')).toBeNull()
    expect(await cache.get('test:ctx:r:b@2')).toBeNull()

    // Reverse index for 'a' should still hold r2 but not r
    const aMembers = await cache.zrangebyscore('test:entry:a', -Infinity, Infinity)
    expect(aMembers).toEqual(['r2@3'])
    // Reverse index for 'b' is now empty (or deleted)
    expect(await cache.zcard('test:entry:b')).toBe(0)

    // Run 'r2' is unaffected
    const r2Refs = await store.listByRun('r2')
    expect(r2Refs).toHaveLength(1)
    expect(r2Refs[0]!.memoryEntryId).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// End-to-end round trip
// ---------------------------------------------------------------------------

describe('ReferenceTracker end-to-end', () => {
  it('records from facade and reads back via both axes', async () => {
    const tracker = new ReferenceTracker({ now: () => 1000 })

    await tracker.trackReferences('run-A', [
      { entryId: 'doc-1', ctx: { namespace: 'lessons', rank: 0 } },
      { entryId: 'doc-2', ctx: { namespace: 'lessons', rank: 1 } },
    ])
    await tracker.trackReferences('run-B', [
      { entryId: 'doc-1', ctx: { namespace: 'lessons', rank: 0 } },
    ])

    const runA: ReferenceRecord[] = await tracker.getReferencesForRun('run-A')
    expect(runA).toHaveLength(2)

    const citers = await tracker.getRunsCitingMemory('doc-1')
    expect(citers.map(r => r.runId).sort()).toEqual(['run-A', 'run-B'])
  })
})
