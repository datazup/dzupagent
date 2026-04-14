/**
 * Ternary void filtering — classify retrieved memories into
 * active (+1), void (0), or inhibitory (-1) states.
 *
 * Zero LLM cost — pure algorithmic filtering based on score gaps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ternary memory state: active (+1), void (0), inhibitory (-1). */
export type MemoryState = 1 | 0 | -1

export interface VoidFilterConfig {
  /** Target fraction of candidates to suppress as void. @default 0.30 */
  targetVoidFraction?: number | undefined
  /** Minimum score gap to consider for the void boundary. @default 0.05 */
  minScoreGap?: number | undefined
  /** Don't filter if fewer candidates than this. @default 3 */
  minCandidates?: number | undefined
}

export interface VoidFilterResult<T> {
  active: T[]
  void: T[]
  inhibitory: T[]
  /** Actual fraction of candidates classified as void. */
  voidFraction: number
  /** Score at which the void zone starts (inclusive lower bound of active). */
  boundaryScore: number
}

interface ScoredCandidate {
  key: string
  score: number
  value: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_VOID_FRACTION = 0.30
const DEFAULT_MIN_SCORE_GAP = 0.05
const DEFAULT_MIN_CANDIDATES = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a candidate carries contradiction / supersession metadata. */
function isInhibitory(value: Record<string, unknown>): boolean {
  return (
    '_contradicts' in value && value['_contradicts'] != null ||
    '_supersededBy' in value && value['_supersededBy'] != null
  )
}

/**
 * Find the index of the largest score gap that exceeds `minGap`.
 * Returns -1 if no gap exceeds the threshold.
 * `sorted` must be descending by score.
 */
function findLargestGapIndex(sorted: readonly ScoredCandidate[], minGap: number): number {
  let bestIdx = -1
  let bestGap = -Infinity

  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i]!.score - sorted[i + 1]!.score
    if (gap >= minGap && gap > bestGap) {
      bestGap = gap
      bestIdx = i
    }
  }

  return bestIdx
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify retrieved memories into active / void / inhibitory states.
 *
 * Algorithm:
 * 1. Sort candidates by score descending.
 * 2. Find the largest score gap — everything below is "void".
 * 3. If the void fraction is below `targetVoidFraction`, extend the void zone
 *    downward by percentile until the target is met.
 * 4. Among the active set, reclassify candidates with `_contradicts` or
 *    `_supersededBy` metadata as inhibitory.
 */
export function voidFilter<T extends ScoredCandidate>(
  candidates: T[],
  config?: VoidFilterConfig,
): VoidFilterResult<T> {
  const targetVoid = config?.targetVoidFraction ?? DEFAULT_TARGET_VOID_FRACTION
  const minGap = config?.minScoreGap ?? DEFAULT_MIN_SCORE_GAP
  const minCandidates = config?.minCandidates ?? DEFAULT_MIN_CANDIDATES

  // --- Trivial / degenerate cases -------------------------------------------

  if (candidates.length < minCandidates) {
    return {
      active: [...candidates],
      void: [],
      inhibitory: [],
      voidFraction: 0,
      boundaryScore: candidates.length > 0 ? candidates[candidates.length - 1]!.score : 0,
    }
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score)

  // All scores identical — nothing to filter.
  const allSame = sorted[0]!.score === sorted[sorted.length - 1]!.score
  if (allSame) {
    return {
      active: sorted,
      void: [],
      inhibitory: [],
      voidFraction: 0,
      boundaryScore: sorted[0]!.score,
    }
  }

  // --- Determine void boundary ----------------------------------------------

  let boundaryIdx: number // last index that is still active (inclusive)

  const gapIdx = findLargestGapIndex(sorted, minGap)

  if (gapIdx >= 0) {
    boundaryIdx = gapIdx
  } else {
    // No significant gap found — fall back to percentile cutoff.
    boundaryIdx = Math.max(0, Math.ceil(sorted.length * (1 - targetVoid)) - 1)
  }

  // If void fraction is still below target, move the boundary up.
  const voidCount = sorted.length - (boundaryIdx + 1)
  const currentFraction = voidCount / sorted.length

  if (currentFraction < targetVoid) {
    const desiredActive = Math.max(1, Math.ceil(sorted.length * (1 - targetVoid)))
    boundaryIdx = desiredActive - 1
  }

  // --- Partition into active / void -----------------------------------------

  const rawActive = sorted.slice(0, boundaryIdx + 1)
  const voidItems = sorted.slice(boundaryIdx + 1)

  // --- Separate inhibitory from active --------------------------------------

  const active: T[] = []
  const inhibitory: T[] = []

  for (const item of rawActive) {
    if (isInhibitory(item.value)) {
      inhibitory.push(item)
    } else {
      active.push(item)
    }
  }

  const boundaryScore =
    boundaryIdx < sorted.length - 1
      ? sorted[boundaryIdx + 1]!.score
      : sorted[sorted.length - 1]!.score

  return {
    active,
    void: voidItems,
    inhibitory,
    voidFraction: voidItems.length / sorted.length,
    boundaryScore,
  }
}
