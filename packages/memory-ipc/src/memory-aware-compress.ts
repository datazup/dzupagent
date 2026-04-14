/**
 * Batch overlap analysis for memory-aware compression.
 *
 * Determines which candidate observations are novel vs duplicates of
 * existing memories using word-level Jaccard similarity. This prevents
 * storing redundant information and enables smarter context compression.
 */

import { type Table } from 'apache-arrow'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of batch overlap analysis. */
export interface OverlapAnalysis {
  /** Observations that do not significantly overlap with existing memories. */
  novel: Array<{ text: string; index: number }>
  /** Observations that overlap with existing memories above the threshold. */
  duplicate: Array<{
    text: string
    index: number
    existingRowIndex: number
    similarity: number
  }>
  /** Time taken for analysis in milliseconds. */
  analysisMs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into a set of lowercase words.
 * Strips punctuation and splits on whitespace.
 */
function tokenize(text: string): Set<string> {
  const words = new Set<string>()
  // Replace non-word chars (except apostrophes in contractions) with spaces, then split
  const cleaned = text.toLowerCase().replace(/[^\w']/g, ' ')
  const tokens = cleaned.split(/\s+/)
  for (const token of tokens) {
    const trimmed = token.replace(/^'+|'+$/g, '')
    if (trimmed.length > 0) {
      words.add(trimmed)
    }
  }
  return words
}

/**
 * Compute Jaccard similarity between two word sets.
 * Jaccard = |intersection| / |union|
 * Returns 0 if both sets are empty.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0

  let intersectionSize = 0
  // Iterate the smaller set for efficiency
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  for (const word of smaller) {
    if (larger.has(word)) {
      intersectionSize++
    }
  }

  const unionSize = a.size + b.size - intersectionSize
  if (unionSize === 0) return 0
  return intersectionSize / unionSize
}

// ---------------------------------------------------------------------------
// batchOverlapAnalysis
// ---------------------------------------------------------------------------

/**
 * Batch-analyze which observations overlap with existing memories.
 *
 * For each observation, tokenizes into a word set and computes Jaccard
 * similarity against every memory row's text. If the maximum similarity
 * exceeds the threshold, the observation is marked as duplicate.
 *
 * @param observations Array of observation strings to check
 * @param memoryTable  Arrow Table with existing memories (reads 'text' column)
 * @param threshold    Jaccard similarity threshold for duplicate detection (default 0.8)
 * @returns OverlapAnalysis with novel and duplicate classifications
 */
export function batchOverlapAnalysis(
  observations: string[],
  memoryTable: Table,
  threshold = 0.8,
): OverlapAnalysis {
  const start = performance.now()

  try {
    const novel: OverlapAnalysis['novel'] = []
    const duplicate: OverlapAnalysis['duplicate'] = []

    // Pre-tokenize all memory texts
    const memoryTokenSets: Array<{ wordSet: Set<string>; rowIndex: number }> = []
    const textCol = memoryTable.getChild('text')

    if (textCol) {
      for (let i = 0; i < memoryTable.numRows; i++) {
        const raw: unknown = textCol.get(i)
        if (raw === null || raw === undefined) continue
        const text = String(raw)
        if (text.length === 0) continue
        memoryTokenSets.push({ wordSet: tokenize(text), rowIndex: i })
      }
    }

    // Analyze each observation
    for (let obsIdx = 0; obsIdx < observations.length; obsIdx++) {
      const obsText = observations[obsIdx]
      if (obsText === undefined) continue

      // If no existing memories, everything is novel
      if (memoryTokenSets.length === 0) {
        novel.push({ text: obsText, index: obsIdx })
        continue
      }

      const obsWords = tokenize(obsText)

      // Find best matching memory
      let bestSimilarity = 0
      let bestRowIndex = -1

      for (const mem of memoryTokenSets) {
        const sim = jaccardSimilarity(obsWords, mem.wordSet)
        if (sim > bestSimilarity) {
          bestSimilarity = sim
          bestRowIndex = mem.rowIndex
        }
      }

      if (bestSimilarity >= threshold) {
        duplicate.push({
          text: obsText,
          index: obsIdx,
          existingRowIndex: bestRowIndex,
          similarity: bestSimilarity,
        })
      } else {
        novel.push({ text: obsText, index: obsIdx })
      }
    }

    const analysisMs = performance.now() - start
    return { novel, duplicate, analysisMs }
  } catch {
    const analysisMs = performance.now() - start
    // On error, treat all observations as novel (safe fallback)
    return {
      novel: observations.map((text, index) => ({ text, index })),
      duplicate: [],
      analysisMs,
    }
  }
}
