/**
 * Utility functions for vector similarity and metadata filter evaluation.
 *
 * Used by InMemoryVectorStore for brute-force search and filter matching.
 * Can also be used by other adapters that need client-side filtering.
 */

import type { MetadataFilter } from './types.js'

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [-1, 1] for arbitrary vectors, or [0, 1] for non-negative vectors.
 * Identical normalized vectors yield 1.0; orthogonal vectors yield 0.0.
 *
 * @throws if vectors have different lengths or are zero-length
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${String(a.length)} vs ${String(b.length)}`,
    )
  }
  if (a.length === 0) {
    throw new Error('Cannot compute cosine similarity of zero-length vectors')
  }

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    magA += ai * ai
    magB += bi * bi
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB)
  if (magnitude === 0) return 0

  return dot / magnitude
}

/**
 * Evaluate a metadata filter against an entry's metadata.
 *
 * Supports all MetadataFilter operators:
 * - Comparison: eq, neq, gt, gte, lt, lte
 * - Set membership: in, not_in
 * - String: contains
 * - Boolean composition: and, or
 */
export function evaluateFilter(
  metadata: Record<string, unknown>,
  filter: MetadataFilter,
): boolean {
  // Boolean composition: and
  if ('and' in filter) {
    return filter.and.every((sub) => evaluateFilter(metadata, sub))
  }

  // Boolean composition: or
  if ('or' in filter) {
    return filter.or.some((sub) => evaluateFilter(metadata, sub))
  }

  // Field-level operators
  const { field, op, value } = filter
  const actual = metadata[field]

  switch (op) {
    case 'eq':
      return actual === value

    case 'neq':
      return actual !== value

    case 'gt':
      return typeof actual === 'number' && actual > value

    case 'gte':
      return typeof actual === 'number' && actual >= value

    case 'lt':
      return typeof actual === 'number' && actual < value

    case 'lte':
      return typeof actual === 'number' && actual <= value

    case 'in':
      return (value as (string | number)[]).includes(actual as string | number)

    case 'not_in':
      return !(value as (string | number)[]).includes(actual as string | number)

    case 'contains':
      return typeof actual === 'string' && actual.includes(value)

    default: {
      // Exhaustive check — should never reach here with valid MetadataFilter
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}
