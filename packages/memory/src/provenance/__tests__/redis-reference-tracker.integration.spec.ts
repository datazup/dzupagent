/**
 * Integration tests for RedisReferenceTracker — mock-based, no live Redis.
 *
 * These tests cover paths NOT addressed by the unit suite in
 * src/__tests__/redis-reference-tracker.test.ts:
 *
 *   1. Namespace re-tagging: stale bucket membership does not produce phantom
 *      results once the meta hash is updated to a different namespace.
 *   2. TTL-expiry simulation: when Redis returns an empty runs set (simulating
 *      expired keys), listEntriesAboveThreshold returns [] without throwing.
 *   3. hget failure during trackReference: the tracker recovers and still
 *      writes the pipeline.
 *   4. scard failure mid-read: swallowed cleanly, returns [].
 *   5. collectCandidateIds failure on the all-namespaces path (smembers of
 *      masterIndexKey): returns [] without propagating.
 *   6. Factory with the { Redis: Ctor } named-export shape.
 *   7. InMemoryReferenceTracker fallback: stores and retrieves values through
 *      the tracker contract, verifying the fallback is functional.
 *   8. onError receives the correct operation name string.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  RedisReferenceTracker,
  createReferenceTracker,
  type RedisClientLike,
  type RedisPipelineLike,
} from '../redis-reference-tracker.js'
import { InMemoryReferenceTracker } from '../../shared/reference-tracker.js'

// ---------------------------------------------------------------------------
// Shared mock factory — kept identical to the unit-test helper so both suites
// can be read independently. The mock applies operations to in-process JS data
// structures; no ioredis involved.
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

  return { client, state }
}

// ---------------------------------------------------------------------------
// 1. Namespace re-tagging — stale bucket exclusion
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — namespace re-tagging', () => {
  it('excludes an entry from its old namespace after it is re-tagged to a new one', async () => {
    const { client, state } = createMockRedisClient()
    const tracker = new RedisReferenceTracker({ client, namespace: 'rt' })

    // Track under ns-A first.
    await tracker.trackReference('run-1', 'entry-X', 'ns-A')
    await tracker.trackReference('run-2', 'entry-X', 'ns-A')

    // Re-tag to ns-B; subsequent trackReference updates the meta hash.
    await tracker.trackReference('run-3', 'entry-X', 'ns-B')

    // The meta hash now says ns-B. listEntriesAboveThreshold for ns-A re-reads
    // the meta hash per candidate and must skip entry-X.
    const nsAResults = await tracker.listEntriesAboveThreshold('ns-A', 1)
    expect(nsAResults).toEqual([])

    // Under ns-B it should appear with all 3 runs (ns-A bucket also has it,
    // and meta confirms ns-B, so the entry is counted once under ns-B).
    // Note: only the ns-B bucket is read when namespace='ns-B'. We verify the
    // meta-validation path by checking ns-A returns nothing.
    expect(state.hashes.get('rt:meta:entry-X')?.get('ns')).toBe('ns-B')
  })
})

// ---------------------------------------------------------------------------
// 2. TTL expiry simulation — empty runs set after key expiry
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — TTL-expiry simulation', () => {
  it('returns [] gracefully when the runs set is empty (simulates expired Redis key)', async () => {
    const { client, state } = createMockRedisClient()
    const tracker = new RedisReferenceTracker({ client, namespace: 'rt' })

    // Track an entry so it appears in the namespace index.
    await tracker.trackReference('run-1', 'entry-Y', 'session')

    // Simulate Redis TTL expiry: the runs set key is gone but the ns index
    // still lists entry-Y as a candidate.
    state.sets.delete('rt:runs:entry-Y')

    // listEntriesAboveThreshold must not throw; scard on a missing key → 0.
    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
  })

  it('returns [] gracefully when all candidates have scard 0 (min > 0)', async () => {
    const { client, state } = createMockRedisClient()
    const tracker = new RedisReferenceTracker({ client, namespace: 'rt' })

    await tracker.trackReference('run-1', 'entry-Z', 'session')

    // Remove ALL run sets, simulating mass expiry.
    for (const key of [...state.sets.keys()]) {
      if (key.includes(':runs:')) state.sets.delete(key)
    }

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. hget failure during trackReference — pipeline still fires
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — hget failure recovery', () => {
  it('proceeds with the pipeline write even when hget (namespace pre-read) throws', async () => {
    const { client, state } = createMockRedisClient()

    // Override hget to always throw.
    vi.spyOn(client, 'hget').mockRejectedValue(new Error('hget-timeout'))

    const errors: Array<{ op: string; err: unknown }> = []
    const tracker = new RedisReferenceTracker({
      client,
      namespace: 'rt',
      onError: (op, err) => errors.push({ op, err }),
    })

    // Must not throw.
    await expect(
      tracker.trackReference('run-1', 'entry-A', 'session'),
    ).resolves.toBeUndefined()

    // The pipeline should still have fired (exec was called once).
    expect(state.execCount).toBe(1)

    // onError was called for the hget failure.
    expect(errors.some(e => e.op === 'trackReference:hget')).toBe(true)

    // The runs set and namespace index were written via the pipeline.
    expect(state.sets.get('rt:runs:entry-A')).toBeDefined()
    expect(state.sets.get('rt:ns:session')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. scard failure mid-read
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — scard failure during read', () => {
  it('returns [] and calls onError when scard throws for a specific entry', async () => {
    const { client } = createMockRedisClient()

    vi.spyOn(client, 'scard').mockRejectedValue(new Error('scard-fail'))

    const onError = vi.fn()
    const tracker = new RedisReferenceTracker({ client, namespace: 'rt', onError })

    // Seed the namespace index directly so there is a candidate to read.
    await tracker.trackReference('run-1', 'entry-A', 'session')

    // Now reset scard to always throw.
    vi.spyOn(client, 'scard').mockRejectedValue(new Error('scard-fail'))

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
    expect(onError).toHaveBeenCalledWith(
      'listEntriesAboveThreshold',
      expect.any(Error),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. collectCandidateIds failure on the all-namespaces (master-index) path
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — master-index smembers failure', () => {
  it('returns [] and reports "collectCandidateIds" when smembers of the master index throws', async () => {
    const { client } = createMockRedisClient()

    // Make smembers always throw. trackReference does not call smembers, so
    // the first smembers hit is the listEntriesAboveThreshold → collectCandidateIds
    // call with namespace=undefined (master-index path).
    vi.spyOn(client, 'smembers').mockRejectedValue(new Error('smembers-fail'))

    const onError = vi.fn()
    const tracker = new RedisReferenceTracker({ client, namespace: 'rt', onError })

    // This triggers collectCandidateIds with namespace=undefined → smembers(masterKey).
    const results = await tracker.listEntriesAboveThreshold(undefined, 1)
    expect(results).toEqual([])

    // onError is called by collectCandidateIds with its own operation name.
    expect(onError).toHaveBeenCalledWith('collectCandidateIds', expect.any(Error))
  })
})

// ---------------------------------------------------------------------------
// 6. Factory — { Redis: Ctor } named-export shape
// ---------------------------------------------------------------------------

describe('createReferenceTracker — Redis named-export shape', () => {
  afterEach(() => {
    delete process.env['REDIS_URL']
  })

  it('constructs RedisReferenceTracker when loader returns { Redis: Ctor }', async () => {
    const { client } = createMockRedisClient()
    const Ctor = vi.fn().mockImplementation(() => client)

    const tracker = await createReferenceTracker({
      redisUrl: 'redis://fake:6379',
      loadIoredis: async () =>
        ({ Redis: Ctor } as unknown as {
          Redis: new (url: string) => RedisClientLike
        }),
    })

    expect(Ctor).toHaveBeenCalledWith('redis://fake:6379')
    expect(tracker).toBeInstanceOf(RedisReferenceTracker)
  })
})

// ---------------------------------------------------------------------------
// 7. InMemoryReferenceTracker fallback — functional end-to-end
// ---------------------------------------------------------------------------

describe('createReferenceTracker — InMemory fallback functional round-trip', () => {
  afterEach(() => {
    delete process.env['REDIS_URL']
  })

  it('returned InMemoryReferenceTracker correctly tracks and retrieves references', async () => {
    delete process.env['REDIS_URL']
    const tracker = await createReferenceTracker()

    expect(tracker).toBeInstanceOf(InMemoryReferenceTracker)

    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-B', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 2)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 2 }])
  })

  it('InMemory fallback deduplicates same (run, entry) pair', async () => {
    delete process.env['REDIS_URL']
    const tracker = await createReferenceTracker()

    await tracker.trackReference('run-1', 'entry-X', 'ns')
    await tracker.trackReference('run-1', 'entry-X', 'ns')
    await tracker.trackReference('run-1', 'entry-X', 'ns')

    const results = await tracker.listEntriesAboveThreshold('ns', 1)
    expect(results).toEqual([{ entryId: 'entry-X', runCount: 1 }])
  })
})

// ---------------------------------------------------------------------------
// 8. onError receives the correct operation-name string
// ---------------------------------------------------------------------------

describe('RedisReferenceTracker — onError operation names', () => {
  it('reports "trackReference" when multi() throws', async () => {
    const { client } = createMockRedisClient()
    vi.spyOn(client, 'multi').mockImplementation(() => {
      throw new Error('connection lost')
    })

    const errors: string[] = []
    const tracker = new RedisReferenceTracker({
      client,
      namespace: 'rt',
      onError: (op) => errors.push(op),
    })

    await tracker.trackReference('run-1', 'entry-A', 'session')

    expect(errors).toContain('trackReference')
  })

  it('reports "listEntriesAboveThreshold" when smembers throws for a namespace query', async () => {
    const { client } = createMockRedisClient()
    vi.spyOn(client, 'smembers').mockRejectedValue(new Error('smembers-fail'))

    const errors: string[] = []
    const tracker = new RedisReferenceTracker({
      client,
      namespace: 'rt',
      onError: (op) => errors.push(op),
    })

    await tracker.listEntriesAboveThreshold('session', 1)

    expect(errors).toContain('listEntriesAboveThreshold')
  })
})
