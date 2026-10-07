/**
 * DZM-P1 slice 1 — in-memory store namespace keying.
 *
 * The in-memory store used to key buckets by `namespace.join('.')` and match
 * search prefixes with `startsWith`, so a `['t1']` prefix also matched
 * `t10.*` buckets, and a segment containing `.` collided with (and was split
 * back into) a deeper namespace. Namespaces must compare segment-wise.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { createStore } from '../store-factory.js'

interface SearchableStore {
  search(
    namespace: string[],
    options?: { limit?: number },
  ): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>>
}

function search(store: BaseStore, prefix: string[]) {
  return (store as unknown as SearchableStore).search(prefix)
}

describe('InMemoryBaseStore namespace keying (DZM-P1)', () => {
  let store: BaseStore

  beforeEach(async () => {
    store = await createStore({ type: 'memory' })
  })

  it('a t1 prefix does not return t10 records', async () => {
    await store.put(['t1', 'facts'], 'k1', { text: 'tenant one' })
    await store.put(['t10', 'facts'], 'k10', { text: 'tenant ten' })

    const results = await search(store, ['t1'])
    expect(results.map(r => r.key)).toEqual(['k1'])
    expect(results[0]!.namespace).toEqual(['t1', 'facts'])
  })

  it('a partial last segment is not a prefix match', async () => {
    await store.put(['t1', 'factsheet'], 'k', { text: 'x' })
    expect(await search(store, ['t1', 'facts'])).toEqual([])
  })

  it('keeps a dotted segment distinct from a deeper namespace', async () => {
    await store.put(['a.b', 'c'], 'k', { text: 'dotted' })
    await store.put(['a', 'b', 'c'], 'k', { text: 'nested' })

    expect((await store.get(['a.b', 'c'], 'k'))?.value).toEqual({ text: 'dotted' })
    expect((await store.get(['a', 'b', 'c'], 'k'))?.value).toEqual({ text: 'nested' })

    await store.delete(['a', 'b', 'c'], 'k')
    expect(await store.get(['a', 'b', 'c'], 'k')).toBeUndefined()
    expect((await store.get(['a.b', 'c'], 'k'))?.value).toEqual({ text: 'dotted' })
  })

  it('round-trips a dotted segment through search', async () => {
    await store.put(['a.b', 'c'], 'k', { text: 'dotted' })

    const results = await search(store, ['a.b'])
    expect(results).toHaveLength(1)
    expect(results[0]!.namespace).toEqual(['a.b', 'c'])
    expect(await search(store, ['a'])).toEqual([])
  })

  it('an empty prefix still returns every namespace', async () => {
    await store.put(['t1'], 'a', { text: '1' })
    await store.put(['t10', 'x.y'], 'b', { text: '2' })

    const results = await search(store, [])
    expect(results.map(r => r.key).sort()).toEqual(['a', 'b'])
    expect(results.find(r => r.key === 'b')!.namespace).toEqual(['t10', 'x.y'])
  })
})
