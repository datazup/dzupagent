/**
 * ConsolidationEngine — clusters memory entries by key prefix and writes
 * a single summary entry per cluster, accelerating decay on the children.
 *
 * Strategy (no embeddings, no network calls):
 *   1. Fetch all entries in `(scope, namespace)` from the backing store.
 *   2. Group entries by the leading segment of `key` (segment delimiter ":").
 *   3. For each cluster of >= MIN_CLUSTER_SIZE entries:
 *        - If `llmJudge` is supplied, ask it for a summary.
 *        - Otherwise join the entries' textual content with `\n---\n`.
 *      Write the summary as `${prefix}:__summary__` and rewrite each child
 *      with strength=0.1 so the decay engine collects them quickly.
 *   4. Return how many entries were summarised plus a provenance map.
 *
 * The engine is a non-fatal best-effort operation — failures of individual
 * cluster writes are swallowed so a single bad cluster never aborts the run.
 *
 * Exported for memory-policy hosts (e.g. team runtimes' `consolidateOnComplete`
 * policy) and for opt-in finalisers in long-running agent loops.
 */

import type { MemoryEntry } from './consolidation-types.js'
import { parseMemoryEntry } from './consolidation-types.js'

/** Minimum number of entries in a cluster before consolidation runs. */
const MIN_CLUSTER_SIZE = 3

/** Strength stamped onto consolidated children so decay collects them quickly. */
const CHILD_STRENGTH = 0.1

/** Default search ceiling — large enough for typical sessions, bounded so OOM is impossible. */
const DEFAULT_SEARCH_LIMIT = 500

/**
 * Item record returned by the underlying store on `search`/`get`.
 *
 * Mirrors the shape of `Item` from `@langchain/langgraph` without taking a
 * hard dependency on it — any structurally compatible store works.
 */
export interface ConsolidationStoreItem {
  key: string
  value: Record<string, unknown>
  createdAt?: Date | string | number | undefined
}

/**
 * Minimal store contract consumed by `ConsolidationEngine` and `MemoryPruner`.
 *
 * Compatible with `BaseStore` from `@langchain/langgraph` — every method
 * matches that class's signatures exactly. We declare the shape here so the
 * engine remains transport-agnostic.
 */
export interface ConsolidationStore {
  search(
    namespacePrefix: string[],
    options?: { query?: string; limit?: number; offset?: number },
  ): Promise<ConsolidationStoreItem[]>
  put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>
  delete(namespace: string[], key: string): Promise<void>
}

/** Per-run consolidation summary returned to the caller. */
export interface ConsolidationResult {
  /** Total entries that were rolled into summaries (i.e. cluster children). */
  summarized: number
  /** Keys of the summary entries written by this run. */
  summaries: string[]
  /** Map from each summary key to the list of child keys that were summarised. */
  provenance: Record<string, string[]>
  /** Wall-clock duration of the consolidation pass in milliseconds. */
  durationMs: number
}

/** Optional dependency injection for the engine. */
export interface ConsolidationEngineConfig {
  /**
   * Optional LLM-backed summariser. Receives a cluster of entries and
   * returns the rolled-up summary text. When omitted, the engine falls
   * back to a deterministic `\n---\n` join.
   */
  llmJudge?: (entries: MemoryEntry[]) => Promise<string>
  /** Max records per `search()` call; defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  searchLimit?: number
  /** Override the cluster size threshold (default 3). */
  minClusterSize?: number
}

/**
 * ConsolidationEngine — see file header for strategy details.
 *
 * Construct once and call `consolidate(scope, namespace, store)` for each
 * `(scope, namespace)` pair you want to consolidate. Safe to reuse across
 * concurrent calls because the engine carries no per-run mutable state.
 */
export class ConsolidationEngine {
  private readonly llmJudge: ((entries: MemoryEntry[]) => Promise<string>) | undefined
  private readonly searchLimit: number
  private readonly minClusterSize: number

  constructor(config: ConsolidationEngineConfig = {}) {
    this.llmJudge = config.llmJudge
    this.searchLimit = config.searchLimit ?? DEFAULT_SEARCH_LIMIT
    this.minClusterSize = config.minClusterSize ?? MIN_CLUSTER_SIZE
  }

  /**
   * Run a consolidation pass over `(scope, namespace)`.
   *
   * Returns a {@link ConsolidationResult} describing how many children were
   * folded into summaries, the keys of the summary entries written, and a
   * provenance map for downstream auditing.
   *
   * Non-fatal: individual cluster failures are caught so a single bad
   * cluster never aborts the entire pass.
   */
  async consolidate(
    scope: string,
    namespace: string,
    store: ConsolidationStore,
  ): Promise<ConsolidationResult> {
    const startedAt = Date.now()
    const namespaceTuple: string[] = [scope, namespace]
    const summaries: string[] = []
    const provenance: Record<string, string[]> = {}
    let summarized = 0

    let items: ConsolidationStoreItem[]
    try {
      items = await store.search(namespaceTuple, { limit: this.searchLimit })
    } catch {
      // Empty / unsupported store → return a zero result rather than throwing.
      return {
        summarized: 0,
        summaries: [],
        provenance: {},
        durationMs: Date.now() - startedAt,
      }
    }

    if (items.length === 0) {
      return {
        summarized: 0,
        summaries: [],
        provenance: {},
        durationMs: Date.now() - startedAt,
      }
    }

    // Skip already-written summary entries and children that have already
    // been folded into a summary — both prevent recursive consolidation.
    const candidates = items.filter(
      (item) => !isSummaryKey(item.key) && !isAlreadyConsolidated(item.value),
    )

    const clusters = clusterByPrefix(candidates)

    for (const [prefix, clusterItems] of clusters) {
      if (clusterItems.length < this.minClusterSize) continue

      const entries: MemoryEntry[] = clusterItems.map((item) =>
        parseMemoryEntry(item.key, item.value),
      )

      let summaryText: string
      try {
        summaryText = this.llmJudge
          ? await this.llmJudge(entries)
          : entries.map((e) => e.text).join('\n---\n')
      } catch {
        // LLM judge failures are non-fatal — fall back to a join.
        summaryText = entries.map((e) => e.text).join('\n---\n')
      }

      const summaryKey = `${prefix}:__summary__`
      const childKeys = entries.map((e) => e.key)
      const now = Date.now()

      try {
        await store.put(namespaceTuple, summaryKey, {
          text: summaryText,
          kind: 'summary',
          consolidatedFrom: childKeys,
          createdAt: now,
          // The summary itself enters with full strength so it is retained.
          _decay: {
            strength: 1,
            accessCount: 0,
            lastAccessedAt: now,
            createdAt: now,
            halfLifeMs: 24 * 60 * 60 * 1000,
          },
        })
        summaries.push(summaryKey)
        provenance[summaryKey] = childKeys
        summarized += childKeys.length
      } catch {
        // Failing to write the summary means children stay untouched —
        // skip the cluster rather than orphaning records.
        continue
      }

      // Mark each child with low strength so the decay engine prunes it
      // promptly. We rewrite the existing record so callers that filter by
      // strength see consolidated children disappear from search results.
      for (const item of clusterItems) {
        try {
          const existing = item.value
          const halfLifeMs =
            getNumber(existing, ['_decay', 'halfLifeMs']) ?? 24 * 60 * 60 * 1000
          const accessCount =
            getNumber(existing, ['_decay', 'accessCount']) ?? 0
          const createdAt =
            getNumber(existing, ['_decay', 'createdAt']) ?? now
          await store.put(namespaceTuple, item.key, {
            ...existing,
            consolidatedInto: summaryKey,
            _decay: {
              strength: CHILD_STRENGTH,
              accessCount,
              lastAccessedAt: now,
              createdAt,
              halfLifeMs,
            },
          })
        } catch {
          // Non-fatal — provenance still points to the original key.
        }
      }
    }

    return {
      summarized,
      summaries,
      provenance,
      durationMs: Date.now() - startedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group items by the leading `:`-delimited segment of their key.
 *
 * `task:1`, `task:2`, `task:3` → cluster `task`.
 * Keys without a delimiter form their own single-item cluster keyed by the
 * full key (and therefore won't pass the cluster-size threshold by default).
 */
function clusterByPrefix(
  items: ConsolidationStoreItem[],
): Map<string, ConsolidationStoreItem[]> {
  const groups = new Map<string, ConsolidationStoreItem[]>()
  for (const item of items) {
    const prefix = extractPrefix(item.key)
    const bucket = groups.get(prefix)
    if (bucket) {
      bucket.push(item)
    } else {
      groups.set(prefix, [item])
    }
  }
  return groups
}

function extractPrefix(key: string): string {
  const colonIdx = key.indexOf(':')
  if (colonIdx <= 0) return key
  return key.slice(0, colonIdx)
}

function isSummaryKey(key: string): boolean {
  return key.endsWith(':__summary__')
}

function isAlreadyConsolidated(value: Record<string, unknown>): boolean {
  return typeof value['consolidatedInto'] === 'string'
}

/** Safe number coercion via a shallow path; returns undefined on shape mismatch. */
function getNumber(
  value: Record<string, unknown>,
  path: [string, string],
): number | undefined {
  const inner = value[path[0]]
  if (inner == null || typeof inner !== 'object') return undefined
  const leaf = (inner as Record<string, unknown>)[path[1]]
  return typeof leaf === 'number' ? leaf : undefined
}
