/**
 * Type definitions for the generic memory service.
 *
 * NamespaceConfig describes a scoped memory partition (e.g. "lessons", "decisions").
 * FormatOptions controls how stored records are serialized into prompt text.
 */

export interface NamespaceConfig {
  /** Unique name for this namespace (e.g. "lessons", "decisions") */
  name: string
  /** Ordered list of scope keys used to build the store tuple (e.g. ["tenantId", "lessons"]) */
  scopeKeys: string[]
  /** Whether this namespace supports semantic search (requires embedding config on the store) */
  searchable?: boolean | undefined
  /** Optional TTL in milliseconds — not enforced by the store, but available for eviction logic */
  ttlMs?: number | undefined
}

/** Configuration for Ebbinghaus forgetting curve decay on a namespace */
export interface DecayConfig {
  /** Enable Ebbinghaus decay for this namespace (default: false) */
  enabled: boolean
  /** Minimum strength before memory is prunable (default: 0.1) */
  pruneThreshold?: number | undefined
}

export interface FormatOptions {
  /** Maximum number of records to include */
  maxItems?: number | undefined
  /** Maximum characters per record before truncation */
  maxCharsPerItem?: number | undefined
  /** Header line prepended to the formatted output */
  header?: string | undefined
}

/**
 * Normalized metadata filter accepted by {@link SemanticStoreAdapter.search}.
 *
 * Structurally identical to `@dzupagent/core`'s `MetadataFilter`, restated here
 * so `@dzupagent/memory` keeps zero dependency on the vectordb layer. A
 * `SemanticStore` from core therefore satisfies this interface unchanged.
 */
export type SemanticMetadataFilter =
  | { field: string; op: 'eq' | 'neq'; value: string | number | boolean }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { field: string; op: 'in' | 'not_in'; value: (string | number)[] }
  | { field: string; op: 'contains'; value: string }
  | { and: SemanticMetadataFilter[] }
  | { or: SemanticMetadataFilter[] }

/**
 * Minimal interface for a semantic store that MemoryService can use
 * for vector-backed search and auto-indexing.
 *
 * This is deliberately decoupled from @dzupagent/core's SemanticStore class
 * to avoid circular dependencies. Any object implementing this interface
 * (including SemanticStore) can be passed to MemoryService.
 */
export interface SemanticStoreAdapter {
  /**
   * Search a collection by text query, returning scored documents.
   *
   * `filter` is a tenant/scope restriction and is NOT optional in effect:
   * `MemoryService` always passes the same scope the keyword channel is
   * bound to. An adapter that ignores it re-opens the cross-tenant leak
   * this parameter exists to close.
   */
  search(
    collection: string,
    query: string,
    limit: number,
    filter?: SemanticMetadataFilter,
  ): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>>

  /** Upsert documents with automatic embedding */
  upsert(
    collection: string,
    docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  ): Promise<void>

  /** Delete documents by IDs or metadata filter */
  delete(
    collection: string,
    filter: { ids: string[] } | { filter: unknown },
  ): Promise<void>

  /** Ensure a collection exists */
  ensureCollection(
    collection: string,
    config?: { dimensions?: number; metric?: string; metadata?: Record<string, string> },
  ): Promise<void>
}
