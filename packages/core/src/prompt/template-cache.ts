/**
 * TTL-based prompt template cache. Preloads templates in bulk to
 * avoid per-node DB queries during pipeline execution.
 */
import type { StoredTemplate, BulkPromptQuery } from './template-types.js'
import type { PromptStore } from './template-resolver.js'

export class PromptCache {
  private data: Map<string, StoredTemplate> = new Map()
  private loadedAt = 0
  private ttlMs: number

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  /** Check if the cache has expired */
  isExpired(): boolean {
    return this.data.size === 0 || Date.now() - this.loadedAt > this.ttlMs
  }

  /**
   * Build a cache key from type + category.
   * Keys: "type|category" for category-specific, "type|" for general fallback.
   */
  private key(type: string, category?: string): string {
    return `${type}|${category ?? ''}`
  }

  /** Get a cached template. Tries category-specific first, then general. */
  get(type: string, category?: string): StoredTemplate | null {
    if (this.isExpired()) return null

    if (category) {
      const specific = this.data.get(this.key(type, category))
      if (specific) return specific
    }

    return this.data.get(this.key(type)) ?? null
  }

  /** Set a template in the cache */
  set(type: string, category: string | undefined, template: StoredTemplate): void {
    this.data.set(this.key(type, category), template)
    // Also set as general fallback if no general entry exists
    const generalKey = this.key(type)
    if (!this.data.has(generalKey)) {
      this.data.set(generalKey, template)
    }
  }

  /** Number of cached entries */
  get size(): number {
    return this.data.size
  }

  /** Clear the cache */
  clear(): void {
    this.data.clear()
    this.loadedAt = 0
  }

  /**
   * Bulk-load templates from a PromptStore.
   * For each type+category combo, the highest-priority template wins.
   */
  async preload(store: PromptStore, query: BulkPromptQuery): Promise<void> {
    const templates = await store.findAllTemplates(query)

    this.data.clear()
    for (const t of templates) {
      // Category-specific key (first one wins — assumes results are priority-sorted)
      const catKey = this.key(t.type, t.category)
      if (!this.data.has(catKey)) {
        this.data.set(catKey, t)
      }
      // General fallback key
      const generalKey = this.key(t.type)
      if (!this.data.has(generalKey)) {
        this.data.set(generalKey, t)
      }
    }

    this.loadedAt = Date.now()
  }
}
