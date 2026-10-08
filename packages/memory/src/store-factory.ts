/**
 * Store factory — creates a LangGraph BaseStore from configuration.
 *
 * Supports:
 * - `postgres`: PostgresStore via @langchain/langgraph-checkpoint-postgres
 * - `memory`: InMemoryBaseStore for development and testing (no database required),
 *   optionally bounded by `maxRecords` / `ttlMs`
 */
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'
import type { BaseStore } from '@langchain/langgraph'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import {
  attachMemoryStoreCapabilities,
  DEFAULT_MEMORY_STORE_CAPABILITIES,
  type MemoryStoreCapabilities,
} from './store-capabilities.js'

/**
 * Embedding index configuration for semantic search.
 *
 * When provided, the store will compute embeddings for specified fields
 * and enable vector similarity search via `store.search({ query })`.
 */
export interface StoreIndexConfig {
  /** Embedding model instance (e.g., OpenAIEmbeddings, VoyageEmbeddings) */
  embeddings: EmbeddingsInterface
  /** Embedding vector dimensions (must match the model output) */
  dims: number
  /** Fields in the stored value to embed (default: ["text"]) */
  fields?: string[] | undefined
}

export interface StoreConfig {
  type: 'postgres' | 'memory'
  connectionString?: string | undefined
  /** Optional embedding index config for semantic search */
  index?: StoreIndexConfig | undefined
  /** Explicit capability overrides for the returned store */
  capabilities?: Partial<MemoryStoreCapabilities> | undefined
  /**
   * In-memory store only: maximum number of records across all namespaces.
   * When a `put` exceeds it, the least-recently-written records are deleted.
   * Postgres rejects this option rather than ignoring it.
   */
  maxRecords?: number | undefined
  /**
   * In-memory store only: a record expires this many milliseconds after its
   * last write. Expired records are never returned and are physically
   * deleted. Postgres rejects this option rather than ignoring it.
   */
  ttlMs?: number | undefined
}

/**
 * Query options for InMemoryBaseStore.search().
 * Provides filter, text query, and pagination support.
 */
export interface StoreQueryOptions {
  /** Metadata field equality filters (AND semantics) */
  filter?: Record<string, unknown> | undefined
  /** Case-insensitive substring match against `text` or `content` fields */
  query?: string | undefined
  /** Maximum number of results to return */
  limit?: number | undefined
  /** Number of results to skip before returning */
  offset?: number | undefined
}

/**
 * Capabilities exposed by the in-memory store.
 */
export const IN_MEMORY_STORE_CAPABILITIES: MemoryStoreCapabilities = {
  ...DEFAULT_MEMORY_STORE_CAPABILITIES,
}

interface InMemoryEntry {
  value: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

interface InMemoryGrowthLimits {
  maxRecords?: number | undefined
  ttlMs?: number | undefined
}

function validateGrowthLimits(config: StoreConfig): void {
  const { maxRecords, ttlMs } = config
  if (maxRecords === undefined && ttlMs === undefined) return
  if (config.type !== 'memory') {
    throw new Error('maxRecords/ttlMs are supported only by the in-memory store')
  }
  if (maxRecords !== undefined && !(Number.isInteger(maxRecords) && maxRecords > 0)) {
    throw new Error(`maxRecords must be a positive integer, got ${String(maxRecords)}`)
  }
  if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs > 0)) {
    throw new Error(`ttlMs must be a positive finite number, got ${String(ttlMs)}`)
  }
}

/**
 * Minimal in-memory BaseStore for dev/test.
 * Implements the LangGraph BaseStore interface without any database.
 */
class InMemoryBaseStore {
  /**
   * Buckets keyed by `JSON.stringify(namespace)` — an injective encoding, so
   * `['a.b','c']` and `['a','b','c']` never share a bucket. The original
   * segment array is kept with the bucket and is never re-split from the key.
   */
  private data = new Map<string, {
    namespace: string[]
    entries: Map<string, InMemoryEntry>
  }>()
  /**
   * Every live record in write order (oldest first), keyed by
   * `JSON.stringify([nsKey, key])`. A rewrite moves the record to the end, so
   * the front is always the least-recently-written — the eviction and expiry
   * candidate.
   */
  private writeOrder = new Map<string, { nsKey: string; key: string; entry: InMemoryEntry }>()
  readonly capabilities = { ...DEFAULT_MEMORY_STORE_CAPABILITIES }
  readonly searchParity = 'limited' as const

  constructor(private readonly limits: InMemoryGrowthLimits = {}) {}

  /** Number of records physically held. */
  get size(): number {
    return this.writeOrder.size
  }

  async setup(): Promise<void> { /* no-op */ }

  async get(namespace: string[], key: string): Promise<InMemoryEntry | undefined> {
    this.sweepExpired()
    return this.data.get(JSON.stringify(namespace))?.entries.get(key)
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    this.sweepExpired()
    const nsKey = JSON.stringify(namespace)
    let bucket = this.data.get(nsKey)
    if (!bucket) {
      bucket = { namespace: [...namespace], entries: new Map() }
      this.data.set(nsKey, bucket)
    }
    const now = new Date()
    const entry = { value, createdAt: bucket.entries.get(key)?.createdAt ?? now, updatedAt: now }
    bucket.entries.set(key, entry)

    const orderKey = JSON.stringify([nsKey, key])
    this.writeOrder.delete(orderKey)
    this.writeOrder.set(orderKey, { nsKey, key, entry })

    const { maxRecords } = this.limits
    if (maxRecords !== undefined) {
      for (const [oldest, record] of this.writeOrder) {
        if (this.writeOrder.size <= maxRecords) break
        this.remove(oldest, record.nsKey, record.key)
      }
    }
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const nsKey = JSON.stringify(namespace)
    this.remove(JSON.stringify([nsKey, key]), nsKey, key)
  }

  /** Physically delete expired records. Write order is expiry order, so stop at the first live one. */
  private sweepExpired(): void {
    const { ttlMs } = this.limits
    if (ttlMs === undefined) return
    const cutoff = Date.now() - ttlMs
    for (const [orderKey, record] of this.writeOrder) {
      if (record.entry.updatedAt.getTime() > cutoff) break
      this.remove(orderKey, record.nsKey, record.key)
    }
  }

  private remove(orderKey: string, nsKey: string, key: string): void {
    this.writeOrder.delete(orderKey)
    const bucket = this.data.get(nsKey)
    if (!bucket) return
    bucket.entries.delete(key)
    if (bucket.entries.size === 0) this.data.delete(nsKey)
  }

  async search(
    namespacePrefix: string[],
    options?: StoreQueryOptions,
  ): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
    this.sweepExpired()
    let results: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }> = []

    for (const { namespace, entries } of this.data.values()) {
      // Segment-wise prefix match: `['t1']` must not match `['t10', ...]`.
      if (
        namespacePrefix.length <= namespace.length &&
        namespacePrefix.every((segment, i) => namespace[i] === segment)
      ) {
        for (const [key, entry] of entries) {
          results.push({ namespace: [...namespace], key, value: entry.value })
        }
      }
    }

    // Apply metadata field equality filters (AND semantics)
    if (options?.filter) {
      const filterEntries = Object.entries(options.filter)
      results = results.filter(r =>
        filterEntries.every(([field, expected]) => r.value[field] === expected),
      )
    }

    // Apply case-insensitive substring text query against `text` or `content` fields
    if (options?.query) {
      const q = options.query.toLowerCase()
      results = results.filter(r => {
        const text = r.value['text']
        const content = r.value['content']
        if (typeof text === 'string' && text.toLowerCase().includes(q)) return true
        if (typeof content === 'string' && content.toLowerCase().includes(q)) return true
        return false
      })
    }

    // Apply pagination
    if (options?.offset) {
      results = results.slice(options.offset)
    }
    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit)
    }

    return results
  }

  /** Clear all data (for test teardown) */
  clear(): void {
    this.data.clear()
    this.writeOrder.clear()
  }
}

/**
 * Create and initialize a LangGraph store.
 *
 * For postgres: requires `connectionString`. Calls `setup()` to ensure tables exist.
 * For memory: returns an InMemoryBaseStore (no database required).
 */
export async function createStore(config: StoreConfig): Promise<BaseStore> {
  validateGrowthLimits(config)

  if (config.type === 'postgres') {
    if (!config.connectionString) {
      throw new Error('connectionString required for postgres store')
    }
    const indexConfig = config.index
      ? {
          dims: config.index.dims,
          embed: config.index.embeddings,
          fields: config.index.fields ?? ['text'],
        }
      : undefined
    const store = PostgresStore.fromConnString(
      config.connectionString,
      indexConfig ? { index: indexConfig } : undefined,
    )
    await store.setup()
    return attachMemoryStoreCapabilities(store as BaseStore, config.capabilities)
  }

  if (config.type === 'memory') {
    const store = new InMemoryBaseStore({ maxRecords: config.maxRecords, ttlMs: config.ttlMs })
    await store.setup()
    return attachMemoryStoreCapabilities(store as unknown as BaseStore, config.capabilities)
  }

  throw new Error(`Unknown store type: ${String(config.type)}`)
}

// Store shutdown lives in `store-lifecycle.ts` so that `MemoryService` can
// import it without dragging the Postgres driver into every consumer bundle.
export { closeMemoryStore } from './store-lifecycle.js'
