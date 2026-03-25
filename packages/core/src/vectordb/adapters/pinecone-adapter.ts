/**
 * Pinecone vector store adapter — uses raw fetch() to the Pinecone REST API.
 * Zero SDK dependencies. Supports serverless Pinecone (direct indexHost).
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

/** Configuration for the Pinecone adapter */
export interface PineconeAdapterConfig {
  /** Pinecone API key (required) */
  apiKey: string
  /** Environment for legacy Pinecone (e.g. 'us-east-1-aws') */
  environment?: string
  /** Direct index host URL for serverless Pinecone */
  indexHost?: string
  /** Cloud provider for serverless index creation (default: 'aws') */
  cloud?: string
  /** Region for serverless index creation (default: 'us-east-1') */
  region?: string
  /** Custom fetch function for testing */
  fetch?: typeof globalThis.fetch
}

/** Pinecone filter value type (internal) */
type PineconeFilterValue =
  | string
  | number
  | boolean
  | (string | number)[]
  | PineconeFilter

/** Pinecone filter (internal) */
interface PineconeFilter {
  [key: string]: PineconeFilterValue | Record<string, PineconeFilterValue>
}

const METRIC_MAP: Record<DistanceMetric, string> = {
  cosine: 'cosine',
  euclidean: 'euclidean',
  dot_product: 'dotproduct',
}

const OP_MAP: Record<string, string> = {
  eq: '$eq',
  neq: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  not_in: '$nin',
  contains: '$eq', // Pinecone has no substring match; fall back to exact
}

/**
 * Translates a normalized MetadataFilter into a Pinecone filter object.
 */
export function translateFilter(filter: MetadataFilter): PineconeFilter {
  if ('and' in filter) {
    return { $and: filter.and.map(translateFilter) as unknown as PineconeFilterValue }
  }
  if ('or' in filter) {
    return { $or: filter.or.map(translateFilter) as unknown as PineconeFilterValue }
  }

  const { field, op, value } = filter
  const pineconeOp = OP_MAP[op] as string
  const inner: Record<string, PineconeFilterValue> = {}
  inner[pineconeOp] = value as PineconeFilterValue
  const outer: PineconeFilter = {}
  outer[field] = inner
  return outer
}

/**
 * Resolves the Pinecone control plane base URL.
 */
function controlPlaneUrl(): string {
  return 'https://api.pinecone.io'
}

export class PineconeAdapter implements VectorStore {
  readonly provider = 'pinecone' as const

  private readonly apiKey: string
  private readonly fetchFn: typeof globalThis.fetch
  private readonly cloud: string
  private readonly region: string

  /**
   * Maps collection (index) name to its host URL.
   * Populated after createCollection or when indexHost is provided.
   */
  private readonly hostCache = new Map<string, string>()
  private readonly defaultHost: string | undefined

  constructor(config: PineconeAdapterConfig) {
    this.apiKey = config.apiKey
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.cloud = config.cloud ?? 'aws'
    this.region = config.region ?? 'us-east-1'
    this.defaultHost = config.indexHost?.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Api-Key': this.apiKey,
    }
  }

  private async controlRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const url = `${controlPlaneUrl()}${path}`
    const res = await this.fetchFn(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (res.status === 404) {
      return { status: 404, data: undefined as T }
    }

    const data = (await res.json()) as T

    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null && 'message' in data
          ? String((data as Record<string, unknown>)['message'])
          : `Pinecone request failed: ${res.status}`
      throw new Error(message)
    }

    return { status: res.status, data }
  }

  private async getHost(collection: string): Promise<string> {
    const cached = this.hostCache.get(collection)
    if (cached) return cached

    if (this.defaultHost) {
      this.hostCache.set(collection, this.defaultHost)
      return this.defaultHost
    }

    // Look up the index host via describe-index
    interface DescribeResult {
      host: string
    }
    const { data } = await this.controlRequest<DescribeResult>(
      'GET',
      `/indexes/${encodeURIComponent(collection)}`,
    )
    const host = `https://${data.host}`
    this.hostCache.set(collection, host)
    return host
  }

  private async dataRequest<T>(
    collection: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const host = await this.getHost(collection)
    const url = `${host}${path}`
    const res = await this.fetchFn(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (res.status === 404) {
      return { status: 404, data: undefined as T }
    }

    const data = (await res.json()) as T

    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null && 'message' in data
          ? String((data as Record<string, unknown>)['message'])
          : `Pinecone data request failed: ${res.status}`
      throw new Error(message)
    }

    return { status: res.status, data }
  }

  // --- Collection lifecycle ---

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    const metric = METRIC_MAP[config.metric ?? 'cosine']

    interface CreateResult {
      host?: string
    }

    const { data } = await this.controlRequest<CreateResult>(
      'POST',
      '/indexes',
      {
        name,
        dimension: config.dimensions,
        metric,
        spec: {
          serverless: {
            cloud: this.cloud,
            region: this.region,
          },
        },
      },
    )

    if (data?.host) {
      this.hostCache.set(name, `https://${data.host}`)
    }
  }

  async deleteCollection(name: string): Promise<void> {
    await this.controlRequest(
      'DELETE',
      `/indexes/${encodeURIComponent(name)}`,
    )
    this.hostCache.delete(name)
  }

  async listCollections(): Promise<string[]> {
    interface ListResult {
      indexes?: Array<{ name: string }>
    }
    const { data } = await this.controlRequest<ListResult>('GET', '/indexes')
    return (data.indexes ?? []).map((idx) => idx.name)
  }

  async collectionExists(name: string): Promise<boolean> {
    const { status } = await this.controlRequest(
      'GET',
      `/indexes/${encodeURIComponent(name)}`,
    )
    return status !== 404
  }

  // --- Vector operations ---

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const vectors = entries.map((e) => ({
      id: e.id,
      values: e.vector,
      metadata: {
        ...e.metadata,
        ...(e.text !== undefined ? { text: e.text } : {}),
      },
    }))

    await this.dataRequest(collection, 'POST', '/vectors/upsert', { vectors })
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorSearchResult[]> {
    const body: Record<string, unknown> = {
      vector: query.vector,
      topK: query.limit,
      includeMetadata: query.includeMetadata !== false,
      includeValues: query.includeVectors === true,
    }

    if (query.filter) {
      body['filter'] = translateFilter(query.filter)
    }

    interface SearchResult {
      matches?: Array<{
        id: string
        score: number
        metadata?: Record<string, unknown>
        values?: number[]
      }>
    }

    const { data } = await this.dataRequest<SearchResult>(
      collection,
      'POST',
      '/query',
      body,
    )

    const matches = data.matches ?? []

    return matches
      .filter((m) => query.minScore === undefined || m.score >= query.minScore)
      .map((m) => {
        const metadata = m.metadata ?? {}
        const text =
          typeof metadata['text'] === 'string' ? metadata['text'] : undefined
        const cleaned = { ...metadata }
        if (text !== undefined) {
          delete cleaned['text']
        }
        return {
          id: m.id,
          score: m.score,
          metadata: cleaned,
          ...(text !== undefined ? { text } : {}),
          ...(m.values ? { vector: m.values } : {}),
        }
      })
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    let body: Record<string, unknown>

    if ('ids' in filter) {
      body = { ids: filter.ids }
    } else {
      body = { filter: translateFilter(filter.filter) }
    }

    await this.dataRequest(collection, 'POST', '/vectors/delete', body)
  }

  async count(collection: string): Promise<number> {
    interface StatsResult {
      totalRecordCount?: number
      namespaces?: Record<string, { vectorCount?: number }>
    }

    const { data } = await this.dataRequest<StatsResult>(
      collection,
      'GET',
      '/describe_index_stats',
    )

    return data.totalRecordCount ?? 0
  }

  // --- Lifecycle ---

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.controlRequest('GET', '/indexes')
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
    this.hostCache.clear()
  }
}
