/**
 * Lesson Deduplication (M4 Consolidation)
 *
 * Groups semantically similar lesson memories using Jaccard similarity on
 * token sets, then merges duplicates into a single consolidated lesson with
 * a count.  Entirely non-LLM — runs offline in O(n^2) time where n is
 * the number of lessons (acceptable for typical lesson counts < 200).
 *
 * Algorithm:
 *   1. Tokenize each lesson's text into a word set
 *   2. For each unprocessed lesson, find all others with Jaccard >= threshold
 *   3. Merge the group: pick the longest text as representative, accumulate
 *      the merged-key list and count
 *   4. Return the deduped set
 */
import type { MemoryEntry, LessonDedupResult, DedupLesson } from './consolidation-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default Jaccard threshold — 0.6 balances catching paraphrases vs. false positives. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.6

/**
 * Tokenize text into a set of lower-case words (alphanumeric only).
 * Strips punctuation and collapses whitespace.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1), // drop single chars
  )
}

/**
 * Jaccard similarity between two token sets.
 * Returns 1.0 when both sets are identical or both empty.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersectionSize = 0
  for (const word of a) {
    if (b.has(word)) intersectionSize++
  }
  const unionSize = a.size + b.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}

/**
 * Pick the best representative from a group of similar entries.
 * Prefers the longest text (most detailed), breaking ties by key order.
 */
function pickRepresentative(entries: MemoryEntry[]): MemoryEntry {
  let best = entries[0]!
  for (let i = 1; i < entries.length; i++) {
    const candidate = entries[i]!
    if (candidate.text.length > best.text.length) {
      best = candidate
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of lesson memories.
 *
 * Groups semantically similar lessons using Jaccard similarity on token sets,
 * picks the longest/most detailed entry as the representative, and returns
 * the deduped set with counts and merged keys.
 *
 * @param lessons  - Array of MemoryEntry objects (typically from the "lessons" namespace)
 * @param threshold - Jaccard similarity threshold (0-1, default: 0.6)
 * @returns LessonDedupResult with the deduplicated set
 */
export function dedupLessons(
  lessons: MemoryEntry[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): LessonDedupResult {
  if (lessons.length === 0) {
    return { deduplicated: [], removedCount: 0, inputCount: 0 }
  }

  // Pre-compute token sets
  const tokenSets = lessons.map(l => tokenize(l.text))

  // Track which indices have been consumed into a group
  const consumed = new Set<number>()
  const groups: DedupLesson[] = []

  for (let i = 0; i < lessons.length; i++) {
    if (consumed.has(i)) continue
    consumed.add(i)

    const tokI = tokenSets[i]!
    const group: MemoryEntry[] = [lessons[i]!]
    const mergedKeys: string[] = [lessons[i]!.key]

    // Find all similar entries
    for (let j = i + 1; j < lessons.length; j++) {
      if (consumed.has(j)) continue
      const tokJ = tokenSets[j]!
      const sim = jaccardSimilarity(tokI, tokJ)
      if (sim >= threshold) {
        consumed.add(j)
        group.push(lessons[j]!)
        mergedKeys.push(lessons[j]!.key)
      }
    }

    const representative = pickRepresentative(group)
    groups.push({
      entry: representative,
      count: group.length,
      mergedKeys,
    })
  }

  const removedCount = lessons.length - groups.length
  return {
    deduplicated: groups,
    removedCount,
    inputCount: lessons.length,
  }
}
