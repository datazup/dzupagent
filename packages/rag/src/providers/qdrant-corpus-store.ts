/**
 * `QdrantCorpusStore` — `VectorStore` facade for `CorpusManager` that
 * lets multiple logical corpora share a single physical Qdrant
 * collection.
 *
 * The `collection` argument supplied by `CorpusManager` is recorded
 * into a payload field (`_collection`, configurable) so the same
 * physical collection can host multiple corpora without cross-talk.
 * Tenant filtering is delegated to the underlying
 * {@link QdrantVectorStore}.
 */

import type {
  CollectionConfig,
  VectorSearchResult as VectorDBSearchResult,
  VectorDeleteFilter,
  VectorEntry,
  VectorQuery,
  VectorStore,
  VectorStoreHealth,
} from '@dzupagent/core/vectordb'

import type { QdrantVectorStore } from './qdrant-store.js'
import type { QdrantFilter } from './qdrant-types.js'

export class QdrantCorpusStore implements VectorStore {
  readonly provider = 'qdrant-shared' as const

  private readonly store: QdrantVectorStore
  private readonly collectionField: string
  /** Track logical "collections" the manager has asked us to create. */
  private readonly knownCollections = new Set<string>()

  constructor(
    store: QdrantVectorStore,
    options: { collectionField?: string } = {},
  ) {
    this.store = store
    this.collectionField = options.collectionField ?? '_collection'
  }

  async createCollection(name: string, _config: CollectionConfig): Promise<void> {
    // Single physical collection — provisioning is the operator's job.
    this.knownCollections.add(name)
  }

  async deleteCollection(name: string): Promise<void> {
    if (!this.knownCollections.has(name)) return
    this.knownCollections.delete(name)
    // Best-effort delete by filter — leaves the physical collection intact.
    await this.store.client.scroll(this.store.collectionName, {
      limit: 1,
      with_payload: false,
      filter: { must: [{ key: this.collectionField, match: { value: name } }] },
    })
    // Issue a delete via the underlying client when supported.
    const client = this.store.client as unknown as {
      delete?: (
        c: string,
        body: { filter: QdrantFilter },
      ) => Promise<unknown>
    }
    if (typeof client.delete === 'function') {
      await client.delete(this.store.collectionName, {
        filter: { must: [{ key: this.collectionField, match: { value: name } }] },
      })
    }
  }

  async listCollections(): Promise<string[]> {
    return [...this.knownCollections]
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.knownCollections.has(name)
  }

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return
    await this.store.upsertMany(
      entries.map((e) => ({
        id: e.id,
        vector: e.vector,
        payload: {
          ...e.metadata,
          ...(e.text !== undefined ? { text: e.text } : {}),
          [this.collectionField]: collection,
        },
      })),
    )
  }

  async search(collection: string, query: VectorQuery): Promise<VectorDBSearchResult[]> {
    // Inject the synthetic _collection filter alongside any tenant filter.
    const filter: Record<string, unknown> = {
      [this.collectionField]: collection,
    }
    const tenantId = pickTenant(query.filter)
    if (tenantId !== undefined) filter['tenantId'] = tenantId

    const hits = await this.store.search(query.vector, query.limit, filter)
    const filtered =
      typeof query.minScore === 'number'
        ? hits.filter((h) => h.score >= query.minScore!)
        : hits
    return filtered.map((h) => {
      const payload = { ...h.payload }
      const text = typeof payload['text'] === 'string' ? (payload['text'] as string) : undefined
      delete payload['text']
      delete payload[this.collectionField]
      return {
        id: h.id,
        score: h.score,
        metadata: payload,
        ...(text !== undefined ? { text } : {}),
      }
    })
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const client = this.store.client as unknown as {
      delete?: (
        c: string,
        body: { points?: Array<string | number>; filter?: QdrantFilter },
      ) => Promise<unknown>
    }
    if (typeof client.delete !== 'function') return
    if ('ids' in filter) {
      await client.delete(this.store.collectionName, { points: filter.ids })
      return
    }
    // Metadata-filter deletes are scoped to this logical collection.
    await client.delete(this.store.collectionName, {
      filter: { must: [{ key: this.collectionField, match: { value: collection } }] },
    })
  }

  async count(_collection: string): Promise<number> {
    // Counting per logical collection requires a Qdrant `count` round-trip;
    // CorpusManager doesn't actually call this on the hot path, so we
    // return 0 rather than depend on an extra client surface.
    return 0
  }

  async healthCheck(): Promise<VectorStoreHealth> {
    return { healthy: true, latencyMs: 0, provider: this.provider }
  }

  async close(): Promise<void> {
    // Underlying client is fetch-based; nothing to release.
  }
}

function pickTenant(
  filter: VectorQuery['filter'] | undefined,
): string | number | boolean | undefined {
  if (!filter) return undefined
  if ('and' in filter || 'or' in filter) {
    const branches = 'and' in filter ? filter.and : filter.or
    for (const child of branches) {
      const v = pickTenant(child)
      if (v !== undefined) return v
    }
    return undefined
  }
  if ('field' in filter && filter.field === 'tenantId' && filter.op === 'eq') {
    return filter.value
  }
  return undefined
}
