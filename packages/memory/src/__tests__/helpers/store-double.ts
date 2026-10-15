/**
 * Shared BaseStore double for memory specs (DZUPAGENT-TEST-H-09).
 *
 * The per-file doubles this replaces took the namespace as an unused `_ns`
 * argument and returned every stored record when no limit was passed. A real
 * LangGraph store filters `search` by namespace prefix and applies a default
 * `limit` of 10, so namespace and result-count defects (AGENT-H-66 reflector
 * namespace, AGENT-H-40 unbounded search) were invisible to those specs by
 * construction.
 *
 * This double IS a LangGraph `InMemoryStore`; only its `put`/`search`/`get`/
 * `delete` methods are wrapped in pass-through spies so specs can still assert
 * calls or inject a failure with `mockRejectedValueOnce`. `seed` and `records`
 * go through the store's `batch` method, which is not spied, so fixture setup
 * never shows up as a call under test. Fidelity is pinned by
 * `store-double-parity.test.ts`.
 */
import { InMemoryStore } from '@langchain/langgraph'
import type { BaseStore } from '@langchain/langgraph'
import { vi } from 'vitest'

export interface StoreDoubleRecord {
  namespace: string[]
  key: string
  value: Record<string, unknown>
}

export interface StoreDouble {
  /** The store under test, typed as the `BaseStore` production code accepts. */
  store: BaseStore
  /** Pass-through spies on the store's own methods. */
  put: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
  /**
   * Write a fixture record without recording a `put` call. `createdAt`
   * backdates the stored item (a real store stamps it at write time).
   */
  seed(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: { createdAt?: Date },
  ): Promise<void>
  /** Every record under `namespacePrefix` (all namespaces when omitted), unpaginated. */
  records(namespacePrefix?: string[]): Promise<StoreDoubleRecord[]>
  /** The value stored under `key` (in any namespace under `namespacePrefix`), or undefined. */
  valueOf(key: string, namespacePrefix?: string[]): Promise<Record<string, unknown> | undefined>
  /** Merge `patch` into the stored value under `key` (fixture aging etc.) without recording a `put`. */
  update(key: string, patch: Record<string, unknown>): Promise<void>
}

/** Above any fixture size used in these specs; `records` is an inspection helper, not a search. */
const RECORDS_INSPECTION_LIMIT = 100_000

export function createStoreDouble(): StoreDouble {
  const backing = new InMemoryStore()
  const put = vi.spyOn(backing, 'put')
  const search = vi.spyOn(backing, 'search')
  const get = vi.spyOn(backing, 'get')
  const del = vi.spyOn(backing, 'delete')

  const seed = async (
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options: { createdAt?: Date } = {},
  ): Promise<void> => {
    await backing.batch([{ namespace, key, value }])
    if (options.createdAt !== undefined) {
      // InMemoryStore returns its stored item from a get and keeps createdAt
      // across later puts, so stamping it here backdates the record.
      const [item] = await backing.batch([{ namespace, key }])
      if (item) item.createdAt = options.createdAt
    }
  }

  const records = async (namespacePrefix: string[] = []): Promise<StoreDoubleRecord[]> => {
    const [items] = await backing.batch([{
      namespacePrefix,
      limit: RECORDS_INSPECTION_LIMIT,
      offset: 0,
    }])
    return (items ?? []).map(item => ({
      namespace: item.namespace,
      key: item.key,
      value: item.value as Record<string, unknown>,
    }))
  }

  const valueOf = async (key: string, namespacePrefix: string[] = []): Promise<Record<string, unknown> | undefined> =>
    (await records(namespacePrefix)).find(record => record.key === key)?.value

  const update = async (key: string, patch: Record<string, unknown>): Promise<void> => {
    const record = (await records()).find(candidate => candidate.key === key)
    if (record === undefined) throw new Error(`store double: no record under key ${key}`)
    await seed(record.namespace, key, { ...record.value, ...patch })
  }

  // eslint-disable-next-line no-restricted-syntax -- not a stateless double: `store` is a real InMemoryStore and records()/valueOf() read what it holds
  return {
    store: backing,
    put: put as unknown as ReturnType<typeof vi.fn>,
    search: search as unknown as ReturnType<typeof vi.fn>,
    get: get as unknown as ReturnType<typeof vi.fn>,
    del: del as unknown as ReturnType<typeof vi.fn>,
    seed,
    records,
    valueOf,
    update,
  }
}
