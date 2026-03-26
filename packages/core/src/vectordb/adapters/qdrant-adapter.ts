/**
 * Qdrant vector store adapter — uses raw fetch() to the Qdrant REST API.
 * Zero SDK dependencies.
 */

import type {
  VectorStore,
  VectorStoreHealth,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  MetadataFilter,
  DistanceMetric,
} from '../types.js'

/** Configuration for the Qdrant adapter */
export interface QdrantAdapterConfig {
  /** Qdrant server URL (default: http://localhost:6333) */
  url?: string
  /** API key for authentication */
  apiKey?: string
  /** Custom fetch function for testing */
  fetch?: typeof globalThis.fetch
}

/** Qdrant filter condition (internal) */
interface QdrantCondition {
  key?: string
  match?: { value: string | number | boolean } | { any: (string | number)[] }
  range?: { gt?: number; gte?: number; lt?: number; lte?: number }
  must?: QdrantCondition[]
  should?: QdrantCondition[]
  must_not?: QdrantCondition[]
}

/** Qdrant filter (internal) */
interface QdrantFilter {
  must?: QdrantCondition[]
  should?: QdrantCondition[]
  must_not?: QdrantCondition[]
}

const DISTANCE_MAP: Record<DistanceMetric, string> = {
  cosine: 'Cosine',
  euclidean: 'Euclid',
  dot_product: 'Dot',
}

/**
 * Translates a normalized MetadataFilter into a Qdrant filter condition.
 */
function translateCondition(filter: MetadataFilter): QdrantCondition {
  if ('and' in filter) {
    return { must: filter.and.map(translateCondition) }
  }
  if ('or' in filter) {
    return { should: filter.or.map(translateCondition) }
  }

  const { field, op, value } = filter

  switch (op) {
    case 'eq':
      return { key: field, match: { value } }
    case 'neq':
      // Qdrant uses must_not for neq — wrap in a must_not at parent level
      // but as a single condition, we return it as a must_not wrapper
      return { must_not: [{ key: field, match: { value } }] }
    case 'gt':
      return { key: field, range: { gt: value } }
    case 'gte':
      return { key: field, range: { gte: value } }
    case 'lt':
      return { key: field, range: { lt: value } }
    case 'lte':
      return { key: field, range: { lte: value } }
    case 'in':
      return { key: field, match: { any: value } }
    case 'not_in':
      return { must_not: [{ key: field, match: { any: value } }] }
    case 'contains':
      // Qdrant full-text match uses match.text — but for simple substring,
      // we approximate with match.value (exact string match in Qdrant).
      // For true substring search, a full-text index must be created.
      return { key: field, match: { value } }
  }
}

/**
 * Translates a normalized MetadataFilter into a top-level Qdrant filter object.
 */
export function translateFilter(filter: MetadataFilter): QdrantFilter {
  const condition = translateCondition(filter)
  // If the top-level condition already has must/should/must_not, return as-is
  if (condition.must ?? condition.should ?? condition.must_not) {
    return condition as QdrantFilter
  }
  // Wrap single condition in must
  return { must: [condition] }
}

export class QdrantAdapter implements VectorStore {
  readonly provider = 'qdrant' as const

  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly fetchFn: typeof globalThis.fetch

  constructor(config?: QdrantAdapterConfig) {
    this.baseUrl = (config?.url ?? 'http://localhost:6333').replace(/\/+$/, '')
    this.apiKey = config?.apiKey
    this.fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) {
      h['api-key'] = this.apiKey
    }
    return h
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const url = `${this.baseUrl}${path}`
    const res = await this.fetchFn(url, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (res.status === 404) {
      return { status: 404, data: undefined as T }
    }

    const data = (await res.json()) as T

    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null && 'status' in data
          ? String((data as Record<string, unknown>)['status'])
          : `Qdrant request failed: ${res.status}`
      throw new Error(message)
    }

    return { status: res.status, data }
  }

  // --- Collection lifecycle ---

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    const distance = DISTANCE_MAP[config.metric ?? 'cosine']
    await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
      vectors: {
        size: config.dimensions,
        distance,
      },
    })
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request('DELETE', `/collections/${encodeURIComponent(name)}`)
  }

  async listCollections(): Promise<string[]> {
    interface ListResult {
      result: { collections: Array<{ name: string }> }
    }
    const { data } = await this.request<ListResult>('GET', '/collections')
    return data.result.collections.map((c) => c.name)
  }

  async collectionExists(name: string): Promise<boolean> {
    const { status } = await this.request(
      'GET',
      `/collections/${encodeURIComponent(name)}`,
    )
    return status !== 404
  }

  // --- Vector operations ---

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const points = entries.map((e) => ({
      id: e.id,
      vector: e.vector,
      payload: {
        ...e.metadata,
        ...(e.text !== undefined ? { text: e.text } : {}),
      },
    }))

    await this.request(
      'PUT',
      `/collections/${encodeURIComponent(collection)}/points`,
      { points },
    )
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorSearchResult[]> {
    const body: Record<string, unknown> = {
      vector: query.vector,
      limit: query.limit,
      with_payload: query.includeMetadata !== false,
      with_vector: query.includeVectors === true,
    }

    if (query.filter) {
      body['filter'] = translateFilter(query.filter)
    }

    if (query.minScore !== undefined) {
      body['score_threshold'] = query.minScore
    }

    interface SearchResult {
      result: Array<{
        id: string
        score: number
        payload?: Record<string, unknown>
        vector?: number[]
      }>
    }

    const { data } = await this.request<SearchResult>(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/search`,
      body,
    )

    return data.result.map((r) => {
      const payload = r.payload ?? {}
      const text = typeof payload['text'] === 'string' ? payload['text'] : undefined
      const metadata = { ...payload }
      if (text !== undefined) {
        delete metadata['text']
      }
      return {
        id: String(r.id),
        score: r.score,
        metadata,
        ...(text !== undefined ? { text } : {}),
        ...(r.vector ? { vector: r.vector } : {}),
      }
    })
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    let body: Record<string, unknown>

    if ('ids' in filter) {
      body = { points: filter.ids }
    } else {
      body = { filter: translateFilter(filter.filter) }
    }

    await this.request(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/delete`,
      body,
    )
  }

  async count(collection: string): Promise<number> {
    interface CountResult {
      result: { count: number }
    }
    const { data } = await this.request<CountResult>(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/count`,
      {},
    )
    return data.result.count
  }

  // --- Lifecycle ---

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.request('GET', '/healthz')
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        provider: this.provider,
      }
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        provider: this.provider,
      }
    }
  }

  async close(): Promise<void> {
    // No persistent connections to close with fetch-based adapter
  }
}
