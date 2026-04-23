import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  RedisReferenceTracker,
  createReferenceTracker,
  type RedisClientLike,
  type RedisPipelineLike,
} from '../provenance/redis-reference-tracker.js'
import { InMemoryReferenceTracker } from '../shared/reference-tracker.js'

// ---------------------------------------------------------------------------
// Mock Redis client — implements just enough of the ioredis surface to drive
// RedisReferenceTracker. Stores sets/hashes/TTLs in plain JS structures so
// tests can introspect internal state.
// ---------------------------------------------------------------------------

interface MockState {
  sets: Map<string, Set<string>>
  hashes: Map<string, Map<string, string>>
  ttls: Map<string, number>
  execCount: number
  pipelinedOps: string[][]
}

function createMockRedisClient(): {
  client: RedisClientLike
  state: MockState
  pipelineSpy: ReturnType<typeof vi.fn>
} {
  const state: MockState = {
    sets: new Map(),
    hashes: new Map(),
    ttls: new Map(),
    execCount: 0,
    pipelinedOps: [],
  }

  const sadd = (key: string, ...members: string[]): number => {
    const existing = state.sets.get(key) ?? new Set<string>()
    let added = 0
    for (const m of members) {
      if (!existing.has(m)) added++
      existing.add(m)
    }
    state.sets.set(key, existing)
    return added
  }

  const scard = (key: string): number => state.sets.get(key)?.size ?? 0

  const smembers = (key: string): string[] => [...(state.sets.get(key) ?? [])]

  const hget = (key: string, field: string): string | null =>
    state.hashes.get(key)?.get(field) ?? null

  const hset = (key: string, field: string, value: string): number => {
    const h = state.hashes.get(key) ?? new Map<string, string>()
    const isNew = !h.has(field) ? 1 : 0
    h.set(field, value)
    state.hashes.set(key, h)
    return isNew
  }

  const expire = (key: string, seconds: number): number => {
    state.ttls.set(key, seconds)
    return 1
  }

  const del = (...keys: string[]): number => {
    let n = 0
    for (const k of keys) {
      if (state.sets.delete(k) || state.hashes.delete(k)) n++
      state.ttls.delete(k)
    }
    return n
  }

  const pipelineSpy = vi.fn()

  const multi = (): RedisPipelineLike => {
    const ops: string[] = []
    const pipeline: RedisPipelineLike = {
      sadd: (key: string, ...members: string[]) => {
        ops.push(`sadd ${key} ${members.join(',')}`)
        sadd(key, ...members)
        return pipeline
      },
      hset: (key: string, field: string, value: string) => {
        ops.push(`hset ${key} ${field}=${value}`)
        hset(key, field, value)
        return pipeline
      },
      expire: (key: string, seconds: number) => {
        ops.push(`expire ${key} ${seconds}`)
        expire(key, seconds)
        return pipeline
      },
      exec: async () => {
        state.execCount++
        state.pipelinedOps.push(ops)
        pipelineSpy(ops)
        return []
      },
    }
    return pipeline
  }

  const client: RedisClientLike = {
    sadd: vi.fn(async (key, ...members) => sadd(key, ...members)),
    scard: vi.fn(async (key) => scard(key)),
    smembers: vi.fn(async (key) => smembers(key)),
    hget: vi.fn(async (key, field) => hget(key, field)),
    hset: vi.fn(async (key, field, value) => hset(key, field, value)),
    expire: vi.fn(async (key, seconds) => expire(key, seconds)),
    del: vi.fn(async (...keys) => del(...keys)),
    multi: vi.fn(() => multi()),
  }

  return { client, state, pipelineSpy }
}

// ---------------------------------------------------------------------------

describe('RedisReferenceTracker', () => {
  let mock: ReturnType<typeof createMockRedisClient>
  let tracker: RedisReferenceTracker

  beforeEach(() => {
    mock = createMockRedisClient()
    tracker = new RedisReferenceTracker({ client: mock.client, namespace: 'test' })
  })

  // --- basic trackReference ------------------------------------------------

  it('trackReference SADDs the runId into the per-entry runs set', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')

    expect(mock.state.sets.get('test:runs:entry-A')).toEqual(new Set(['run-1']))
  })

  it('multiple distinct runs increase scard', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')
    await tracker.trackReference('run-3', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 3 }])
  })

  it('duplicate (run, entry) pairs are deduplicated by SET semantics', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 1 }])
  })

  // --- threshold filtering --------------------------------------------------

  it('listEntriesAboveThreshold filters below-threshold entries', async () => {
    await tracker.trackReference('r1', 'hot', 'session')
    await tracker.trackReference('r2', 'hot', 'session')
    await tracker.trackReference('r3', 'hot', 'session')
    await tracker.trackReference('r1', 'cold', 'session')

    const above2 = await tracker.listEntriesAboveThreshold('session', 2)
    expect(above2).toEqual([{ entryId: 'hot', runCount: 3 }])
  })

  it('results are sorted by descending runCount', async () => {
    await tracker.trackReference('r1', 'low', 'session')

    await tracker.trackReference('r1', 'med', 'session')
    await tracker.trackReference('r2', 'med', 'session')

    await tracker.trackReference('r1', 'hot', 'session')
    await tracker.trackReference('r2', 'hot', 'session')
    await tracker.trackReference('r3', 'hot', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results.map((r) => r.entryId)).toEqual(['hot', 'med', 'low'])
  })

  it('namespace filter isolates entries by bucket', async () => {
    await tracker.trackReference('r1', 'entry-A', 'ns-A')
    await tracker.trackReference('r2', 'entry-A', 'ns-A')
    await tracker.trackReference('r1', 'entry-B', 'ns-B')
    await tracker.trackReference('r2', 'entry-B', 'ns-B')

    const nsA = await tracker.listEntriesAboveThreshold('ns-A', 1)
    const nsB = await tracker.listEntriesAboveThreshold('ns-B', 1)

    expect(nsA).toEqual([{ entryId: 'entry-A', runCount: 2 }])
    expect(nsB).toEqual([{ entryId: 'entry-B', runCount: 2 }])
  })

  it('undefined namespace returns entries across every namespace', async () => {
    await tracker.trackReference('r1', 'entry-A', 'ns-A')
    await tracker.trackReference('r1', 'entry-B', 'ns-B')
    await tracker.trackReference('r1', 'entry-C') // untagged

    const all = await tracker.listEntriesAboveThreshold(undefined, 1)
    expect(all.map((r) => r.entryId).sort()).toEqual(['entry-A', 'entry-B', 'entry-C'])
  })

  // --- edge cases -----------------------------------------------------------

  it('ignores empty runId or entryId', async () => {
    await tracker.trackReference('', 'entry-A', 'session')
    await tracker.trackReference('run-1', '', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
  })

  // --- TTL ------------------------------------------------------------------

  it('applies TTL to every touched key (default 7 days)', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')

    const sevenDays = 60 * 60 * 24 * 7
    expect(mock.state.ttls.get('test:runs:entry-A')).toBe(sevenDays)
    expect(mock.state.ttls.get('test:ns:session')).toBe(sevenDays)
    expect(mock.state.ttls.get('test:meta:entry-A')).toBe(sevenDays)
    expect(mock.state.ttls.get('test:all')).toBe(sevenDays)
  })

  it('applies a custom TTL from constructor options', async () => {
    const customTracker = new RedisReferenceTracker({
      client: mock.client,
      namespace: 'test',
      ttlSeconds: 60,
    })
    await customTracker.trackReference('run-1', 'entry-A', 'session')

    expect(mock.state.ttls.get('test:runs:entry-A')).toBe(60)
  })

  it('refreshes TTL on every subsequent trackReference (sliding window)', async () => {
    const customTracker = new RedisReferenceTracker({
      client: mock.client,
      namespace: 'test',
      ttlSeconds: 30,
    })
    await customTracker.trackReference('run-1', 'entry-A', 'session')
    // Simulate some time passing by overriding the TTL to a lower value.
    mock.state.ttls.set('test:runs:entry-A', 5)

    await customTracker.trackReference('run-2', 'entry-A', 'session')
    expect(mock.state.ttls.get('test:runs:entry-A')).toBe(30)
  })

  // --- pipeline batching ----------------------------------------------------

  it('batches each trackReference into a single MULTI/EXEC pipeline', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    expect(mock.state.execCount).toBe(1)

    await tracker.trackReference('run-2', 'entry-B', 'session')
    await tracker.trackReference('run-3', 'entry-C', 'session')
    expect(mock.state.execCount).toBe(3)
  })

  it('pipelines SADD + EXPIRE + HSET together in the same exec batch', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    const ops = mock.state.pipelinedOps[0]!

    // All three canonical writes must land in one pipeline.
    expect(ops.some((o) => o.startsWith('sadd test:runs:entry-A'))).toBe(true)
    expect(ops.some((o) => o.startsWith('sadd test:ns:session'))).toBe(true)
    expect(ops.some((o) => o.startsWith('hset test:meta:entry-A'))).toBe(true)
    expect(ops.filter((o) => o.startsWith('expire ')).length).toBeGreaterThanOrEqual(3)
  })

  // --- graceful failure -----------------------------------------------------

  it('never throws when the underlying Redis client fails', async () => {
    const brokenClient: RedisClientLike = {
      ...mock.client,
      multi: vi.fn(() => {
        throw new Error('redis exploded')
      }),
    }
    const onError = vi.fn()
    const broken = new RedisReferenceTracker({ client: brokenClient, onError })

    await expect(broken.trackReference('r', 'e', 'ns')).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })

  it('listEntriesAboveThreshold returns [] when Redis reads fail', async () => {
    const brokenClient: RedisClientLike = {
      ...mock.client,
      smembers: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const broken = new RedisReferenceTracker({ client: brokenClient, onError: () => {} })
    const results = await broken.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
  })

  // --- promoteEntry ---------------------------------------------------------

  it('promoteEntry resolves without side effects', async () => {
    await tracker.trackReference('r1', 'entry-A', 'session')
    await tracker.promoteEntry('entry-A', 'session', 'project')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 1 }])
  })
})

// ---------------------------------------------------------------------------
// createReferenceTracker factory
// ---------------------------------------------------------------------------

describe('createReferenceTracker', () => {
  const originalRedisUrl = process.env['REDIS_URL']

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env['REDIS_URL']
    else process.env['REDIS_URL'] = originalRedisUrl
  })

  it('returns an InMemoryReferenceTracker when neither REDIS_URL nor client is provided', async () => {
    delete process.env['REDIS_URL']
    const t = await createReferenceTracker()
    expect(t).toBeInstanceOf(InMemoryReferenceTracker)
  })

  it('returns a RedisReferenceTracker when an explicit client is provided', async () => {
    const { client } = createMockRedisClient()
    const t = await createReferenceTracker({ client })
    expect(t).toBeInstanceOf(RedisReferenceTracker)
  })

  it('prefers client over redisUrl when both are provided', async () => {
    const { client } = createMockRedisClient()
    const loader = vi.fn()
    const t = await createReferenceTracker({
      client,
      redisUrl: 'redis://unused:6379',
      loadIoredis: loader,
    })
    expect(t).toBeInstanceOf(RedisReferenceTracker)
    expect(loader).not.toHaveBeenCalled()
  })

  it('falls back to in-memory when the ioredis loader throws', async () => {
    const onError = vi.fn()
    const t = await createReferenceTracker({
      redisUrl: 'redis://nowhere:6379',
      loadIoredis: async () => {
        throw new Error('ioredis missing')
      },
      onError,
    })
    expect(t).toBeInstanceOf(InMemoryReferenceTracker)
    expect(onError).toHaveBeenCalledWith('createReferenceTracker', expect.any(Error))
  })

  it('uses the loader-provided ioredis constructor when available', async () => {
    const { client } = createMockRedisClient()
    const Ctor = vi.fn().mockImplementation(() => client)
    const t = await createReferenceTracker({
      redisUrl: 'redis://fake:6379',
      loadIoredis: async () => ({ default: Ctor as unknown as new (url: string) => RedisClientLike }),
    })
    expect(Ctor).toHaveBeenCalledWith('redis://fake:6379')
    expect(t).toBeInstanceOf(RedisReferenceTracker)
  })

  it('honours REDIS_URL from process.env when redisUrl is not passed', async () => {
    process.env['REDIS_URL'] = 'redis://env-host:6379'
    const { client } = createMockRedisClient()
    const Ctor = vi.fn().mockImplementation(() => client)
    const t = await createReferenceTracker({
      loadIoredis: async () => ({ default: Ctor as unknown as new (url: string) => RedisClientLike }),
    })
    expect(Ctor).toHaveBeenCalledWith('redis://env-host:6379')
    expect(t).toBeInstanceOf(RedisReferenceTracker)
  })
})
