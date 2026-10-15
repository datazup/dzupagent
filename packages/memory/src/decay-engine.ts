/**
 * Ebbinghaus forgetting curve decay engine for memory records.
 *
 * Implements exponential decay with spaced-repetition reinforcement:
 *   strength = storedStrength * e^(-elapsed / halfLife)
 *
 * Each access doubles the half-life (up to MAX_HALF_LIFE), so frequently
 * retrieved memories persist longer — mirroring human memory consolidation.
 */

/**
 * Memory record metadata for decay tracking.
 * These fields should be stored alongside the record's data.
 */
export interface DecayMetadata {
  /** Memory strength 0-1 (1 = fresh/strong, 0 = forgotten) */
  strength: number
  /** Number of times this memory has been accessed */
  accessCount: number
  /** Timestamp of last access (ms since epoch) */
  lastAccessedAt: number
  /** Timestamp of creation (ms since epoch) */
  createdAt: number
  /** Half-life in ms -- doubles with each reinforcement (spaced repetition) */
  halfLifeMs: number
}

/** Default half-life: 24 hours */
const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60 * 1000

/** Maximum half-life: 30 days */
const MAX_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

/** Default strength threshold for weak-memory pruning */
const DEFAULT_PRUNE_THRESHOLD = 0.1

/**
 * Calculate current memory strength using exponential decay.
 * Formula: strength = baseStrength * e^(-elapsed / halfLife)
 *
 * `baseStrength` is the stored `meta.strength` — the strength the record had
 * at `lastAccessedAt` (1 after a reinforcement, the importance weight for a
 * fresh record, 0.1 for a consolidated child). A missing or non-finite stored
 * strength reads as 1; out-of-range values are clamped into [0, 1].
 *
 * Note: `halfLifeMs` is used as the e-folding time constant (strength falls
 * to 1/e, not 1/2, after one `halfLifeMs`); the Arrow `batchDecayUpdate`
 * path in `@dzupagent/memory-ipc` uses the same curve.
 */
export function calculateStrength(meta: DecayMetadata, now?: number): number {
  const currentTime = now ?? Date.now()
  const elapsed = Math.max(0, currentTime - meta.lastAccessedAt)
  const base = baseStrength(meta.strength)
  // Mirror columnar-ops-decay: a zero/negative/non-finite half-life would
  // produce NaN or 0-everywhere strengths and poison eviction ordering.
  if (!Number.isFinite(meta.halfLifeMs) || meta.halfLifeMs <= 0) {
    return elapsed <= 0 ? base : base * Math.exp(-elapsed / DEFAULT_HALF_LIFE_MS)
  }
  return base * Math.exp(-elapsed / meta.halfLifeMs)
}

/** Stored strength as a decay base: non-finite reads as 1, clamped to [0, 1]. */
function baseStrength(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return 1
  return Math.max(0, Math.min(1, stored))
}

/**
 * Reinforce a memory (access it) -- increases half-life via spaced repetition.
 * Each access doubles the half-life (up to MAX_HALF_LIFE).
 * Returns updated metadata with recalculated strength.
 */
export function reinforceMemory(meta: DecayMetadata): DecayMetadata {
  const now = Date.now()
  const newHalfLife = Math.min(meta.halfLifeMs * 2, MAX_HALF_LIFE_MS)
  return {
    ...meta,
    strength: 1,
    accessCount: meta.accessCount + 1,
    lastAccessedAt: now,
    halfLifeMs: newHalfLife,
  }
}

/**
 * Create initial decay metadata for a new memory record.
 *
 * When an `importance` value (0..1) is provided, the initial strength is
 * weighted by it so high-importance memories enter the system with more
 * durability. Importance defaults to 1 (full strength) when omitted.
 */
export function createDecayMetadata(opts?: { importance?: number }): DecayMetadata {
  const now = Date.now()
  const importance = Math.max(0, Math.min(1, opts?.importance ?? 1))
  return {
    strength: importance,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    halfLifeMs: DEFAULT_HALF_LIFE_MS,
  }
}

/**
 * Score memories for retrieval: combines relevance score with decay strength.
 * Formula: finalScore = relevance * strength
 */
export function scoreWithDecay(
  relevance: number,
  meta: DecayMetadata,
  now?: number,
): number {
  const strength = calculateStrength(meta, now)
  return relevance * strength
}

/**
 * Find memories below a strength threshold (candidates for pruning/consolidation).
 * Returns records sorted weakest-first.
 */
export function findWeakMemories(
  records: ReadonlyArray<{ meta: DecayMetadata; key: string }>,
  threshold: number = DEFAULT_PRUNE_THRESHOLD,
): Array<{ key: string; strength: number }> {
  const now = Date.now()
  const weak: Array<{ key: string; strength: number }> = []

  for (const record of records) {
    const strength = calculateStrength(record.meta, now)
    if (strength < threshold) {
      weak.push({ key: record.key, strength })
    }
  }

  weak.sort((a, b) => a.strength - b.strength)
  return weak
}
