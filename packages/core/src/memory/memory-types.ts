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
  searchable?: boolean
  /** Optional TTL in milliseconds — not enforced by the store, but available for eviction logic */
  ttlMs?: number
}

/** Configuration for Ebbinghaus forgetting curve decay on a namespace */
export interface DecayConfig {
  /** Enable Ebbinghaus decay for this namespace (default: false) */
  enabled: boolean
  /** Minimum strength before memory is prunable (default: 0.1) */
  pruneThreshold?: number
}

export interface FormatOptions {
  /** Maximum number of records to include */
  maxItems?: number
  /** Maximum characters per record before truncation */
  maxCharsPerItem?: number
  /** Header line prepended to the formatted output */
  header?: string
}
