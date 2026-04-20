import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ReferenceTracker,
  InMemoryReferenceStore,
  RedisReferenceStore,
  deriveMemoryEntryId,
  type ReferenceStore,
  type ReferenceRecord,
  type SortedSetClientLike,
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
// RedisReferenceStore (mocked client)
// ---------------------------------------------------------------------------

function createMockRedisClient(): SortedSetClientLike & {
  zadds: Array<{ key: string; score: number; member: string }>
  hsets: Array<{ key: string; field: string; value: string }>
  dels: string[]
  sortedSets: Map<string, Map<string, number>>
  hashes: Map<string, Map<string, string>>
} {
  const sortedSets = new Map<string, Map<string, number>>()
  const hashes = new Map<string, Map<string, string>>()
  const zadds: Array<{ key: string; score: number; member: string }> = []
  const hsets: Array<{ key: string; field: string; value: string }> = []
  const dels: string[] = []

  return {
    sortedSets,
    hashes,
    zadds,
    hsets,
    dels,
    async zadd(key, score, member) {
      zadds.push({ key, score, member })
      const set = sortedSets.get(key) ?? new Map<string, number>()
      set.set(member, score)
      sortedSets.set(key, set)
      return 1
    },
    async zrange(key, start, stop, ...args) {
      const set = sortedSets.get(key) ?? new Map()
      const withScores = args.includes('WITHSCORES')
      const rev = args.includes('REV')
      const entries = [...set.entries()].sort((a, b) =>
        rev ? b[1] - a[1] : a[1] - b[1],
      )
      const effectiveStop = stop < 0 ? entries.length + stop : stop
      const slice = entries.slice(start, effectiveStop + 1)
      if (!withScores) return slice.map(([m]) => m)
      const out: string[] = []
      for (const [m, s] of slice) {
        out.push(m, String(s))
      }
      return out
    },
    async zrangebyscore(key, min, max, ...args) {
      const set = sortedSets.get(key) ?? new Map()
      const withScores = args.includes('WITHSCORES')
      const lo = min === '-inf' ? -Infinity : Number(min)
      const hi = max === '+inf' ? Infinity : Number(max)

      const limitIdx = args.indexOf('LIMIT')
      let offset = 0
      let count = Number.MAX_SAFE_INTEGER
      if (limitIdx >= 0) {
        offset = Number(args[limitIdx + 1] ?? 0)
        count = Number(args[limitIdx + 2] ?? Number.MAX_SAFE_INTEGER)
      }

      const entries = [...set.entries()]
        .filter(([, s]) => s >= lo && s <= hi)
        .sort((a, b) => a[1] - b[1])
        .slice(offset, offset + count)

      if (!withScores) return entries.map(([m]) => m)
      const out: string[] = []
      for (const [m, s] of entries) {
        out.push(m, String(s))
      }
      return out
    },
    async hset(key, field, value) {
      hsets.push({ key, field, value })
      const h = hashes.get(key) ?? new Map<string, string>()
      h.set(field, value)
      hashes.set(key, h)
      return 1
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hdel(key, ...fields) {
      const h = hashes.get(key)
      if (!h) return 0
      let n = 0
      for (const f of fields) {
        if (h.delete(f)) n++
      }
      return n
    },
    async del(...keys) {
      dels.push(...keys)
      let n = 0
      for (const k of keys) {
        if (sortedSets.delete(k)) n++
        if (hashes.delete(k)) n++
      }
      return n
    },
    async scan(cursor, ..._args) {
      return [String(cursor), []]
    },
  }
}

describe('RedisReferenceStore', () => {
  it('writes to run sorted set, entry sorted set, and context hash', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client, { prefix: 'test' })

    await store.record({
      runId: 'run-1',
      memoryEntryId: 'mem-a',
      retrievedAt: 5000,
      retrievalContext: { query: 'why' },
    })

    expect(client.zadds).toContainEqual({ key: 'test:run:run-1', score: 5000, member: 'mem-a' })
    expect(client.zadds).toContainEqual({ key: 'test:entry:mem-a', score: 5000, member: 'run-1' })
    expect(client.hsets).toHaveLength(1)
    expect(client.hsets[0]!.key).toBe('test:ctx:run-1')
    expect(client.hsets[0]!.field).toBe('mem-a@5000')
    expect(JSON.parse(client.hsets[0]!.value)).toEqual({ query: 'why' })
  })

  it('listByRun returns most-recent-first with context', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client, { prefix: 'test' })

    await store.record({ runId: 'r', memoryEntryId: 'a', retrievedAt: 100, retrievalContext: { rank: 0 } })
    await store.record({ runId: 'r', memoryEntryId: 'b', retrievedAt: 300, retrievalContext: { rank: 1 } })
    await store.record({ runId: 'r', memoryEntryId: 'c', retrievedAt: 200, retrievalContext: { rank: 2 } })

    const refs = await store.listByRun('r')
    expect(refs.map(x => x.memoryEntryId)).toEqual(['b', 'c', 'a'])
    expect(refs[0]!.retrievalContext.rank).toBe(1)
  })

  it('listByEntry returns most-recent-first', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client)

    await store.record({ runId: 'r1', memoryEntryId: 'mem', retrievedAt: 100, retrievalContext: {} })
    await store.record({ runId: 'r2', memoryEntryId: 'mem', retrievedAt: 200, retrievalContext: {} })

    const runs = await store.listByEntry('mem')
    expect(runs.map(r => r.runId)).toEqual(['r2', 'r1'])
  })

  it('applies sinceMs / untilMs window via zrangebyscore', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client)

    for (let i = 1; i <= 5; i++) {
      await store.record({ runId: 'r', memoryEntryId: `e${i}`, retrievedAt: i * 100, retrievalContext: {} })
    }

    const refs = await store.listByRun('r', { sinceMs: 200, untilMs: 400 })
    expect(refs.map(r => r.memoryEntryId).sort()).toEqual(['e2', 'e3', 'e4'])
  })

  it('parses invalid context JSON as {}', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client)

    await store.record({ runId: 'r', memoryEntryId: 'e', retrievedAt: 1, retrievalContext: { rank: 9 } })
    // Corrupt the context
    client.hashes.get('dz:refs:ctx:r')!.set('e@1', '{not-json')

    const refs = await store.listByRun('r')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.retrievalContext).toEqual({})
  })

  it('swallows client errors and invokes onError', async () => {
    const onError = vi.fn()
    const badClient: SortedSetClientLike = {
      zadd: vi.fn().mockRejectedValue(new Error('nope')),
      zrange: vi.fn().mockRejectedValue(new Error('nope')),
      zrangebyscore: vi.fn().mockRejectedValue(new Error('nope')),
      hset: vi.fn().mockRejectedValue(new Error('nope')),
      hget: vi.fn().mockRejectedValue(new Error('nope')),
      hdel: vi.fn().mockRejectedValue(new Error('nope')),
      del: vi.fn().mockRejectedValue(new Error('nope')),
      scan: vi.fn().mockRejectedValue(new Error('nope')),
    }
    const store = new RedisReferenceStore(badClient, { onError })

    await store.record({ runId: 'r', memoryEntryId: 'e', retrievedAt: 1, retrievalContext: {} })
    const refs = await store.listByRun('r')
    expect(refs).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('clearRun deletes the run and context keys', async () => {
    const client = createMockRedisClient()
    const store = new RedisReferenceStore(client, { prefix: 'test' })

    await store.record({ runId: 'r', memoryEntryId: 'a', retrievedAt: 1, retrievalContext: {} })
    await store.clearRun('r')

    expect(client.dels).toContain('test:run:r')
    expect(client.dels).toContain('test:ctx:r')
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
