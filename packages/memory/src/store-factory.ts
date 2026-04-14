/**
 * Store factory — creates a LangGraph BaseStore from configuration.
 *
 * Supports:
 * - `postgres`: PostgresStore via @langchain/langgraph-checkpoint-postgres
 * - `memory`: InMemoryBaseStore for development and testing (no database required)
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

/**
 * Minimal in-memory BaseStore for dev/test.
 * Implements the LangGraph BaseStore interface without any database.
 */
class InMemoryBaseStore {
  private data = new Map<string, Map<string, { value: Record<string, unknown>; createdAt: Date; updatedAt: Date }>>()
  readonly capabilities = { ...DEFAULT_MEMORY_STORE_CAPABILITIES }
  readonly searchParity = 'limited' as const

  async setup(): Promise<void> { /* no-op */ }

  async get(namespace: string[], key: string): Promise<{ value: Record<string, unknown> } | undefined> {
    const nsKey = namespace.join('.')
    return this.data.get(nsKey)?.get(key)
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const nsKey = namespace.join('.')
    if (!this.data.has(nsKey)) this.data.set(nsKey, new Map())
    const now = new Date()
    this.data.get(nsKey)!.set(key, { value, createdAt: now, updatedAt: now })
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const nsKey = namespace.join('.')
    this.data.get(nsKey)?.delete(key)
  }

  async search(
    namespacePrefix: string[],
    options?: StoreQueryOptions,
  ): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
    const prefix = namespacePrefix.join('.')
    let results: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }> = []

    for (const [nsKey, entries] of this.data) {
      if (nsKey.startsWith(prefix)) {
        for (const [key, entry] of entries) {
          results.push({ namespace: nsKey.split('.'), key, value: entry.value })
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
  }
}

/**
 * Create and initialize a LangGraph store.
 *
 * For postgres: requires `connectionString`. Calls `setup()` to ensure tables exist.
 * For memory: returns an InMemoryBaseStore (no database required).
 */
export async function createStore(config: StoreConfig): Promise<BaseStore> {
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
    const store = new InMemoryBaseStore()
    await store.setup()
    return attachMemoryStoreCapabilities(store as unknown as BaseStore, config.capabilities)
  }

  throw new Error(`Unknown store type: ${String(config.type)}`)
}
