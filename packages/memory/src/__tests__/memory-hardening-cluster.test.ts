/**
 * Regression cover for the memory hardening cluster:
 *
 * - SHARED-KIT-AGENT-M-71 — a service built by a factory must be closable.
 * - SHARED-KIT-AGENT-M-72 — the read path consults the vector index only for
 *   namespaces the write path indexes into (`searchable: true`).
 * - SHARED-KIT-SEC-L-31  — a vector-channel failure degrades to keyword-only
 *   *loudly*: it is logged with its error class and emitted on the event bus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryService } from '../memory-service.js'
import { createStore, closeMemoryStore } from '../store-factory.js'
import { searchMemoryWithStatus } from '../memory-service-search.js'
import type { NamespaceConfig, SemanticStoreAdapter } from '../memory-types.js'
import type { MemoryEventBus } from '../memory-service-types.js'

const SEARCHABLE: NamespaceConfig = {
  name: 'lessons',
  scopeKeys: ['tenantId'],
  searchable: true,
}
const NOT_SEARCHABLE: NamespaceConfig = {
  name: 'decisions',
  scopeKeys: ['tenantId'],
  searchable: false,
}
const SCOPE = { tenantId: 't1' }

function recordingEventBus(): MemoryEventBus & {
  events: Array<{ type: string } & Record<string, unknown>>
} {
  const events: Array<{ type: string } & Record<string, unknown>> = []
  return { events, emit: (e) => void events.push(e) }
}

/** A semantic store whose every method is observable and individually riggable. */
function stubSemanticStore(
  overrides: Partial<SemanticStoreAdapter> = {},
): SemanticStoreAdapter & { search: ReturnType<typeof vi.fn> } {
  const search = vi.fn().mockResolvedValue([])
  return {
    search,
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SemanticStoreAdapter & { search: ReturnType<typeof vi.fn> }
}

describe('AGENT-M-71 — store and service lifecycle', () => {
  it('closeMemoryStore calls the store’s own shutdown method', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    expect(await closeMemoryStore({ stop })).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('prefers stop() over the other shutdown aliases', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    const end = vi.fn()
    await closeMemoryStore({ stop, close, end })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('falls through the alias chain to end()', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    expect(await closeMemoryStore({ end })).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('supports Symbol.asyncDispose-only stores', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    expect(await closeMemoryStore({ [Symbol.asyncDispose]: dispose })).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('reports false — not an exception — for a store with no lifecycle', async () => {
    expect(await closeMemoryStore({})).toBe(false)
    expect(await closeMemoryStore(undefined)).toBe(false)
    expect(await closeMemoryStore('not a store')).toBe(false)
  })

  it('never propagates a shutdown error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const stop = vi.fn().mockRejectedValue(new Error('pool already ended'))
      await expect(closeMemoryStore({ stop })).resolves.toBe(false)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('MemoryService.close() closes both the semantic store and the record store', async () => {
    const store = await createStore({ type: 'memory' })
    const storeStop = vi.fn().mockResolvedValue(undefined)
    ;(store as unknown as Record<string, unknown>)['stop'] = storeStop
    const semanticStop = vi.fn().mockResolvedValue(undefined)
    const semanticStore = stubSemanticStore()
    ;(semanticStore as unknown as Record<string, unknown>)['close'] = semanticStop

    const svc = new MemoryService(store, [SEARCHABLE], { semanticStore })
    expect(svc.isClosed()).toBe(false)

    await svc.close()

    expect(semanticStop).toHaveBeenCalledTimes(1)
    expect(storeStop).toHaveBeenCalledTimes(1)
    expect(svc.isClosed()).toBe(true)
  })

  it('close() is idempotent', async () => {
    const store = await createStore({ type: 'memory' })
    const stop = vi.fn().mockResolvedValue(undefined)
    ;(store as unknown as Record<string, unknown>)['stop'] = stop

    const svc = new MemoryService(store, [SEARCHABLE])
    await svc.close()
    await svc.close()
    await svc.close()

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('supports await using via Symbol.asyncDispose', async () => {
    const store = await createStore({ type: 'memory' })
    const stop = vi.fn().mockResolvedValue(undefined)
    ;(store as unknown as Record<string, unknown>)['stop'] = stop

    const svc = new MemoryService(store, [SEARCHABLE])
    await svc[Symbol.asyncDispose]()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(svc.isClosed()).toBe(true)
  })
})

describe('AGENT-M-72 — vector index is consulted only for searchable namespaces', () => {
  it('does not embed a query for a namespace the write path never indexes', async () => {
    const store = await createStore({ type: 'memory' })
    const semanticStore = stubSemanticStore()

    const { results, searchFailed } = await searchMemoryWithStatus(
      NOT_SEARCHABLE,
      SCOPE,
      'anything',
      5,
      undefined,
      {
        store,
        semanticStore,
        capabilities: (
          store as unknown as { capabilities: never }
        ).capabilities,
        referenceTracker: undefined,
      },
    )

    expect(searchFailed).toBe(false)
    expect(results).toEqual([])
    // The whole point: no embedding round trip against a collection that, by
    // construction, can never hold a document for this namespace.
    expect(semanticStore.search).not.toHaveBeenCalled()
  })

  it('still consults the vector index for a searchable namespace', async () => {
    const store = await createStore({ type: 'memory' })
    const semanticStore = stubSemanticStore()

    await searchMemoryWithStatus(SEARCHABLE, SCOPE, 'anything', 5, undefined, {
      store,
      semanticStore,
      capabilities: (store as unknown as { capabilities: never }).capabilities,
      referenceTracker: undefined,
    })

    expect(semanticStore.search).toHaveBeenCalledTimes(1)
  })

  it('write and read paths agree: what is indexed is what is searched', async () => {
    const store = await createStore({ type: 'memory' })
    const semanticStore = stubSemanticStore()
    const svc = new MemoryService(store, [SEARCHABLE, NOT_SEARCHABLE], {
      semanticStore,
      rejectUnsafe: false,
    })

    await svc.put('decisions', SCOPE, 'd1', { text: 'a decision' })
    await svc.put('lessons', SCOPE, 'l1', { text: 'a lesson' })

    // Only the searchable namespace was indexed...
    expect(semanticStore.upsert).toHaveBeenCalledTimes(1)

    await svc.search('decisions', SCOPE, 'a decision')
    // ...and only the searchable namespace queries the index.
    expect(semanticStore.search).not.toHaveBeenCalled()

    await svc.search('lessons', SCOPE, 'a lesson')
    expect(semanticStore.search).toHaveBeenCalledTimes(1)
  })
})

describe('SEC-L-31 — vector-channel failures are surfaced, not swallowed', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('logs the error class and emits memory:vector_search_failed before degrading', async () => {
    const store = await createStore({ type: 'memory' })
    const bus = recordingEventBus()
    const semanticStore = stubSemanticStore({
      search: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    })

    const svc = new MemoryService(store, [SEARCHABLE], {
      semanticStore,
      rejectUnsafe: false,
      eventBus: bus,
      agentId: 'agent-7',
    })
    await svc.put('lessons', SCOPE, 'l1', { text: 'keyword hit' })

    const results = await svc.search('lessons', SCOPE, 'keyword')

    // Degradation still works — keyword results survive.
    expect(results).toHaveLength(1)

    expect(warn).toHaveBeenCalledTimes(1)
    const [, detail] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(detail['errorClass']).toBe('TypeError')
    expect(detail['namespace']).toBe('lessons')

    const emitted = bus.events.find(
      (e) => e.type === 'memory:vector_search_failed',
    )
    expect(emitted).toBeDefined()
    expect(emitted?.['errorClass']).toBe('TypeError')
    expect(emitted?.['agentId']).toBe('agent-7')
    expect(emitted?.['degradedTo']).toBe('keyword-only')
  })

  it('a healthy empty vector index is distinguishable from a failure', async () => {
    const store = await createStore({ type: 'memory' })
    const bus = recordingEventBus()
    const svc = new MemoryService(store, [SEARCHABLE], {
      semanticStore: stubSemanticStore(),
      rejectUnsafe: false,
      eventBus: bus,
    })

    await svc.search('lessons', SCOPE, 'anything')

    expect(warn).not.toHaveBeenCalled()
    expect(
      bus.events.filter((e) => e.type === 'memory:vector_search_failed'),
    ).toHaveLength(0)
  })
})
