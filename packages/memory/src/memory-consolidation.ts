/**
 * Memory consolidation -- 4-phase cycle inspired by Claude Code's "dream" pattern.
 *
 * Periodically consolidates accumulated memories (lessons, decisions, conventions)
 * to prevent bloat, deduplicate entries, and maintain high retrieval quality.
 *
 * Phases:
 *   1. Orient  -- list existing memories in a namespace
 *   2. Gather  -- identify new entries since last consolidation
 *   3. Consolidate -- merge duplicates, resolve contradictions
 *   4. Prune   -- remove stale or low-value entries
 */
import type { BaseStore } from '@langchain/langgraph'
import { namespaceUnder } from './namespace-match.js'

export interface ConsolidationConfig {
  /** Max entries to keep per namespace after pruning */
  maxEntries?: number | undefined
  /** Entries older than this (ms) are candidates for pruning */
  maxAgeMs?: number | undefined
}

export interface ConsolidationResult {
  namespace: string[]
  before: number
  after: number
  merged: number
  pruned: number
}

const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface ParsedEntry {
  /** The entry's own stored namespace — the delete target. */
  namespace: string[]
  key: string
  value: Record<string, unknown>
  text: string
  timestamp: string
  createdAt: string
}

/**
 * Run the 4-phase consolidation cycle on a single namespace.
 */
export async function consolidateNamespace(
  store: BaseStore,
  namespace: string[],
  config: ConsolidationConfig = {},
): Promise<ConsolidationResult> {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = Date.now()

  // Phase 1: Orient -- load all entries
  //
  // Segment-exact scope (MC-05b): Postgres `search` is a string `LIKE` prefix
  // on the `:`-joined path, so `['memories', 't1']` also returns rows stored
  // under `['memories', 't10']`. Only items whose own `namespace` is the
  // prefix or a descendant of it are considered; an item without a
  // `namespace` is ignored (fail closed) and never deleted.
  const items = (await store.search(namespace, { limit: 200 }))
    .filter(item => namespaceUnder(item, namespace))
  const before = items.length

  if (before === 0) {
    return { namespace, before: 0, after: 0, merged: 0, pruned: 0 }
  }

  // Phase 2: Gather -- parse entries with text field for dedup
  const entries: ParsedEntry[] = items.map(item => {
    const val = item.value as Record<string, unknown>
    return {
      namespace: [...item.namespace],
      key: item.key,
      value: val,
      text: typeof val['text'] === 'string' ? val['text'] : '',
      timestamp: typeof val['timestamp'] === 'string' ? val['timestamp'] : '',
      createdAt: item.createdAt instanceof Date
        ? item.createdAt.toISOString()
        : String(item.createdAt ?? ''),
    }
  })

  // Phase 3: Consolidate -- deduplicate by text similarity.
  // Entries are keyed by record identity (namespace plus key), and every
  // delete targets the entry's own namespace, never the scan prefix.
  const seen = new Map<string, ParsedEntry>()
  let merged = 0

  for (const entry of entries) {
    const entryId = recordIdentity(entry)
    const normalized = entry.text.toLowerCase().trim().replace(/\s+/g, ' ')
    if (!normalized) {
      seen.set(entryId, entry)
      continue
    }

    // Check for near-duplicates (same first 100 chars = likely duplicate)
    const prefix = normalized.slice(0, 100)
    let isDuplicate = false

    for (const [existingKey, existing] of seen) {
      const existingNorm = existing.text.toLowerCase().trim().replace(/\s+/g, ' ')
      const existingPrefix = existingNorm.slice(0, 100)

      if (prefix === existingPrefix || normalized === existingNorm) {
        // Keep the newer one, delete the older
        const entryTime = getEntryTime(entry)
        const existingTime = getEntryTime(existing)

        if (entryTime > existingTime) {
          // New entry is newer -- replace
          seen.delete(existingKey)
          seen.set(entryId, entry)
          await store.delete(existing.namespace, existing.key)
        } else {
          // Existing is newer -- delete this one
          await store.delete(entry.namespace, entry.key)
        }
        merged++
        isDuplicate = true
        break
      }
    }

    if (!isDuplicate) {
      seen.set(entryId, entry)
    }
  }

  // Phase 4: Prune -- remove old entries if over limit
  let pruned = 0
  const remaining = [...seen.values()]

  // Sort by timestamp (newest first)
  remaining.sort((a, b) => getEntryTime(b) - getEntryTime(a))

  // Prune entries that exceed maxEntries
  if (remaining.length > maxEntries) {
    const toPrune = remaining.slice(maxEntries)
    for (const entry of toPrune) {
      await store.delete(entry.namespace, entry.key)
      pruned++
    }
  }

  // Prune entries older than maxAgeMs (only among those kept within limit)
  for (const entry of remaining.slice(0, maxEntries)) {
    const entryTime = getEntryTime(entry)
    if (entryTime > 0 && now - entryTime > maxAgeMs) {
      await store.delete(entry.namespace, entry.key)
      pruned++
    }
  }

  const after = Math.max(0, before - merged - pruned)
  return { namespace, before, after, merged, pruned }
}

/**
 * Consolidate multiple namespaces (convenience wrapper).
 */
export async function consolidateAll(
  store: BaseStore,
  namespaces: string[][],
  config: ConsolidationConfig = {},
): Promise<ConsolidationResult[]> {
  const results: ConsolidationResult[] = []
  for (const ns of namespaces) {
    results.push(await consolidateNamespace(store, ns, config))
  }
  return results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Record identity is namespace plus key; JSON keeps the encoding injective. */
function recordIdentity(entry: ParsedEntry): string {
  return JSON.stringify([entry.namespace, entry.key])
}

function getEntryTime(entry: ParsedEntry): number {
  const ts = entry.timestamp || entry.createdAt
  if (!ts) return 0
  const parsed = new Date(ts).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}
