/**
 * Turbopuffer vector store adapter -- uses native fetch() to the Turbopuffer REST API.
 * Zero SDK dependencies. Object-storage-backed, cost-effective at scale.
 *
 * Turbopuffer maps collections to "namespaces". Each namespace holds vectors
 * with arbitrary attributes (metadata). Distance metrics are set per-query.
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

/** Configuration for the Turbopuffer adapter */
export interface TurbopufferAdapterConfig {
  /** Turbopuffer API key (required) */
  apiKey: string
  /** Base URL (default: 'https://api.turbopuffer.com') */
  baseUrl?: string
  /** Namespace prefix for multi-tenant isolation */
  namespacePrefix?: string
  /** Maximum vectors per upsert batch (default: 256) */
  batchSize?: number
  /** Maximum retries for rate-limited requests (default: 3) */
  maxRetries?: number
  /** Custom fetch function for testing */
  fetch?: typeof globalThis.fetch
}

/** Turbopuffer filter value type (internal) */
type TurbopufferFilterValue =
  | string
  | number
  | boolean
  | (string | number)[]

/** Single Turbopuffer filter condition (internal) */
type TurbopufferCondition = [string, string, TurbopufferFilterValue]

/** Turbopuffer filter: either a single condition or a boolean composition */
type TurbopufferFilter =
  | TurbopufferCondition
  | ['And', TurbopufferFilter[]]
  | ['Or', TurbopufferFilter[]]

const METRIC_MAP: Record<DistanceMetric, string> = {
  cosine: 'cosine_distance',
  euclidean: 'euclidean_squared',
  dot_product: 'dot_product',
}

const OP_MAP: Record<string, string> = {
  eq: 'Eq',
  neq: 'NotEq',
  gt: 'Gt',
  gte: 'Gte',
  lt: 'Lt',
  lte: 'Lte',
  in: 'In',
  not_in: 'NotIn',
  contains: 'Eq', // Turbopuffer has no substring match; fall back to exact
}

/**
 * Translates a normalized MetadataFilter into the Turbopuffer filter format.
 *
 * Turbopuffer uses array-based filter syntax:
 *   ["field_name", "Op", value]
 *   ["And", [...conditions]]
 *   ["Or",  [...conditions]]
 */
export function translateFilter(filter: MetadataFilter): TurbopufferFilter {
  if ('and' in filter) {
    return ['And', filter.and.map(translateFilter)]
  }
  if ('or' in filter) {
    return ['Or', filter.or.map(translateFilter)]
  }

  const { field, op, value } = filter
  const tpOp = OP_MAP[op] as string
  return [field, tpOp, value as TurbopufferFilterValue]
}

/** Namespace info response shape (internal) */
interface NamespaceInfo {
  approx_count?: number
  dimensions?: number
}

/** Namespaces list response shape (internal) */
interface NamespacesListResponse {
  namespaces?: Array<{ id: string }>
  next_cursor?: string
}

/** Query response shape (internal) */
interface QueryResponse {
  ids?: string[]
  dist?: number[]
  vectors?: number[][]
  attributes?: Record<string, (string | number | boolean | null)[]>
}

export class TurbopufferAdapter implements VectorStore {
  readonly provider = 'turbopuffer' as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly namespacePrefix: string
  private readonly batchSize: number
  private readonly maxRetries: number
  private readonly fetchFn: typeof globalThis.fetch

  /**
   * Tracks known collections so collectionExists / listCollections work
   * even though Turbopuffer auto-creates namespaces on first upsert.
   */
  private readonly knownCollections = new Set<string>()

  constructor(config: TurbopufferAdapterConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? 'https://api.turbopuffer.com').replace(/\/+$/, '')
    this.namespacePrefix = config.namespacePrefix ?? ''
    this.batchSize = config.batchSize ?? 256
    this.maxRetries = config.maxRetries ?? 3
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Resolve the full namespace name for a collection */
  private ns(collection: string): string {
    return this.namespacePrefix ? `${this.namespacePrefix}_${collection}` : collection
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  /**
   * Execute a request against the Turbopuffer API with retry on 429.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const url = `${this.baseUrl}${path}`
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchFn(url, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

      // Rate-limited -- back off and retry
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = res.headers.get('retry-after')
        const delayMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1)
        await this.sleep(delayMs)
        lastError = new Error(`Turbopuffer rate limited (429), attempt ${attempt + 1}`)
        continue
      }

      if (res.status === 404) {
        return { status: 404, data: undefined as T }
      }

      // Some endpoints return 204 No Content
      if (res.status === 204) {
        return { status: 204, data: undefined as T }
      }

      const text = await res.text()
      const data = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)

      if (!res.ok) {
        const message =
          typeof data === 'object' && data !== null && 'error' in data
            ? String((data as Record<string, unknown>)['error'])
            : `Turbopuffer request failed: ${res.status}`
        throw new Error(message)
      }

      return { status: res.status, data }
    }

    throw lastError ?? new Error('Turbopuffer request failed after retries')
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // --- Collection lifecycle ---

  async createCollection(name: string, _config: CollectionConfig): Promise<void> {
    // Turbopuffer auto-creates namespaces on first upsert.
    // We just track the intent so collectionExists returns true.
    this.knownCollections.add(name)
  }

  async deleteCollection(name: string): Promise<void> {
    const namespace = this.ns(name)
    await this.request(
      'DELETE',
      `/v1/vectors/${encodeURIComponent(namespace)}`,
    )
    this.knownCollections.delete(name)
  }

  async listCollections(): Promise<string[]> {
    const all: string[] = []
    let cursor: string | undefined

     
    while (true) {
      const path = cursor
        ? `/v1/vectors?cursor=${encodeURIComponent(cursor)}`
        : '/v1/vectors'

      const { data } = await this.request<NamespacesListResponse>('GET', path)

      const namespaces = data?.namespaces ?? []
      for (const ns of namespaces) {
        const id = ns.id
        if (this.namespacePrefix) {
          const prefix = `${this.namespacePrefix}_`
          if (id.startsWith(prefix)) {
            all.push(id.slice(prefix.length))
          }
        } else {
          all.push(id)
        }
      }

      if (data?.next_cursor) {
        cursor = data.next_cursor
      } else {
        break
      }
    }

    return all
  }

  async collectionExists(name: string): Promise<boolean> {
    if (this.knownCollections.has(name)) return true

    const namespace = this.ns(name)
    const { status } = await this.request<NamespaceInfo>(
      'GET',
      `/v1/vectors/${encodeURIComponent(namespace)}`,
    )
    const exists = status !== 404
    if (exists) this.knownCollections.add(name)
    return exists
  }

  // --- Vector operations ---

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const namespace = this.ns(collection)
    this.knownCollections.add(collection)

    // Batch large upserts
    for (let i = 0; i < entries.length; i += this.batchSize) {
      const batch = entries.slice(i, i + this.batchSize)

      const ids: string[] = []
      const vectors: number[][] = []

      // Collect all unique attribute keys across the batch
      const attrKeys = new Set<string>()
      for (const entry of batch) {
        for (const key of Object.keys(entry.metadata)) {
          attrKeys.add(key)
        }
        if (entry.text !== undefined) {
          attrKeys.add('text')
        }
      }

      // Build columnar attributes
      const attributes: Record<string, (string | number | boolean | null)[]> = {}
      for (const key of attrKeys) {
        attributes[key] = []
      }

      for (const entry of batch) {
        ids.push(entry.id)
        vectors.push(entry.vector)

        for (const key of attrKeys) {
          const col = attributes[key]!
          if (key === 'text' && entry.text !== undefined) {
            col.push(entry.text)
          } else if (key === 'text') {
            // Text not set for this entry, use metadata text or null
            const metaText = entry.metadata['text']
            col.push(
              typeof metaText === 'string' || typeof metaText === 'number' || typeof metaText === 'boolean'
                ? metaText
                : null,
            )
          } else {
            const val = entry.metadata[key]
            col.push(
              val === undefined || val === null
                ? null
                : (val as string | number | boolean),
            )
          }
        }
      }

      await this.request(
        'POST',
        `/v1/vectors/${encodeURIComponent(namespace)}`,
        {
          ids,
          vectors,
          attributes,
        },
      )
    }
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorSearchResult[]> {
    const namespace = this.ns(collection)

    const body: Record<string, unknown> = {
      vector: query.vector,
      top_k: query.limit,
      distance_metric: METRIC_MAP[('cosine' as DistanceMetric)],
      include_vectors: query.includeVectors === true,
      include_attributes: query.includeMetadata !== false ? true : undefined,
    }

    if (query.filter) {
      body['filters'] = translateFilter(query.filter)
    }

    const { data } = await this.request<QueryResponse>(
      'POST',
      `/v1/vectors/${encodeURIComponent(namespace)}/query`,
      body,
    )

    const ids = data?.ids ?? []
    const distances = data?.dist ?? []
    const vectors = data?.vectors
    const attributes = data?.attributes ?? {}

    const results: VectorSearchResult[] = []

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (id === undefined) continue

      // Turbopuffer returns distances, convert to similarity scores.
      // For cosine_distance, score = 1 - distance
      const distance = distances[i] ?? 0
      const score = 1 - distance

      if (query.minScore !== undefined && score < query.minScore) {
        continue
      }

      // Extract metadata from columnar attributes
      const metadata: Record<string, unknown> = {}
      let text: string | undefined

      for (const [key, values] of Object.entries(attributes)) {
        const val = values[i]
        if (val === null || val === undefined) continue
        if (key === 'text' && typeof val === 'string') {
          text = val
        } else {
          metadata[key] = val
        }
      }

      const result: VectorSearchResult = {
        id,
        score,
        metadata,
        ...(text !== undefined ? { text } : {}),
        ...(vectors && vectors[i] ? { vector: vectors[i] } : {}),
      }

      results.push(result)
    }

    return results
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const namespace = this.ns(collection)

    if ('ids' in filter) {
      await this.request(
        'POST',
        `/v1/vectors/${encodeURIComponent(namespace)}/delete`,
        { ids: filter.ids },
      )
    } else {
      await this.request(
        'POST',
        `/v1/vectors/${encodeURIComponent(namespace)}/delete`,
        { filters: translateFilter(filter.filter) },
      )
    }
  }

  async count(collection: string): Promise<number> {
    const namespace = this.ns(collection)
    const { status, data } = await this.request<NamespaceInfo>(
      'GET',
      `/v1/vectors/${encodeURIComponent(namespace)}`,
    )

    if (status === 404) return 0
    return data?.approx_count ?? 0
  }

  // --- Lifecycle ---

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.request('GET', '/v1/vectors')
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
    this.knownCollections.clear()
  }
}
