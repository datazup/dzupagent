/**
 * TenantScopedStore — namespace isolation for multi-tenant learning.
 *
 * Wraps a BaseStore with automatic tenant namespace prefixing so that
 * one tenant's learned skills, rules, and lessons never leak to another.
 * All operations are transparently scoped to the tenant.
 *
 * Example:
 *   const scoped = new TenantScopedStore({ store, tenantId: 'tenant-123' })
 *   await scoped.put(['lessons'], 'key', value)
 *   // stores under ['tenant-123', 'lessons'] in the underlying store
 */
import type { BaseStore } from '@langchain/langgraph'
import {
  getMemoryStoreCapabilities,
  type MemoryStoreCapabilities,
} from './store-capabilities.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantScopedStoreConfig {
  /** Underlying store to wrap */
  store: BaseStore
  /** Tenant identifier (prefixed to all namespaces) */
  tenantId: string
  /** Optional additional prefix (e.g., project ID) */
  projectId?: string | undefined
}

/** Result from a search operation, with namespace relative to the tenant scope */
export interface TenantSearchResult {
  key: string
  value: Record<string, unknown>
  namespace: string[]
}

// ---------------------------------------------------------------------------
// TenantScopedStore
// ---------------------------------------------------------------------------

export class TenantScopedStore {
  private readonly store: BaseStore
  private readonly _tenantId: string
  private readonly _namespacePrefix: string[]
  private readonly capabilities: MemoryStoreCapabilities

  constructor(config: TenantScopedStoreConfig) {
    this.store = config.store
    this._tenantId = config.tenantId
    this._namespacePrefix = config.projectId
      ? [config.tenantId, config.projectId]
      : [config.tenantId]
    this.capabilities = getMemoryStoreCapabilities(config.store)
  }

  /** Get the tenant ID this store is scoped to */
  get tenantId(): string {
    return this._tenantId
  }

  /** Get the full namespace prefix applied to all operations */
  get namespacePrefix(): string[] {
    return [...this._namespacePrefix]
  }

  /** Get the underlying (unwrapped) store */
  get unwrapped(): BaseStore {
    return this.store
  }

  // ---------- Core CRUD operations -------------------------------------------

  /** Put a value (auto-prefixed) */
  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const prefixed = this.prefix(namespace)
    await this.store.put(prefixed, key, value)
  }

  /** Get a value (auto-prefixed) */
  async get(namespace: string[], key: string): Promise<Record<string, unknown> | undefined> {
    const prefixed = this.prefix(namespace)
    const item = await this.store.get(prefixed, key)
    if (!item) return undefined
    return isTombstoneRecord(item.value as Record<string, unknown>)
      ? undefined
      : (item.value as Record<string, unknown>)
  }

  /** Delete a value (auto-prefixed) */
  async delete(namespace: string[], key: string): Promise<void> {
    const prefixed = this.prefix(namespace)
    if (this.capabilities.supportsDelete) {
      await this.store.delete(prefixed, key)
      return
    }

    // Soft-delete when the backing store cannot guarantee delete support.
    // Consumers filter tombstones out of get/search/list results.
    await this.store.put(prefixed, key, createTombstoneRecord())
  }

  /** Search (auto-prefixed) — delegates to underlying store.search() */
  async search(
    namespace: string[],
    options?: { query?: string; limit?: number; filter?: Record<string, unknown> },
  ): Promise<TenantSearchResult[]> {
    const prefixed = this.prefix(namespace)

    // Graceful degradation: if underlying store lacks search, return empty
    if (typeof this.store.search !== 'function') {
      return []
    }

    const searchOptions: { query?: string; limit?: number; filter?: Record<string, unknown> } | undefined = (() => {
      if (!options) return undefined

      const searchOptions: {
        query?: string
        limit?: number
        filter?: Record<string, unknown>
      } = {}

      if (options.query !== undefined) {
        searchOptions.query = options.query
      }

      if (this.capabilities.supportsPagination && options.limit !== undefined) {
        searchOptions.limit = options.limit
      }

      if (this.capabilities.supportsSearchFilters && options.filter !== undefined) {
        searchOptions.filter = options.filter
      }

      return Object.keys(searchOptions).length > 0 ? searchOptions : undefined
    })()

    const results = await this.store.search(prefixed, searchOptions)
    const filtered = this.capabilities.supportsSearchFilters || options?.filter === undefined
      ? results
      : results.filter((item: { value: Record<string, unknown> }) =>
          matchesFilter(item.value, options.filter ?? {}))

    // Strip the prefix from result namespaces so consumers see local namespaces
    return filtered
      .filter((item: { value: Record<string, unknown> }) => !isTombstoneRecord(item.value))
      .slice(0, options?.limit ?? Number.POSITIVE_INFINITY)
      .map((item: { key: string; value: Record<string, unknown>; namespace?: string[] }) => ({
      key: item.key,
      value: item.value as Record<string, unknown>,
      namespace: this.stripPrefix(item.namespace ?? prefixed),
      }))
  }

  /** List all keys in a namespace (auto-prefixed) */
  async list(namespace: string[]): Promise<string[]> {
    const prefixed = this.prefix(namespace)

    // Graceful degradation: if underlying store lacks list, fall back to search
    const storeAny = this.store as unknown as Record<string, unknown>
    if (typeof storeAny['list'] === 'function') {
      const keys = await (storeAny['list'] as (ns: string[]) => Promise<string[]>)(prefixed)
      return this.filterVisibleKeys(prefixed, keys)
    }

    // Fallback: use search to get keys
    if (typeof this.store.search === 'function') {
      const results = await this.store.search(
        prefixed,
        this.capabilities.supportsPagination ? { limit: 1000 } : undefined,
      )
      return this.filterVisibleKeys(
        prefixed,
        results.map((item: { key: string; value: Record<string, unknown> }) => item.key),
      )
    }

    return []
  }

  // ---------- Scoping --------------------------------------------------------

  /**
   * Create a further-scoped store (e.g., for project isolation within a tenant).
   * Returns a new TenantScopedStore with additional prefix.
   */
  scope(additionalPrefix: string): TenantScopedStore {
    // Build a new store that wraps the same underlying store but with extended prefix.
    // We use a thin approach: create a new TenantScopedStore where the tenantId
    // stays the same but we reconstruct the prefix manually.
    const scoped = new TenantScopedStore({
      store: this.store,
      tenantId: this._tenantId,
    })
    // Override the private prefix with our extended prefix
    ;(scoped as unknown as { _namespacePrefix: string[] })._namespacePrefix = [
      ...this._namespacePrefix,
      additionalPrefix,
    ]
    return scoped
  }

  // ---------- Internal -------------------------------------------------------

  /** Prepend the tenant namespace prefix to a namespace */
  private prefix(namespace: string[]): string[] {
    return [...this._namespacePrefix, ...namespace]
  }

  /** Strip the tenant namespace prefix from a namespace */
  private stripPrefix(namespace: string[]): string[] {
    const prefixLen = this._namespacePrefix.length
    // Verify the prefix actually matches before stripping
    const matches = this._namespacePrefix.every(
      (segment, i) => namespace[i] === segment,
    )
    if (matches && namespace.length >= prefixLen) {
      return namespace.slice(prefixLen)
    }
    // If prefix doesn't match, return as-is (defensive)
    return namespace
  }

  private async filterVisibleKeys(prefixed: string[], keys: string[]): Promise<string[]> {
    const visible: string[] = []
    for (const key of keys) {
      const record = await this.store.get(prefixed, key)
      if (!record || isTombstoneRecord(record.value as Record<string, unknown>)) {
        continue
      }
      visible.push(key)
    }
    return visible
  }
}

function isTombstoneRecord(value: Record<string, unknown> | undefined): boolean {
  return value != null && value['_tombstone'] === true
}

function createTombstoneRecord(): Record<string, unknown> {
  return {
    _tombstone: true,
    _deletedAt: new Date().toISOString(),
  }
}

function matchesFilter(
  value: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (value[key] !== expected) {
      return false
    }
  }
  return true
}
