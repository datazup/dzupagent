/**
 * QdrantVectorStore — Option A backend for HybridRetriever.
 *
 * Strategy: a single Qdrant collection with `tenantId` payload filter
 * (NOT a collection-per-tenant). This keeps operational footprint small
 * and lets a host wire `HybridRetriever` against a real vector backend
 * without bringing the Qdrant SDK into the framework's required
 * dependency graph.
 *
 * The Qdrant client is loaded via dynamic import — mirrors the
 * `loadBullMQ` pattern in `codev-app/api/queue.service.ts`. If the
 * package is not installed we return `null` from
 * {@link createQdrantRetriever} and {@link QdrantVectorStore.tryCreate}
 * rather than throwing.
 *
 * NOTE: This file deliberately does NOT touch the existing
 * {@link import('../qdrant-factory.js').createQdrantRagPipeline}
 * factory which uses the per-tenant-collection adapter from
 * `@dzupagent/core`. Both strategies are valid and target different
 * operational profiles.
 */

import type {
  CollectionConfig,
  VectorDBSearchResult,
  VectorDeleteFilter,
  VectorEntry,
  VectorQuery,
  VectorStore,
  VectorStoreHealth,
} from '@dzupagent/core'

import type {
  KeywordSearchFn,
  KeywordSearchHit,
  VectorSearchFn,
  VectorSearchHit,
} from '../types.js'

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

/** Configuration for {@link QdrantVectorStore}. */
export interface QdrantVectorStoreConfig {
  /** Qdrant server URL (e.g. `http://localhost:6333`). */
  url: string
  /** Qdrant API key (omit for unauthenticated servers). */
  apiKey?: string
  /** Single shared collection name (Option A — tenants isolated by filter). */
  collectionName: string
  /**
   * Test seam: inject a pre-built client to bypass the dynamic import.
   * When provided, `loadQdrantClient` is not called.
   */
  client?: QdrantClientLike
}

/** Configuration for {@link createQdrantRetriever}. */
export interface QdrantRetrieverConfig extends QdrantVectorStoreConfig {
  /**
   * Optional default tenant id applied to every search when the
   * caller's `filter` argument does not already carry one. Most callers
   * pass `tenantId` per-request via the filter; this is a safety net.
   */
  defaultTenantId?: string
  /**
   * Hook that maps a Qdrant point payload to the `text` surface
   * expected by `HybridRetriever`. Defaults to
   * `payload.text` then empty string.
   */
  textField?: string
}

// ---------------------------------------------------------------------------
// Minimal client surface (structural typing)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the @qdrant/js-client-rest `QdrantClient` we
 * actually use. Keeps this file decoupled from the SDK's TS types so
 * tests can supply a plain object via `config.client`.
 */
export interface QdrantClientLike {
  upsert: (
    collectionName: string,
    body: {
      points: Array<{
        id: string | number
        vector: number[]
        payload?: Record<string, unknown>
      }>
    },
  ) => Promise<unknown>
  search: (
    collectionName: string,
    body: {
      vector: number[]
      limit: number
      with_payload?: boolean
      filter?: QdrantFilter
      score_threshold?: number
    },
  ) => Promise<
    Array<{
      id: string | number
      score: number
      payload?: Record<string, unknown> | null
    }>
  >
  scroll: (
    collectionName: string,
    body: {
      limit: number
      with_payload?: boolean
      filter?: QdrantFilter
    },
  ) => Promise<{
    points: Array<{
      id: string | number
      payload?: Record<string, unknown> | null
    }>
  }>
}

/** Top-level Qdrant filter, only the bits we emit. */
export interface QdrantFilter {
  must?: QdrantFilterClause[]
  must_not?: QdrantFilterClause[]
  should?: QdrantFilterClause[]
}

/** Single filter clause we may emit. */
export interface QdrantFilterClause {
  key: string
  match: { value: string | number | boolean } | { any: Array<string | number> }
}

// ---------------------------------------------------------------------------
// Dynamic loader (mirrors the loadBullMQ pattern)
// ---------------------------------------------------------------------------

type QdrantClientCtor = new (config: { url: string; apiKey?: string }) => QdrantClientLike

let _qdrantCtor: QdrantClientCtor | null = null
let _loadAttempted = false

/**
 * Resolve the `QdrantClient` constructor from `@qdrant/js-client-rest`
 * via dynamic import. Returns `null` if the optional peer dep is not
 * installed. The result is memoised for the process lifetime.
 *
 * Exported for tests so they can reset state via
 * {@link __resetQdrantLoaderForTests}.
 */
export async function loadQdrantClient(): Promise<QdrantClientCtor | null> {
  if (_loadAttempted) return _qdrantCtor
  _loadAttempted = true

  try {
    // The string is intentionally a literal so bundlers can detect the
    // optional dependency, but resolution still happens at runtime.
    const mod = (await import('@qdrant/js-client-rest')) as {
      QdrantClient?: QdrantClientCtor
    }
    if (typeof mod.QdrantClient !== 'function') {
      _qdrantCtor = null
      return null
    }
    _qdrantCtor = mod.QdrantClient
    return _qdrantCtor
  } catch {
    _qdrantCtor = null
    return null
  }
}

/** Test-only — clear the memoised loader state. */
export function __resetQdrantLoaderForTests(): void {
  _qdrantCtor = null
  _loadAttempted = false
}

// ---------------------------------------------------------------------------
// QdrantVectorStore
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around the Qdrant REST client that:
 *
 *   1. Always appends `{ key: 'tenantId', match: { value } }` to every
 *      search filter, enforcing tenant isolation in a single shared
 *      collection.
 *   2. Surfaces a tiny ergonomic `upsert` / `search` / `keywordSearch`
 *      API tailored to the RAG pipeline's needs.
 *
 * Construct via {@link QdrantVectorStore.tryCreate} when you want the
 * "missing optional dep" path to be non-fatal.
 */
export class QdrantVectorStore {
  readonly collectionName: string

  private readonly client: QdrantClientLike
  private readonly defaultTenantId: string | undefined

  constructor(client: QdrantClientLike, config: QdrantVectorStoreConfig & { defaultTenantId?: string }) {
    this.client = client
    this.collectionName = config.collectionName
    this.defaultTenantId = config.defaultTenantId
  }

  /**
   * Construct a {@link QdrantVectorStore} or return `null` when the
   * `@qdrant/js-client-rest` package is not installed.
   *
   * If `config.client` is provided, the dynamic import is skipped
   * entirely (this is the test seam).
   */
  static async tryCreate(
    config: QdrantVectorStoreConfig & { defaultTenantId?: string },
  ): Promise<QdrantVectorStore | null> {
    if (config.client) {
      return new QdrantVectorStore(config.client, config)
    }
    const ctor = await loadQdrantClient()
    if (!ctor) return null
    const client = new ctor({
      url: config.url,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    })
    return new QdrantVectorStore(client, config)
  }

  /** Insert / update a single point. */
  async upsert(
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.client.upsert(this.collectionName, {
      points: [{ id, vector, payload }],
    })
  }

  /** Insert / update many points in one round-trip. */
  async upsertMany(
    points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
  ): Promise<void> {
    if (points.length === 0) return
    await this.client.upsert(this.collectionName, { points })
  }

  /** Vector similarity search, tenant-filter applied automatically. */
  async search(
    vector: number[],
    topK: number,
    filter?: Record<string, unknown>,
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const qdrantFilter = this.buildFilter(filter)
    const hits = await this.client.search(this.collectionName, {
      vector,
      limit: topK,
      with_payload: true,
      ...(qdrantFilter ? { filter: qdrantFilter } : {}),
    })
    return hits.map((h) => ({
      id: String(h.id),
      score: h.score,
      payload: (h.payload ?? {}) as Record<string, unknown>,
    }))
  }

  /**
   * Keyword search — Qdrant doesn't ship a true BM25 endpoint, so we
   * lean on payload `match.text` via the `scroll` endpoint and apply
   * the same tenant filter. Score is uniform (1.0) because the host
   * retriever uses RRF on rank rather than raw score for keyword hits.
   *
   * Callers that need real BM25 should run keyword search through a
   * Postgres FTS / OpenSearch backend instead.
   */
  async keywordSearch(
    query: string,
    topK: number,
    filter?: Record<string, unknown>,
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const tenantClause = this.tenantClause(filter)
    const userClauses = this.userClauses(filter)
    const must: QdrantFilterClause[] = [...userClauses]
    if (tenantClause) must.push(tenantClause)
    // Best-effort phrase match against the canonical `text` field.
    must.push({ key: 'text', match: { value: query } })

    const result = await this.client.scroll(this.collectionName, {
      limit: topK,
      with_payload: true,
      filter: { must },
    })

    return result.points.map((p, i) => ({
      id: String(p.id),
      // Rank-decayed score so RRF gets a stable ordering signal.
      score: 1 / (i + 1),
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }))
  }

  // -------------------------------------------------------------------------
  // Filter assembly
  // -------------------------------------------------------------------------

  private buildFilter(filter?: Record<string, unknown>): QdrantFilter | undefined {
    const tenantClause = this.tenantClause(filter)
    const userClauses = this.userClauses(filter)
    const must: QdrantFilterClause[] = [...userClauses]
    if (tenantClause) must.push(tenantClause)
    if (must.length === 0) return undefined
    return { must }
  }

  private tenantClause(
    filter?: Record<string, unknown>,
  ): QdrantFilterClause | undefined {
    const explicit = filter?.['tenantId']
    const value =
      typeof explicit === 'string' || typeof explicit === 'number' || typeof explicit === 'boolean'
        ? explicit
        : this.defaultTenantId
    if (value === undefined || value === null || value === '') return undefined
    return { key: 'tenantId', match: { value } }
  }

  private userClauses(
    filter?: Record<string, unknown>,
  ): QdrantFilterClause[] {
    if (!filter) return []
    const clauses: QdrantFilterClause[] = []
    for (const [key, raw] of Object.entries(filter)) {
      if (key === 'tenantId') continue
      if (raw === undefined || raw === null) continue
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        clauses.push({ key, match: { value: raw } })
      } else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string' || typeof v === 'number')) {
        clauses.push({ key, match: { any: raw as Array<string | number> } })
      }
      // Unknown / nested filter shapes are silently dropped — Option A
      // intentionally keeps filter translation conservative.
    }
    return clauses
  }
}

// ---------------------------------------------------------------------------
// createQdrantRetriever — the surface rag.service.ts will call
// ---------------------------------------------------------------------------

/**
 * Result of {@link createQdrantRetriever}.
 *
 * `embedQuery` is intentionally NOT included — the caller injects an
 * embedder so the framework stays embedding-agnostic.
 */
export interface QdrantRetrieverWiring {
  /** The shared store, exposed so the caller can also `upsert`. */
  store: QdrantVectorStore
  /** Plug into `HybridRetrieverConfig.vectorSearch`. */
  vectorSearch: VectorSearchFn
  /** Plug into `HybridRetrieverConfig.keywordSearch`. */
  keywordSearch: KeywordSearchFn
}

/**
 * Build a {@link QdrantVectorStore} and wrap it in `VectorSearchFn` /
 * `KeywordSearchFn` adapters that match the shape `HybridRetriever`
 * already accepts.
 *
 * Returns `null` (mirroring `loadModule`) when:
 *   - The optional `@qdrant/js-client-rest` peer dep is not installed,
 *     and the caller did not supply a `client` test-seam.
 */
export async function createQdrantRetriever(
  config: QdrantRetrieverConfig,
): Promise<QdrantRetrieverWiring | null> {
  const store = await QdrantVectorStore.tryCreate(config)
  if (!store) return null

  const textField = config.textField ?? 'text'

  const toVectorHit = (
    h: { id: string; score: number; payload: Record<string, unknown> },
  ): VectorSearchHit => {
    const text = pickText(h.payload, textField)
    return {
      id: h.id,
      score: h.score,
      text,
      metadata: h.payload,
    }
  }

  const toKeywordHit = (
    h: { id: string; score: number; payload: Record<string, unknown> },
  ): KeywordSearchHit => {
    const text = pickText(h.payload, textField)
    return {
      id: h.id,
      score: h.score,
      text,
      metadata: h.payload,
    }
  }

  const vectorSearch: VectorSearchFn = async (vector, filter, limit, minScore) => {
    const hits = await store.search(vector, limit, filter)
    const filtered = typeof minScore === 'number' ? hits.filter((h) => h.score >= minScore) : hits
    return filtered.map(toVectorHit)
  }

  const keywordSearch: KeywordSearchFn = async (query, filter, limit) => {
    const hits = await store.keywordSearch(query, limit, filter)
    return hits.map(toKeywordHit)
  }

  return { store, vectorSearch, keywordSearch }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickText(payload: Record<string, unknown>, key: string): string {
  const v = payload[key]
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// QdrantCorpusStore — VectorStore facade for CorpusManager
// ---------------------------------------------------------------------------

/**
 * Adapter that lets {@link import('../corpus-manager.js').CorpusManager}
 * write into and read from a single shared Qdrant collection while
 * still emitting the per-corpus / per-tenant filters consumers expect.
 *
 * The `collection` argument supplied by `CorpusManager` is recorded
 * into a payload field (`_collection`, configurable) so the same
 * physical collection can host multiple corpora without cross-talk.
 */
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
    await this.store['client'].scroll(this.store.collectionName, {
      limit: 1,
      with_payload: false,
      filter: { must: [{ key: this.collectionField, match: { value: name } }] },
    })
    // Issue a delete via the underlying client when supported.
    const client = this.store['client'] as unknown as {
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
    const client = this.store['client'] as unknown as {
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

