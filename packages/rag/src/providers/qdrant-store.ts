/**
 * `QdrantVectorStore` — thin wrapper around the Qdrant REST client that:
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

import { loadQdrantClient } from './qdrant-loader.js'
import type {
  QdrantClientLike,
  QdrantFilter,
  QdrantFilterClause,
  QdrantVectorStoreConfig,
} from './qdrant-types.js'

export class QdrantVectorStore {
  readonly collectionName: string

  /** Internal client handle — exposed at module scope so the corpus store can issue extra ops. */
  readonly client: QdrantClientLike
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
