/**
 * Staleness Pruner (M4 Consolidation)
 *
 * Scores memories by staleness and prunes those above a configurable
 * threshold.  Staleness is defined as:
 *
 *   staleness = age_days * (1 / access_count)
 *
 * High staleness = old + rarely accessed.  Memories marked as "pinned"
 * or with importance >= a configurable minimum are never pruned.
 *
 * Designed to run as part of the sleep consolidation cycle.
 */
import type { MemoryEntry, StalenessPruneResult } from './consolidation-types.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default staleness threshold — entries above this are pruned. */
const DEFAULT_MAX_STALENESS = 30

/** Default maximum age in days — entries older than this are always pruned (unless pinned). */
const DEFAULT_MAX_AGE_DAYS = 90

/** Default minimum importance that protects from pruning. */
const DEFAULT_IMPORTANCE_THRESHOLD = 0.8

/** One day in ms. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute the staleness score for a single memory entry.
 *
 * Formula: `age_days * (1 / max(access_count, 1))`
 *
 * A 30-day-old entry accessed 10 times has staleness 3.0.
 * A 30-day-old entry accessed once has staleness 30.0.
 *
 * Returns 0 for entries without age information.
 */
export function computeStaleness(entry: MemoryEntry, now?: number): number {
  const currentTime = now ?? Date.now()

  // Determine the earliest known timestamp
  const createdAt = entry.createdAt ?? entry.lastAccessedAt
  if (createdAt === undefined || createdAt <= 0) return 0

  const ageDays = Math.max(0, (currentTime - createdAt) / MS_PER_DAY)
  const accessCount = Math.max(1, entry.accessCount ?? 1)

  return ageDays * (1 / accessCount)
}

/**
 * Determine whether an entry is immune to pruning.
 *
 * An entry is protected if:
 *   - It is marked as `pinned`
 *   - Its `importance` score meets or exceeds the threshold
 */
function isProtected(entry: MemoryEntry, importanceThreshold: number): boolean {
  if (entry.pinned === true) return true
  if (entry.importance !== undefined && entry.importance >= importanceThreshold) return true
  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StalenessPrunerOptions {
  /** Staleness score above which entries are pruned (default: 30) */
  maxStaleness?: number
  /**
   * Absolute maximum age in days. Entries older than this are always
   * pruned regardless of access count (unless pinned/important).
   * Set to Infinity to disable. Default: 90.
   */
  maxAgeDays?: number
  /** Minimum importance score that protects an entry from pruning (default: 0.8) */
  importanceThreshold?: number
  /**
   * Maximum number of entries to prune in a single pass.
   * Useful for rate-limiting store deletes. Default: Infinity (no limit).
   */
  maxPruneCount?: number
  /** Override for "now" timestamp (ms). Useful in tests. */
  now?: number
}

/**
 * Prune stale memories from an array of entries.
 *
 * Entries are scored by staleness and pruned if they exceed the threshold.
 * Pinned entries and entries with high importance are never pruned.
 *
 * @param memories - Array of MemoryEntry objects to evaluate
 * @param options  - Pruning configuration
 * @returns StalenessPruneResult with pruned and kept lists
 */
export function pruneStaleMemories(
  memories: MemoryEntry[],
  options: StalenessPrunerOptions = {},
): StalenessPruneResult {
  const maxStaleness = options.maxStaleness ?? DEFAULT_MAX_STALENESS
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const importanceThreshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD
  const maxPruneCount = options.maxPruneCount ?? Infinity
  const now = options.now ?? Date.now()

  const pruned: MemoryEntry[] = []
  const kept: MemoryEntry[] = []

  // Score and sort by staleness (descending) so we prune the stalest first
  // when maxPruneCount is limited.
  const scored = memories.map(entry => ({
    entry,
    staleness: computeStaleness(entry, now),
    protected: isProtected(entry, importanceThreshold),
    ageDays: entry.createdAt ? Math.max(0, (now - entry.createdAt) / MS_PER_DAY) : 0,
  }))
  scored.sort((a, b) => b.staleness - a.staleness)

  let pruneCount = 0

  for (const item of scored) {
    if (item.protected) {
      kept.push(item.entry)
      continue
    }

    const shouldPrune =
      pruneCount < maxPruneCount &&
      (item.staleness > maxStaleness || item.ageDays > maxAgeDays)

    if (shouldPrune) {
      pruned.push(item.entry)
      pruneCount++
    } else {
      kept.push(item.entry)
    }
  }

  return {
    pruned,
    kept,
    prunedCount: pruned.length,
  }
}
