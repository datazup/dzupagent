/**
 * Shared text similarity helpers for memory pipelines.
 *
 * Centralizes tokenization + Jaccard semantics to avoid behavioral drift
 * across lesson/rule/skill dedup paths.
 */

export interface TokenizeTextOptions {
  /** Minimum token length to keep (default: 2). */
  minTokenLength?: number | undefined
}

/** Tokenize text into a set of lower-case words. */
export function tokenizeText(text: string, options?: TokenizeTextOptions): Set<string> {
  const minTokenLength = options?.minTokenLength ?? 2
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= minTokenLength),
  )
}

/** Jaccard similarity between two token sets. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersectionSize = 0
  for (const token of a) {
    if (b.has(token)) intersectionSize++
  }
  const unionSize = a.size + b.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}
