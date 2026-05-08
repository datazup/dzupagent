/**
 * Shared helpers for the LanceDB adapter: schema seeding, metadata
 * flattening/extraction, distance-to-score conversion, and default URI
 * resolution.
 */

import type { DistanceMetric, VectorQuery, VectorSearchResult } from '../types.js'
import { RESERVED_COLUMNS, type LanceDBSearchResultRow } from './lancedb-adapter-types.js'

/** Default LanceDB URI based on platform */
export function defaultUri(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
  return `${home}/.dzupagent/lancedb`
}

/** Build a seed row with correct schema for initial table creation */
export function buildSeedRow(dimensions: number): Record<string, unknown> {
  return {
    id: '__seed__',
    vector: new Array<number>(dimensions).fill(0),
    text: '',
  }
}

/** Flatten metadata into top-level columns (LanceDB stores columns, not nested objects) */
export function flattenMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_COLUMNS.has(key)) continue
    // LanceDB supports primitive types and arrays natively
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (Array.isArray(value)) {
      // Store arrays as JSON strings for compatibility
      result[key] = JSON.stringify(value)
    } else if (value !== null && value !== undefined) {
      // Store complex objects as JSON strings
      result[key] = JSON.stringify(value)
    }
  }
  return result
}

/** Extract metadata fields from a LanceDB result row */
export function extractMetadata(row: LanceDBSearchResultRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (RESERVED_COLUMNS.has(key)) continue
    metadata[key] = value
  }
  return metadata
}

/** Convert a LanceDB distance to a similarity score (0-1 range, higher = more similar) */
export function distanceToScore(distance: number, metric: DistanceMetric): number {
  switch (metric) {
    case 'cosine':
      // LanceDB cosine distance is 1 - cosine_similarity
      return 1 - distance
    case 'euclidean':
      // Convert L2 distance to a 0-1 score (inverse relationship)
      return 1 / (1 + distance)
    case 'dot_product':
      // Dot product distance is negative inner product
      // Higher dot product = more similar, so negate the distance
      return -distance
  }
}

/**
 * Convert raw LanceDB search rows into the framework's {@link VectorSearchResult}
 * shape, applying minScore/includeMetadata/includeVectors options from the query.
 */
export function rowsToSearchResults(
  rows: LanceDBSearchResultRow[],
  query: VectorQuery,
  metric: DistanceMetric,
): VectorSearchResult[] {
  const results: VectorSearchResult[] = []
  for (const row of rows) {
    const score = distanceToScore(row._distance, metric)

    if (query.minScore !== undefined && score < query.minScore) {
      continue
    }

    const metadata = extractMetadata(row)
    const text = typeof row['text'] === 'string' && row['text'] !== '' ? row['text'] : undefined

    const result: VectorSearchResult = {
      id: String(row['id']),
      score,
      metadata: query.includeMetadata === false ? {} : metadata,
      ...(text != null ? { text } : {}),
    }

    if (query.includeVectors && Array.isArray(row['vector'])) {
      result.vector = row['vector'] as number[]
    }

    results.push(result)
  }

  return results
}
