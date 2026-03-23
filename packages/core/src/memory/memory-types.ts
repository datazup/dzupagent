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

export interface FormatOptions {
  /** Maximum number of records to include */
  maxItems?: number
  /** Maximum characters per record before truncation */
  maxCharsPerItem?: number
  /** Header line prepended to the formatted output */
  header?: string
}
