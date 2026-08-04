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

/**
 * Hard ceiling on how many entries a single prune run will pull into memory.
 *
 * The capacity pass has to observe *more* than `maxEntries` rows before it can
 * evict anything, so the scan must be able to exceed `maxEntries` — but it must
 * still be bounded so a pathological store cannot OOM the pruner. Each run
 * therefore scans at most `DEFAULT_SCAN_MULTIPLIER * maxEntries` entries;
 * anything beyond that is handled by the next run.
 */
const DEFAULT_SCAN_MULTIPLIER = 10

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
  /**
   * Hard ceiling on the number of entries a single run pulls into memory.
   *
   * Must be `> maxEntries` for the capacity pass to be able to fire.
   * Defaults to `10 * maxEntries`.
   */
  maxScan?: number
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
    const maxScan =
      options.maxScan ?? Math.max(maxEntries + 1, maxEntries * DEFAULT_SCAN_MULTIPLIER)

    // AGENT-C-09: the scan MUST be able to exceed `maxEntries`, otherwise the
    // capacity pass below is structurally unreachable. A single
    // `search(ns, { limit: pageSize })` caps the result at 500 while
    // `maxEntries` defaults to 1000, so `survivors.length > maxEntries` could
    // never be true and the only global bound on the store was dead code.
    // We therefore page through the namespace up to `maxScan` entries.
    let items: ConsolidationStoreItem[]
    try {
      items = await scanNamespace(store, namespace, pageSize, maxScan)
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
 * Page through `namespace` in batches of `pageSize`, accumulating at most
 * `maxScan` entries.
 *
 * Stops early when a page comes back shorter than `pageSize` (store exhausted)
 * or when a page repeats the previous page's keys — the latter guards against
 * backends that ignore `offset`, which would otherwise spin forever.
 */
async function scanNamespace(
  store: MemoryStore,
  namespace: string[],
  pageSize: number,
  maxScan: number,
): Promise<ConsolidationStoreItem[]> {
  const collected: ConsolidationStoreItem[] = []
  const seen = new Set<string>()

  for (let offset = 0; collected.length < maxScan; offset += pageSize) {
    const remaining = maxScan - collected.length
    const limit = Math.min(pageSize, remaining)
    const page = await store.search(namespace, { limit, offset })
    if (page.length === 0) break

    let added = 0
    for (const item of page) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
      collected.push(item)
      added++
    }

    // Backend ignored `offset` (page is a duplicate of what we already have)
    // or the namespace is exhausted — either way, stop.
    if (added === 0 || page.length < limit) break
  }

  return collected
}

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
