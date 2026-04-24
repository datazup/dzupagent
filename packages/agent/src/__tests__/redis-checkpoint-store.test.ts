/**
 * Unit tests for RedisPipelineCheckpointStore.
 *
 * Uses an in-memory mock of the subset of Redis commands the store needs.
 * No live Redis required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  RedisPipelineCheckpointStore,
  type RedisClientLike,
} from '../pipeline/redis-checkpoint-store.js'
import type { PipelineCheckpoint } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// In-memory mock client
// ---------------------------------------------------------------------------

class MockRedis implements RedisClientLike {
  strings = new Map<string, string>()
  sortedSets = new Map<string, Map<string, number>>() // member -> score
  sets = new Map<string, Set<string>>()

  async set(key: string, value: string, ..._modifiers: Array<string | number>): Promise<'OK'> {
    this.strings.set(key, value)
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const k of keys) {
      if (this.strings.delete(k)) count++
      if (this.sortedSets.delete(k)) count++
      if (this.sets.delete(k)) count++
    }
    return count
  }

  async zadd(key: string, ...scoreMembers: Array<string | number>): Promise<number> {
    let zset = this.sortedSets.get(key)
    if (!zset) {
      zset = new Map()
      this.sortedSets.set(key, zset)
    }
    let added = 0
    for (let i = 0; i < scoreMembers.length; i += 2) {
      const score = Number(scoreMembers[i])
      const member = String(scoreMembers[i + 1])
      if (!zset.has(member)) added++
      zset.set(member, score)
    }
    return added
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key)
    if (!zset) return []
    const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end)
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key)
    if (!zset) return []
    const sorted = [...zset.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end)
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const zset = this.sortedSets.get(key)
    const score = zset?.get(member)
    return score === undefined ? null : String(score)
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.sortedSets.get(key)
    if (!zset) return 0
    let removed = 0
    for (const m of members) if (zset.delete(m)) removed++
    return removed
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key)
    if (!set) {
      set = new Set()
      this.sets.set(key, set)
    }
    let added = 0
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m)
        added++
      }
    }
    return added
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key)
    if (!set) return 0
    let removed = 0
    for (const m of members) if (set.delete(m)) removed++
    return removed
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key)
    return set ? [...set] : []
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sortedSets.has(key) || this.sets.has(key) ? 1 : 0
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    pipelineRunId: 'run-1',
    pipelineId: 'pipeline-1',
    version: 1,
    schemaVersion: '1.0.0',
    completedNodeIds: ['start'],
    state: { result: 'ok' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisPipelineCheckpointStore', () => {
  let client: MockRedis
  let store: RedisPipelineCheckpointStore

  beforeEach(() => {
    client = new MockRedis()
    store = new RedisPipelineCheckpointStore({ client })
  })

  it('save → load roundtrip returns the stored checkpoint', async () => {
    const cp = makeCheckpoint({ state: { foo: 'bar' } })
    await store.save(cp)
    const loaded = await store.load('run-1')
    expect(loaded).toBeDefined()
    expect(loaded!.state).toEqual({ foo: 'bar' })
    expect(loaded!.version).toBe(1)
  })

  it('load() returns the highest version', async () => {
    await store.save(makeCheckpoint({ version: 1, completedNodeIds: ['a'] }))
    await store.save(makeCheckpoint({ version: 3, completedNodeIds: ['a', 'b', 'c'] }))
    await store.save(makeCheckpoint({ version: 2, completedNodeIds: ['a', 'b'] }))

    const latest = await store.load('run-1')
    expect(latest!.version).toBe(3)
    expect(latest!.completedNodeIds).toEqual(['a', 'b', 'c'])
  })

  it('loadVersion() returns a specific version and undefined otherwise', async () => {
    await store.save(makeCheckpoint({ version: 1, state: { n: 1 } }))
    await store.save(makeCheckpoint({ version: 2, state: { n: 2 } }))

    const v2 = await store.loadVersion('run-1', 2)
    expect(v2!.state).toEqual({ n: 2 })

    const missing = await store.loadVersion('run-1', 99)
    expect(missing).toBeUndefined()
  })

  it('listVersions() returns all versions sorted ascending', async () => {
    await store.save(makeCheckpoint({ version: 3, createdAt: '2026-04-24T00:00:03Z' }))
    await store.save(makeCheckpoint({ version: 1, createdAt: '2026-04-24T00:00:01Z' }))
    await store.save(makeCheckpoint({ version: 2, createdAt: '2026-04-24T00:00:02Z' }))

    const versions = await store.listVersions('run-1')
    expect(versions.map(v => v.version)).toEqual([1, 2, 3])
  })

  it('delete() clears data, version index, and run index', async () => {
    await store.save(makeCheckpoint({ version: 1 }))
    await store.save(makeCheckpoint({ version: 2 }))

    await store.delete('run-1')

    expect(await store.load('run-1')).toBeUndefined()
    expect(await store.listVersions('run-1')).toEqual([])
    expect(client.strings.size).toBe(0)
    expect(client.sortedSets.size).toBe(0)
    expect(await client.smembers('checkpoint:runs')).toEqual([])
  })

  it('prune() drops entries older than the threshold', async () => {
    const old = new Date(Date.now() - 60_000).toISOString()
    const recent = new Date().toISOString()

    await store.save(makeCheckpoint({ pipelineRunId: 'old-run', version: 1, createdAt: old }))
    await store.save(makeCheckpoint({ pipelineRunId: 'old-run', version: 2, createdAt: old }))
    await store.save(makeCheckpoint({ pipelineRunId: 'new-run', version: 1, createdAt: recent }))

    const pruned = await store.prune(30_000)
    expect(pruned).toBe(2)

    expect(await store.load('old-run')).toBeUndefined()
    const newRun = await store.load('new-run')
    expect(newRun).toBeDefined()
    expect(newRun!.pipelineRunId).toBe('new-run')
  })

  it('loadVersion() self-heals when the underlying key has been TTL-evicted', async () => {
    await store.save(makeCheckpoint({ version: 1 }))

    // Simulate TTL eviction of the value while the version index remains.
    client.strings.delete('checkpoint:run-1:1')

    const loaded = await store.loadVersion('run-1', 1)
    expect(loaded).toBeUndefined()

    // The stale member should have been cleaned from the sorted set.
    const versions = await client.zrange('checkpoint:run-1:versions', 0, -1)
    expect(versions).toEqual([])
  })

  it('keyPrefix option namespaces all keys', async () => {
    const scoped = new RedisPipelineCheckpointStore({ client, keyPrefix: 'tenant-a:cp' })
    await scoped.save(makeCheckpoint({ version: 1 }))

    expect([...client.strings.keys()]).toContain('tenant-a:cp:run-1:1')
    expect([...client.sortedSets.keys()]).toContain('tenant-a:cp:run-1:versions')
    expect(await client.smembers('tenant-a:cp:runs')).toEqual(['run-1'])
  })
})
