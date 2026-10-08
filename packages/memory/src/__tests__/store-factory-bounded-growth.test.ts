/**
 * DZM-P3a — bounded growth for the in-memory store.
 *
 * The in-memory store used to keep every record until an explicit delete:
 * no cap, no expiry, and empty buckets were never removed. `maxRecords` and
 * `ttlMs` bound it, and evicted records must be physically gone (the
 * `size` count drops), not just hidden from reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { createStore } from '../store-factory.js'

interface RawInMemoryStore {
  readonly size: number
  search(
    namespace: string[],
  ): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>>
}

function raw(store: BaseStore): RawInMemoryStore {
  return store as unknown as RawInMemoryStore
}

async function keys(store: BaseStore, prefix: string[] = []): Promise<string[]> {
  return (await raw(store).search(prefix)).map(r => r.key).sort()
}

describe('InMemoryBaseStore maxRecords (DZM-P3a)', () => {
  it('evicts the least-recently-written record once the cap is exceeded', async () => {
    const store = await createStore({ type: 'memory', maxRecords: 2 })
    await store.put(['t1'], 'a', { text: 'a' })
    await store.put(['t2'], 'b', { text: 'b' })
    await store.put(['t1'], 'c', { text: 'c' })

    expect(raw(store).size).toBe(2)
    expect(await store.get(['t1'], 'a')).toBeUndefined()
    expect(await keys(store)).toEqual(['b', 'c'])
  })

  it('rewriting a key makes it the most recent and does not count twice', async () => {
    const store = await createStore({ type: 'memory', maxRecords: 2 })
    await store.put(['ns'], 'a', { text: 'a1' })
    await store.put(['ns'], 'b', { text: 'b' })
    await store.put(['ns'], 'a', { text: 'a2' })
    expect(raw(store).size).toBe(2)

    await store.put(['ns'], 'c', { text: 'c' })
    expect(await keys(store)).toEqual(['a', 'c'])
    expect((await store.get(['ns'], 'a'))?.value).toEqual({ text: 'a2' })
  })

  it('delete frees capacity', async () => {
    const store = await createStore({ type: 'memory', maxRecords: 2 })
    await store.put(['ns'], 'a', { text: 'a' })
    await store.put(['ns'], 'b', { text: 'b' })
    await store.delete(['ns'], 'a')
    await store.put(['ns'], 'c', { text: 'c' })

    expect(await keys(store)).toEqual(['b', 'c'])
  })

  it('removes a namespace once its last record is evicted', async () => {
    const store = await createStore({ type: 'memory', maxRecords: 1 })
    await store.put(['old'], 'a', { text: 'a' })
    await store.put(['new'], 'b', { text: 'b' })

    expect(await raw(store).search(['old'])).toEqual([])
    expect(raw(store).size).toBe(1)
  })
})

describe('InMemoryBaseStore ttlMs (DZM-P3a)', () => {
  let store: BaseStore

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    store = await createStore({ type: 'memory', ttlMs: 1_000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves a record before it expires', async () => {
    await store.put(['ns'], 'a', { text: 'a' })
    vi.advanceTimersByTime(999)
    expect((await store.get(['ns'], 'a'))?.value).toEqual({ text: 'a' })
  })

  it('hides and physically deletes an expired record on get', async () => {
    await store.put(['ns'], 'a', { text: 'a' })
    vi.advanceTimersByTime(1_000)

    expect(await store.get(['ns'], 'a')).toBeUndefined()
    expect(raw(store).size).toBe(0)
  })

  it('excludes expired records from search and deletes them', async () => {
    await store.put(['ns'], 'old', { text: 'old' })
    vi.advanceTimersByTime(600)
    await store.put(['ns'], 'fresh', { text: 'fresh' })
    vi.advanceTimersByTime(600)

    expect(await keys(store, ['ns'])).toEqual(['fresh'])
    expect(raw(store).size).toBe(1)
  })

  it('a put sweeps expired records in other namespaces', async () => {
    await store.put(['t1'], 'a', { text: 'a' })
    await store.put(['t2'], 'b', { text: 'b' })
    vi.advanceTimersByTime(1_500)
    await store.put(['t3'], 'c', { text: 'c' })

    expect(raw(store).size).toBe(1)
  })

  it('rewriting a key restarts its ttl but keeps createdAt', async () => {
    await store.put(['ns'], 'a', { text: 'a1' })
    const created = (await store.get(['ns'], 'a')) as { createdAt: Date } | undefined
    vi.advanceTimersByTime(800)
    await store.put(['ns'], 'a', { text: 'a2' })
    vi.advanceTimersByTime(800)

    const item = (await store.get(['ns'], 'a')) as
      | { value: Record<string, unknown>; createdAt: Date; updatedAt: Date }
      | undefined
    expect(item?.value).toEqual({ text: 'a2' })
    expect(item?.createdAt.getTime()).toBe(created?.createdAt.getTime())
    expect(item?.updatedAt.getTime()).toBe(1_000_800)
  })
})

describe('InMemoryBaseStore bounded-growth defaults and validation (DZM-P3a)', () => {
  it('keeps every record when neither option is set', async () => {
    const store = await createStore({ type: 'memory' })
    for (let i = 0; i < 50; i++) await store.put(['ns'], `k${i}`, { text: String(i) })
    expect(raw(store).size).toBe(50)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects maxRecords=%s', async (maxRecords) => {
    await expect(createStore({ type: 'memory', maxRecords })).rejects.toThrow(/maxRecords/)
  })

  it.each([0, -5, Number.POSITIVE_INFINITY, Number.NaN])('rejects ttlMs=%s', async (ttlMs) => {
    await expect(createStore({ type: 'memory', ttlMs })).rejects.toThrow(/ttlMs/)
  })

  it('rejects growth options for postgres instead of ignoring them', async () => {
    // Closed loopback port: if validation were missing, setup() fails fast
    // locally instead of reaching any real database.
    const connectionString = 'postgres://127.0.0.1:1/unused'
    await expect(
      createStore({ type: 'postgres', connectionString, maxRecords: 10 }),
    ).rejects.toThrow(/in-memory store/)
    await expect(
      createStore({ type: 'postgres', connectionString, ttlMs: 10 }),
    ).rejects.toThrow(/in-memory store/)
  })
})
