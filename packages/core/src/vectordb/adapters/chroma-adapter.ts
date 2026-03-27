/**
 * ChromaDB adapter — implements VectorStore using ChromaDB REST API.
 *
 * Uses raw fetch() calls to the ChromaDB HTTP API. No chromadb SDK dependency.
 * Collection UUIDs are cached after creation/lookup to avoid repeated lookups.
 */

import type {
  VectorStore,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  VectorStoreHealth,
  MetadataFilter,
  DistanceMetric,
} from '../types.js'

/** Configuration for the ChromaDB adapter */
export interface ChromaDBAdapterConfig {
  /** ChromaDB server URL (default: http://localhost:8000) */
  url?: string
  /** Tenant name */
  tenant?: string
  /** Database name */
  database?: string
  /** Custom fetch function for testing */
  fetch?: typeof globalThis.fetch
}

/** ChromaDB where filter format */
type ChromaWhere = Record<string, unknown>

/** Translate a DistanceMetric to ChromaDB's hnsw:space value */
function metricToHnswSpace(metric: DistanceMetric | undefined): string {
  switch (metric) {
    case 'euclidean': return 'l2'
    case 'dot_product': return 'ip'
    case 'cosine':
    default: return 'cosine'
  }
}

/** Map our filter op to ChromaDB's $ operator */
function opToChromaOp(op: string): string {
  const map: Record<string, string> = {
    eq: '$eq',
    neq: '$ne',
    gt: '$gt',
    gte: '$gte',
    lt: '$lt',
    lte: '$lte',
    in: '$in',
    not_in: '$nin',
    contains: '$contains',
  }
  const result = map[op]
  if (!result) {
    throw new Error(`Unsupported filter operator: ${op}`)
  }
  return result
}

/** Translate a MetadataFilter to ChromaDB where format */
function translateFilter(filter: MetadataFilter): ChromaWhere {
  if ('and' in filter) {
    return { $and: filter.and.map(translateFilter) }
  }
  if ('or' in filter) {
    return { $or: filter.or.map(translateFilter) }
  }

  const { field, op, value } = filter
  const chromaOp = opToChromaOp(op)
  return { [field]: { [chromaOp]: value } }
}

/** Shape of a ChromaDB collection response */
interface ChromaCollectionResponse {
  id: string
  name: string
  metadata: Record<string, unknown> | null
}

/** Shape of a ChromaDB query response */
interface ChromaQueryResponse {
  ids: string[][]
  distances: (number[] | null)[] | null
  metadatas: (Record<string, unknown> | null)[][] | null
  documents: (string | null)[][] | null
  embeddings: (number[] | null)[][] | null
}

export class ChromaDBAdapter implements VectorStore {
  readonly provider = 'chroma' as const

  private readonly baseUrl: string
  private readonly tenant: string | undefined
  private readonly database: string | undefined
  private readonly fetchFn: typeof globalThis.fetch
  /** Cache: collection name -> UUID */
  private readonly collectionIds = new Map<string, string>()

  constructor(config?: ChromaDBAdapterConfig) {
    this.baseUrl = (config?.url ?? 'http://localhost:8000').replace(/\/+$/, '')
    this.tenant = config?.tenant
    this.database = config?.database
    this.fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private apiBase(): string {
    let base = `${this.baseUrl}/api/v1`
    if (this.tenant) {
      base = `${base}/tenants/${this.tenant}`
    }
    if (this.database) {
      base = `${base}/databases/${this.database}`
    }
    return base
  }

  private async request<T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const url = `${this.apiBase()}${path}`
    const response = await this.fetchFn(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers as Record<string, string> | undefined),
      },
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error')
      throw new Error(`ChromaDB request failed: ${response.status} ${response.statusText} - ${text}`)
    }

    return response.json() as Promise<T>
  }

  /** Get or fetch the UUID for a collection by name */
  private async getCollectionId(name: string): Promise<string> {
    const cached = this.collectionIds.get(name)
    if (cached) {
      return cached
    }

    const collection = await this.request<ChromaCollectionResponse>(
      `/collections/${encodeURIComponent(name)}`,
    )
    this.collectionIds.set(name, collection.id)
    return collection.id
  }

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    const space = metricToHnswSpace(config.metric)
    const collection = await this.request<ChromaCollectionResponse>(
      '/collections',
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          metadata: { 'hnsw:space': space },
          get_or_create: true,
        }),
      },
    )
    this.collectionIds.set(name, collection.id)
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request<unknown>(
      `/collections/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
    this.collectionIds.delete(name)
  }

  async listCollections(): Promise<string[]> {
    const collections = await this.request<ChromaCollectionResponse[]>('/collections')
    return collections.map((c) => c.name)
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.request<ChromaCollectionResponse>(
        `/collections/${encodeURIComponent(name)}`,
      )
      return true
    } catch {
      return false
    }
  }

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const collectionId = await this.getCollectionId(collection)

    const ids = entries.map((e) => e.id)
    const embeddings = entries.map((e) => e.vector)
    const metadatas = entries.map((e) => e.metadata)
    const documents = entries.map((e) => e.text ?? '')

    await this.request<unknown>(
      `/collections/${collectionId}/upsert`,
      {
        method: 'POST',
        body: JSON.stringify({ ids, embeddings, metadatas, documents }),
      },
    )
  }

  async search(collection: string, query: VectorQuery): Promise<VectorSearchResult[]> {
    const collectionId = await this.getCollectionId(collection)

    const body: Record<string, unknown> = {
      query_embeddings: [query.vector],
      n_results: query.limit,
    }

    if (query.filter) {
      body['where'] = translateFilter(query.filter)
    }

    if (query.includeVectors) {
      body['include'] = ['metadatas', 'documents', 'distances', 'embeddings']
    }

    const result = await this.request<ChromaQueryResponse>(
      `/collections/${collectionId}/query`,
      { method: 'POST', body: JSON.stringify(body) },
    )

    const ids = result.ids[0] ?? []
    const distances = result.distances?.[0] ?? []
    const metadatas = result.metadatas?.[0] ?? []
    const documents = result.documents?.[0] ?? []
    const embeddings = result.embeddings?.[0] ?? []

    const results: VectorSearchResult[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!id) continue

      // ChromaDB returns distances, not scores. For cosine, score = 1 - distance
      const distance = distances[i] ?? 0
      const score = 1 - distance

      if (query.minScore !== undefined && score < query.minScore) {
        continue
      }

      const entry: VectorSearchResult = {
        id,
        score,
        metadata: (metadatas[i] as Record<string, unknown> | null) ?? {},
        text: (documents[i] as string | null) ?? undefined,
      }

      if (query.includeVectors && embeddings[i]) {
        entry.vector = embeddings[i] as number[]
      }

      results.push(entry)
    }

    return results
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const collectionId = await this.getCollectionId(collection)

    if ('ids' in filter) {
      await this.request<unknown>(
        `/collections/${collectionId}/delete`,
        { method: 'POST', body: JSON.stringify({ ids: filter.ids }) },
      )
    } else {
      const where = translateFilter(filter.filter)
      await this.request<unknown>(
        `/collections/${collectionId}/delete`,
        { method: 'POST', body: JSON.stringify({ where }) },
      )
    }
  }

  async count(collection: string): Promise<number> {
    const collectionId = await this.getCollectionId(collection)
    const result = await this.request<number>(
      `/collections/${collectionId}/count`,
    )
    return result
  }

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.request<Record<string, unknown>>('/heartbeat')
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
    this.collectionIds.clear()
  }
}
