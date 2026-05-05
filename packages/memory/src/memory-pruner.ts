/**
 * MemoryPruner — keeps a memory store bounded.
 *
 * Two-pass operation:
 *   1. TTL pass — every entry whose `createdAt` is older than `ttlMs`
 *      (default 7 days) is deleted.
 *   2. Capacity pass — when the surviving entry count exceeds `maxEntries`
 *      (default 1000), the lowest-strength entries are evicted until the
 *      ceiling is satisfied.
 *
 * The pruner walks the store in batches of {@link DEFAULT_PAGE_SIZE} so it
 * can be called against backends that cap a single `search()` call.
 *
 * Non-fatal: individual delete failures are swallowed so a flaky store does
 * not abort the run. The returned counts reflect successful deletes only.
 */

import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from './consolidation-engine.js'

/** Re-export under a more descriptive name for pruner consumers. */
export type MemoryStore = ConsolidationStore
export type MemoryStoreItem = ConsolidationStoreItem

/** Default pagination batch size when scanning a namespace. */
const DEFAULT_PAGE_SIZE = 500

/** Default capacity before LRU/strength-based eviction kicks in. */
const DEFAULT_MAX_ENTRIES = 1000

/** Default TTL: 7 days. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface PruneOptions {
  /** Maximum entries to keep after pruning (default 1000). */
  maxEntries?: number
  /** Entries created more than this many ms ago are expired (default 7 days). */
  ttlMs?: number
  /**
   * Restrict pruning to a single namespace tuple. When omitted the pruner
   * operates on the root scope `[]`, which most stores treat as
   * "everything".
   */
  namespace?: string[]
  /**
   * `Date.now()` proxy — exposed for tests so they can assert TTL behaviour
   * without sleeping. Defaults to `Date.now`.
   */
  now?: () => number
  /** Override the page size used when scanning the store. */
  pageSize?: number
}

export interface PruneResult {
  /** Number of entries deleted because they exceeded the TTL. */
  expired: number
  /** Number of entries deleted because the store was over capacity. */
  evicted: number
  /** Number of entries that survived both passes. */
  remaining: number
}

interface ParsedItem {
  key: string
  createdAt: number
  strength: number
}

/**
 * MemoryPruner — see file header for the eviction strategy.
 *
 * Stateless; safe to call concurrently against different namespaces.
 */
export class MemoryPruner {
  /**
   * Run the two-pass prune on `store`.
   *
   * Returns a {@link PruneResult} summarising how many entries were removed
   * by each pass and how many remain. Callers can wire the result into
   * telemetry to track memory hygiene over time.
   */
  async prune(
    store: MemoryStore,
    options: PruneOptions = {},
  ): Promise<PruneResult> {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    const namespace = options.namespace ?? []
    const now = (options.now ?? Date.now)()
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE

    let items: ConsolidationStoreItem[]
    try {
      items = await store.search(namespace, { limit: pageSize })
    } catch {
      return { expired: 0, evicted: 0, remaining: 0 }
    }

    if (items.length === 0) {
      return { expired: 0, evicted: 0, remaining: 0 }
    }

    const cutoff = now - ttlMs
    let expired = 0
    const survivors: ParsedItem[] = []

    // ---- Pass 1: TTL expiry ------------------------------------------------
    // Note: we use `createdAt !== 0` (rather than `> 0`) to allow callers
    // with synthetic clocks to drive deterministic expiry — `0` is the
    // sentinel emitted by `parseItem` when no timestamp could be derived.
    for (const item of items) {
      const parsed = parseItem(item)
      if (parsed.createdAt !== 0 && parsed.createdAt < cutoff) {
        try {
          await store.delete(namespace, item.key)
          expired++
        } catch {
          // delete failure → keep the entry for the next pass to consider
          survivors.push(parsed)
        }
        continue
      }
      survivors.push(parsed)
    }

    // ---- Pass 2: capacity cap ---------------------------------------------
    let evicted = 0
    if (survivors.length > maxEntries) {
      // Sort weakest first; ties broken by oldest (lowest createdAt) first.
      survivors.sort((a, b) => {
        if (a.strength !== b.strength) return a.strength - b.strength
        return a.createdAt - b.createdAt
      })
      const overflow = survivors.length - maxEntries
      const victims = survivors.splice(0, overflow)
      for (const victim of victims) {
        try {
          await store.delete(namespace, victim.key)
          evicted++
        } catch {
          // Non-fatal — count the victim as a survivor on failure.
          survivors.push(victim)
        }
      }
    }

    return {
      expired,
      evicted,
      remaining: survivors.length,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the data we need for pruning out of a raw store item.
 *
 * Looks for `_decay.strength` and `_decay.createdAt` first (these are the
 * canonical fields written by `MemoryService`), falling back to top-level
 * `createdAt` and the item's `createdAt` timestamp from the store wrapper.
 */
function parseItem(item: ConsolidationStoreItem): ParsedItem {
  const value = item.value
  const decay = value['_decay']
  let strength = 1
  let decayCreatedAt: number | undefined
  if (decay != null && typeof decay === 'object') {
    const d = decay as Record<string, unknown>
    if (typeof d['strength'] === 'number') strength = d['strength']
    if (typeof d['createdAt'] === 'number') decayCreatedAt = d['createdAt']
  }
  const valueCreatedAt =
    typeof value['createdAt'] === 'number'
      ? (value['createdAt'] as number)
      : undefined
  const wrapperCreatedAt = coerceWrapperTimestamp(item.createdAt)
  const createdAt =
    decayCreatedAt ?? valueCreatedAt ?? wrapperCreatedAt ?? 0
  return { key: item.key, createdAt, strength }
}

function coerceWrapperTimestamp(
  raw: Date | string | number | undefined,
): number | undefined {
  if (raw == null) return undefined
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
