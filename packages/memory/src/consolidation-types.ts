/**
 * Shared types for M4 consolidation features: lesson dedup, convention
 * extraction from memories, and staleness pruning.
 *
 * These types describe the minimal shape of a memory record that the
 * consolidation functions consume. They intentionally mirror the store's
 * `Record<string, unknown>` shape with well-typed optional fields so
 * callers can pass raw store results without manual mapping.
 */

import type { DecayMetadata } from './decay-engine.js'

/**
 * A lightweight representation of a memory record for consolidation.
 *
 * `key`  — unique identifier in the store
 * `text` — primary textual content (the store's "text" field)
 *
 * Optional metadata is used by individual consolidation strategies.
 */
export interface MemoryEntry {
  /** Store key (unique per namespace) */
  key: string
  /** Primary text content */
  text: string
  /** Decay metadata (from `_decay` field), when present */
  decay?: DecayMetadata
  /** Whether the entry is pinned (immune to pruning) */
  pinned?: boolean
  /** Importance score 0-1, if assigned */
  importance?: number
  /** Epoch-ms timestamp of creation */
  createdAt?: number
  /** Epoch-ms timestamp of last access */
  lastAccessedAt?: number
  /** Number of times the entry was accessed */
  accessCount?: number
  /** Original raw value from the store, preserved for pass-through */
  raw?: Record<string, unknown>
}

/**
 * Result of a deduplication pass on lesson memories.
 */
export interface LessonDedupResult {
  /** Deduplicated lessons */
  deduplicated: DedupLesson[]
  /** Number of duplicates removed */
  removedCount: number
  /** Total input entries */
  inputCount: number
}

/**
 * A deduplicated lesson: the merged representative plus a count of how
 * many original entries were folded into it.
 */
export interface DedupLesson {
  /** Representative entry (kept) */
  entry: MemoryEntry
  /** Number of originals merged (>= 1) */
  count: number
  /** Keys of all originals that were merged into this entry */
  mergedKeys: string[]
}

/**
 * Result of a staleness pruning pass.
 */
export interface StalenessPruneResult {
  /** Entries that should be pruned */
  pruned: MemoryEntry[]
  /** Entries that survived */
  kept: MemoryEntry[]
  /** Number of entries pruned */
  prunedCount: number
}

/**
 * A convention extracted from recurring memory patterns.
 */
export interface ExtractedConvention {
  /** Auto-generated id */
  id: string
  /** Short name of the convention */
  name: string
  /** Category (naming, api, structure, etc.) */
  category: string
  /** Human-readable description */
  description: string
  /** Representative example texts */
  examples: string[]
  /** Number of memories exhibiting this pattern */
  occurrences: number
  /** Confidence 0-1 */
  confidence: number
  /** Keys of the source memories */
  sourceKeys: string[]
}

/**
 * Result of convention extraction from memories.
 */
export interface ConventionExtractionResult {
  /** Extracted conventions */
  conventions: ExtractedConvention[]
  /** Number of memories analyzed */
  memoriesAnalyzed: number
}

/**
 * Parse a raw store record into a MemoryEntry.
 * Extracts well-known fields from the generic `Record<string, unknown>`.
 */
export function parseMemoryEntry(key: string, value: Record<string, unknown>): MemoryEntry {
  const text = typeof value['text'] === 'string' ? value['text'] : JSON.stringify(value)

  const decayRaw = value['_decay']
  let decay: DecayMetadata | undefined
  if (decayRaw != null && typeof decayRaw === 'object') {
    const d = decayRaw as Record<string, unknown>
    if (
      typeof d['strength'] === 'number' &&
      typeof d['accessCount'] === 'number' &&
      typeof d['lastAccessedAt'] === 'number' &&
      typeof d['createdAt'] === 'number' &&
      typeof d['halfLifeMs'] === 'number'
    ) {
      decay = d as unknown as DecayMetadata
    }
  }

  return {
    key,
    text,
    decay,
    pinned: typeof value['pinned'] === 'boolean' ? value['pinned'] : undefined,
    importance: typeof value['importance'] === 'number' ? value['importance'] : undefined,
    createdAt: decay?.createdAt ?? (typeof value['createdAt'] === 'number' ? value['createdAt'] : undefined),
    lastAccessedAt: decay?.lastAccessedAt ?? (typeof value['lastAccessedAt'] === 'number' ? value['lastAccessedAt'] : undefined),
    accessCount: decay?.accessCount ?? (typeof value['accessCount'] === 'number' ? value['accessCount'] : undefined),
    raw: value,
  }
}
