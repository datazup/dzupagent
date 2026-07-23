import { describe, expect, it, vi } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import type { NamespaceConfig } from '../memory-types.js'
import type { StagedRecord } from '../staged-writer.js'
import {
  MemoryServiceObservationCandidateStore,
  createObservationConfirmationReceipt,
} from '../observation-candidate-store.js'

const namespaces: NamespaceConfig[] = [
  {
    name: 'observation-candidates',
    scopeKeys: ['tenantId', 'workspaceId'],
    searchable: false,
  },
]

function createStore(options: { supportsDelete?: boolean } = {}) {
  const data = new Map<string, Record<string, unknown>>()
  const storageKey = (namespace: string[], key: string) =>
    `${namespace.join('/')}:${key}`
  const store: Record<string, unknown> = {
    put: vi.fn(async (
      namespace: string[],
      key: string,
      value: Record<string, unknown>,
    ) => {
      data.set(storageKey(namespace, key), value)
    }),
    get: vi.fn(async (namespace: string[], key: string) => {
      const value = data.get(storageKey(namespace, key))
      return value ? { key, value } : undefined
    }),
    search: vi.fn(async (namespace: string[]) => {
      const prefix = `${namespace.join('/')}:`
      return [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          key: key.slice(prefix.length),
          value,
        }))
    }),
  }
  if (options.supportsDelete !== false) {
    store['delete'] = vi.fn(async (namespace: string[], key: string) => {
      data.delete(storageKey(namespace, key))
    })
  }
  return {
    data,
    store: store as unknown as BaseStore,
  }
}

function candidate(
  key: string,
  overrides: Partial<StagedRecord> = {},
): StagedRecord {
  return {
    key,
    namespace: 'observations',
    scope: { tenantId: 't1', workspaceId: 'w1' },
    value: { text: `Observation ${key}` },
    stage: 'candidate',
    confidence: 0.85,
    createdAt: 1_000,
    promotedAt: 1_100,
    ...overrides,
  }
}

describe('MemoryServiceObservationCandidateStore', () => {
  it('persists candidates in a separate namespace and restores exact state', async () => {
    const { store } = createStore()
    const memory = new MemoryService(store, namespaces)
    const candidates = new MemoryServiceObservationCandidateStore(
      memory,
      'observation-candidates',
    )
    const record = candidate('c1')

    expect(await candidates.put(record)).toBe(true)

    const restored = await candidates.load('observations', record.scope)
    expect(restored).toEqual([record])
    expect(await candidates.load('other-target', record.scope)).toEqual([])
  })

  it('writes an idempotent confirmation receipt bound to candidate content', async () => {
    const { store } = createStore()
    const memory = new MemoryService(store, namespaces)
    const candidates = new MemoryServiceObservationCandidateStore(
      memory,
      'observation-candidates',
    )
    const record = candidate('c2')
    const receipt = createObservationConfirmationReceipt(record, 2_000)

    expect(await candidates.putReceipt(receipt)).toBe(true)
    expect(
      await candidates.getReceipt('observations', record.scope, record.key),
    ).toEqual(receipt)
    expect(
      await candidates.getReceipt('other-target', record.scope, record.key),
    ).toBeNull()
  })

  it('uses a tombstone when the backing store cannot delete', async () => {
    const { store } = createStore({ supportsDelete: false })
    const memory = new MemoryService(store, namespaces)
    const candidates = new MemoryServiceObservationCandidateStore(
      memory,
      'observation-candidates',
    )
    const record = candidate('c3')
    await candidates.put(record)

    expect(await candidates.remove(record)).toBe(true)
    expect(await candidates.load('observations', record.scope)).toEqual([])
  })

  it('prunes expired rejected records and bounds retained candidates', async () => {
    const { store } = createStore()
    const memory = new MemoryService(store, namespaces)
    const candidates = new MemoryServiceObservationCandidateStore(
      memory,
      'observation-candidates',
    )
    await candidates.put(candidate('old-rejected', {
      stage: 'rejected',
      createdAt: 100,
    }))
    await candidates.put(candidate('older-active', { createdAt: 800 }))
    await candidates.put(candidate('newer-active', { createdAt: 900 }))

    const removed = await candidates.prune(
      'observations',
      { tenantId: 't1', workspaceId: 'w1' },
      {
        now: () => 1_000,
        maxRecords: 1,
        maxAgeMs: 10_000,
        rejectedMaxAgeMs: 500,
      },
    )

    expect(removed).toBe(2)
    expect(
      await candidates.load(
        'observations',
        { tenantId: 't1', workspaceId: 'w1' },
      ),
    ).toEqual([expect.objectContaining({ key: 'newer-active' })])
  })
})
