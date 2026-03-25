/**
 * Generic memory service for LangGraph agents.
 *
 * Wraps a BaseStore with namespace-aware put/get/search operations and
 * a prompt-formatting helper. All operations are non-fatal — errors are
 * swallowed so that memory failures never break the agent pipeline.
 *
 * Usage:
 *   const svc = new MemoryService(store, [
 *     { name: 'decisions', scopeKeys: ['projectId', 'decisions'], searchable: false },
 *     { name: 'lessons',   scopeKeys: ['tenantId', 'lessons'],   searchable: true },
 *   ])
 *   await svc.put('decisions', { projectId: 'p1' }, 'feat-1', { ... })
 *   const records = await svc.get('decisions', { projectId: 'p1' })
 */
import type { BaseStore } from '@langchain/langgraph'
import type { NamespaceConfig, FormatOptions } from './memory-types.js'
import { sanitizeMemoryContent } from './memory-sanitizer.js'
import { scoreWithDecay } from './decay-engine.js'
import type { DecayMetadata } from './decay-engine.js'

export class MemoryService {
  private readonly nsMap: Map<string, NamespaceConfig>
  private readonly rejectUnsafe: boolean

  constructor(
    private readonly store: BaseStore,
    namespaces: NamespaceConfig[],
    options?: { rejectUnsafe?: boolean },
  ) {
    this.nsMap = new Map(namespaces.map(ns => [ns.name, ns]))
    this.rejectUnsafe = options?.rejectUnsafe ?? true
  }

  // ---------- Internals -------------------------------------------------------

  /**
   * Extract DecayMetadata from a record value if all required fields are present.
   * Returns null if the record does not carry decay metadata.
   */
  private extractDecayMeta(value: Record<string, unknown>): DecayMetadata | null {
    const decay = value['_decay']
    if (
      decay != null &&
      typeof decay === 'object' &&
      typeof (decay as Record<string, unknown>)['strength'] === 'number' &&
      typeof (decay as Record<string, unknown>)['lastAccessedAt'] === 'number' &&
      typeof (decay as Record<string, unknown>)['halfLifeMs'] === 'number' &&
      typeof (decay as Record<string, unknown>)['accessCount'] === 'number' &&
      typeof (decay as Record<string, unknown>)['createdAt'] === 'number'
    ) {
      return decay as DecayMetadata
    }
    return null
  }

  private getNamespace(name: string): NamespaceConfig {
    const ns = this.nsMap.get(name)
    if (!ns) throw new Error(`Unknown namespace: ${name}`)
    return ns
  }

  private buildNamespaceTuple(
    ns: NamespaceConfig,
    scope: Record<string, string>,
  ): string[] {
    return ns.scopeKeys.map(k => {
      const val = scope[k]
      if (!val) {
        throw new Error(`Missing scope key "${k}" for namespace "${ns.name}"`)
      }
      return val
    })
  }

  // ---------- Write -----------------------------------------------------------

  /**
   * Store a value under [namespace + scope] → key.
   *
   * When `rejectUnsafe` is true (default), values containing prompt-injection,
   * exfiltration commands, or invisible Unicode are silently rejected.
   * Non-fatal: errors are silently caught.
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (this.rejectUnsafe) {
      const textContent = typeof value['text'] === 'string'
        ? value['text']
        : JSON.stringify(value)
      const result = sanitizeMemoryContent(textContent)
      if (!result.safe) {
        // Silently reject — security violations should not surface to the LLM
        return
      }
    }

    const ns = this.getNamespace(namespace)
    const tuple = this.buildNamespaceTuple(ns, scope)
    try {
      // For searchable namespaces, ensure a "text" field exists in the value.
      // PostgresStore uses this field for embedding/indexing. Without it,
      // semantic search silently returns no results.
      let enriched = value
      if (ns.searchable && typeof value['text'] !== 'string') {
        enriched = { ...value, text: JSON.stringify(value) }
      }
      await this.store.put(
        tuple,
        key,
        enriched,
      )
    } catch {
      // Non-fatal — memory write failures should not break pipelines
    }
  }

  // ---------- Read ------------------------------------------------------------

  /**
   * Retrieve records from a namespace.
   * If `key` is provided, fetches that single item; otherwise lists all via search.
   * Non-fatal: returns [] on error.
   */
  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    const ns = this.getNamespace(namespace)
    const tuple = this.buildNamespaceTuple(ns, scope)
    try {
      if (key) {
        const item = await this.store.get(tuple, key)
        return item ? [item.value as Record<string, unknown>] : []
      }
      const items = await this.store.search(tuple)
      return items.map(i => i.value as Record<string, unknown>)
    } catch {
      return []
    }
  }

  /**
   * Semantic search within a searchable namespace.
   * Falls back to plain `get()` if the namespace is not marked searchable.
   * Non-fatal: returns [] on error.
   */
  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit = 5,
  ): Promise<Record<string, unknown>[]> {
    const ns = this.getNamespace(namespace)
    if (!ns.searchable) {
      return this.get(namespace, scope)
    }
    const tuple = this.buildNamespaceTuple(ns, scope)
    try {
      // Fetch extra results so decay re-ranking can still fill the limit
      const fetchLimit = Math.min(limit * 2, limit + 20)
      const results = await this.store.search(tuple, { query, limit: fetchLimit })

      // Apply decay scoring when records carry _decay metadata
      const now = Date.now()
      const scored = results.map((r, idx) => {
        const value = r.value as Record<string, unknown>
        const decayMeta = this.extractDecayMeta(value)
        // Use inverse rank as a proxy relevance score (1.0 for first result, decreasing)
        const relevance = 1 / (idx + 1)
        const finalScore = decayMeta
          ? scoreWithDecay(relevance, decayMeta, now)
          : relevance
        return { value, finalScore }
      })

      // Re-sort by decay-weighted score (descending) and trim to requested limit
      scored.sort((a, b) => b.finalScore - a.finalScore)
      return scored.slice(0, limit).map(s => s.value)
    } catch {
      return []
    }
  }

  // ---------- Formatting ------------------------------------------------------

  /**
   * Format an array of memory records into a prompt-ready string.
   * Returns '' if records is empty.
   */
  formatForPrompt(
    records: Record<string, unknown>[],
    options?: FormatOptions,
  ): string {
    if (records.length === 0) return ''

    const max = options?.maxItems ?? 10
    const maxChars = options?.maxCharsPerItem ?? 2000
    const header = options?.header ?? '## Context from Memory'

    const items = records.slice(0, max).map(r => {
      const text =
        typeof r['text'] === 'string' ? r['text'] : JSON.stringify(r)
      return text.length > maxChars ? text.slice(0, maxChars) + '...' : text
    })

    return `${header}\n\n${items.join('\n\n')}`
  }
}
