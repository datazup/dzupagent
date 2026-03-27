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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantScopedStoreConfig {
  /** Underlying store to wrap */
  store: BaseStore
  /** Tenant identifier (prefixed to all namespaces) */
  tenantId: string
  /** Optional additional prefix (e.g., project ID) */
  projectId?: string
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

  constructor(config: TenantScopedStoreConfig) {
    this.store = config.store
    this._tenantId = config.tenantId
    this._namespacePrefix = config.projectId
      ? [config.tenantId, config.projectId]
      : [config.tenantId]
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
    return item.value as Record<string, unknown>
  }

  /** Delete a value (auto-prefixed) */
  async delete(namespace: string[], key: string): Promise<void> {
    const prefixed = this.prefix(namespace)
    await this.store.delete(prefixed, key)
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

    const results = await this.store.search(prefixed, options)

    // Strip the prefix from result namespaces so consumers see local namespaces
    return results.map((item: { key: string; value: Record<string, unknown>; namespace?: string[] }) => ({
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
      return (storeAny['list'] as (ns: string[]) => Promise<string[]>)(prefixed)
    }

    // Fallback: use search to get keys
    if (typeof this.store.search === 'function') {
      const results = await this.store.search(prefixed, { limit: 1000 })
      return results.map((item: { key: string }) => item.key)
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
}
