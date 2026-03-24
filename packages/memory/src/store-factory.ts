/**
 * Store factory — creates a LangGraph BaseStore from configuration.
 *
 * Supports:
 * - `postgres`: PostgresStore via @langchain/langgraph-checkpoint-postgres
 * - `memory`: InMemoryBaseStore for development and testing (no database required)
 */
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'
import type { BaseStore } from '@langchain/langgraph'

export interface StoreConfig {
  type: 'postgres' | 'memory'
  connectionString?: string
}

/**
 * Minimal in-memory BaseStore for dev/test.
 * Implements the LangGraph BaseStore interface without any database.
 */
class InMemoryBaseStore {
  private data = new Map<string, Map<string, { value: Record<string, unknown>; createdAt: Date; updatedAt: Date }>>()

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

  async search(namespacePrefix: string[]): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
    const prefix = namespacePrefix.join('.')
    const results: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }> = []
    for (const [nsKey, entries] of this.data) {
      if (nsKey.startsWith(prefix)) {
        for (const [key, entry] of entries) {
          results.push({ namespace: nsKey.split('.'), key, value: entry.value })
        }
      }
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
    const store = PostgresStore.fromConnString(config.connectionString)
    await store.setup()
    return store
  }

  if (config.type === 'memory') {
    const store = new InMemoryBaseStore()
    await store.setup()
    return store as unknown as BaseStore
  }

  throw new Error(`Unknown store type: ${String(config.type)}`)
}
