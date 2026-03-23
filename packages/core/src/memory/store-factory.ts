/**
 * Store factory — creates a LangGraph BaseStore from configuration.
 *
 * Currently supports PostgresStore via @langchain/langgraph-checkpoint-postgres.
 * The memory type is reserved for future in-memory testing implementations.
 */
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'
import type { BaseStore } from '@langchain/langgraph'

export interface StoreConfig {
  type: 'postgres' | 'memory'
  connectionString?: string
}

/**
 * Create and initialize a LangGraph store.
 *
 * For postgres: requires `connectionString`. Calls `setup()` to ensure tables exist.
 * For memory: not yet implemented — throws an error.
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

  throw new Error(`Store type "${config.type}" not yet implemented — use postgres`)
}
