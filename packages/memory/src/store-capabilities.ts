/**
 * Explicit capabilities for memory-store implementations.
 *
 * These flags let higher-level memory abstractions branch safely when a
 * backing store lacks delete, filter, or pagination support.
 */
import type { BaseStore } from '@langchain/langgraph'

export interface MemoryStoreCapabilities {
  supportsDelete: boolean
  supportsSearchFilters: boolean
  supportsPagination: boolean
}

export interface MemoryStoreWithCapabilities {
  capabilities?: MemoryStoreCapabilities | undefined
}

export const DEFAULT_MEMORY_STORE_CAPABILITIES: MemoryStoreCapabilities = {
  supportsDelete: true,
  supportsSearchFilters: true,
  supportsPagination: true,
}

export function normalizeMemoryStoreCapabilities(
  capabilities?: Partial<MemoryStoreCapabilities>,
): MemoryStoreCapabilities {
  return {
    supportsDelete: capabilities?.supportsDelete ?? DEFAULT_MEMORY_STORE_CAPABILITIES.supportsDelete,
    supportsSearchFilters: capabilities?.supportsSearchFilters ?? DEFAULT_MEMORY_STORE_CAPABILITIES.supportsSearchFilters,
    supportsPagination: capabilities?.supportsPagination ?? DEFAULT_MEMORY_STORE_CAPABILITIES.supportsPagination,
  }
}

export function getMemoryStoreCapabilities(
  store: BaseStore | MemoryStoreWithCapabilities,
): MemoryStoreCapabilities {
  const storeWithCapabilities = store as MemoryStoreWithCapabilities
  return normalizeMemoryStoreCapabilities(storeWithCapabilities.capabilities)
}

export function attachMemoryStoreCapabilities<T extends object>(
  store: T,
  capabilities?: Partial<MemoryStoreCapabilities>,
): T & { capabilities: MemoryStoreCapabilities } {
  return Object.assign(store, {
    capabilities: normalizeMemoryStoreCapabilities(capabilities),
  })
}
