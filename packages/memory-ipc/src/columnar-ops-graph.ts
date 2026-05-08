/**
 * Graph and similarity operations over Arrow Tables.
 *
 * - rankByPageRank: entity co-occurrence PageRank over the `text` column
 * - batchCosineSimilarity: cosine similarity between a query vector and an embedding column
 */

import { type Table } from 'apache-arrow'

import { readStr } from './columnar-ops-helpers.js'

/**
 * Entity co-occurrence PageRank.
 *
 * 1. Extract entities from `text` column (backtick-wrapped code and PascalCase words)
 * 2. Build adjacency: entities co-occurring in the same record share edges
 * 3. Run power iteration with damping
 * 4. Assign each row the max PageRank of its entities (or 0 if no entities)
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param config PageRank configuration
 * @returns Float64Array of PageRank scores per row
 */
export function rankByPageRank(
  table: Table,
  config?: { damping?: number; iterations?: number },
): Float64Array {
  const len = table.numRows
  const scores = new Float64Array(len)

  try {
    const damping = config?.damping ?? 0.85
    const iterations = config?.iterations ?? 20

    // Entity extraction regex: backtick-code OR PascalCase words (2+ capital letters)
    const entityRegex = /`([^`]+)`|(?<![a-zA-Z])([A-Z][a-z]+[A-Z][\w]*)(?![a-zA-Z])/g

    function extractEntities(text: string): Set<string> {
      const entities = new Set<string>()
      let match: RegExpExecArray | null
      entityRegex.lastIndex = 0
      while ((match = entityRegex.exec(text)) !== null) {
        const entity = match[1] ?? match[2]
        if (entity) entities.add(entity)
      }
      return entities
    }

    // Step 1: Extract entities per row
    const rowEntities: Set<string>[] = []
    const entityIndex = new Map<string, number>() // entity -> unique index
    const allEntities: string[] = []

    for (let i = 0; i < len; i++) {
      const text = readStr(table, 'text', i, '') ?? ''
      const entities = extractEntities(text)
      rowEntities.push(entities)
      for (const e of entities) {
        if (!entityIndex.has(e)) {
          entityIndex.set(e, allEntities.length)
          allEntities.push(e)
        }
      }
    }

    const n = allEntities.length
    if (n === 0) {
      // No entities found; all scores remain 0
      return scores
    }

    // Step 2: Build adjacency (co-occurrence)
    // adjacency[i] = set of entity indices that co-occur with entity i
    const adjacency: Set<number>[] = Array.from({ length: n }, () => new Set<number>())

    for (const entities of rowEntities) {
      const entityIndices = [...entities].map((e) => entityIndex.get(e)!).filter((v) => v !== undefined)
      for (let a = 0; a < entityIndices.length; a++) {
        for (let b = a + 1; b < entityIndices.length; b++) {
          const ai = entityIndices[a]!
          const bi = entityIndices[b]!
          adjacency[ai]!.add(bi)
          adjacency[bi]!.add(ai)
        }
      }
    }

    // Step 3: Power iteration
    let rank = new Float64Array(n).fill(1.0 / n)
    const base = (1 - damping) / n

    for (let iter = 0; iter < iterations; iter++) {
      const next = new Float64Array(n).fill(base)
      for (let i = 0; i < n; i++) {
        const neighbors = adjacency[i]!
        if (neighbors.size === 0) continue
        const share = (damping * (rank[i] ?? 0)) / neighbors.size
        for (const j of neighbors) {
          next[j] = (next[j] ?? 0) + share
        }
      }
      rank = next
    }

    // Step 4: Assign max entity PageRank to each row
    for (let i = 0; i < len; i++) {
      let maxRank = 0
      for (const e of rowEntities[i]!) {
        const idx = entityIndex.get(e)
        if (idx !== undefined) {
          const r = rank[idx] ?? 0
          if (r > maxRank) maxRank = r
        }
      }
      scores[i] = maxRank
    }
  } catch {
    scores.fill(0)
  }

  return scores
}

/**
 * Compute cosine similarity between a query embedding vector and an embedding
 * column in the table.
 *
 * Requires an optional embedding column (default name: 'embedding').
 * If the column does not exist or a row has no embedding, similarity is 0.
 *
 * @param table Arrow Table with optional embedding column
 * @param queryEmbedding Query vector as Float32Array
 * @param embeddingColumn Column name for embeddings (default 'embedding')
 * @returns Float64Array of cosine similarities per row
 */
export function batchCosineSimilarity(
  table: Table,
  queryEmbedding: Float32Array,
  embeddingColumn = 'embedding',
): Float64Array {
  const len = table.numRows
  const similarities = new Float64Array(len)

  try {
    const col = table.getChild(embeddingColumn)
    if (!col) return similarities

    // Pre-compute query magnitude
    let queryMag = 0
    for (let d = 0; d < queryEmbedding.length; d++) {
      queryMag += (queryEmbedding[d] ?? 0) * (queryEmbedding[d] ?? 0)
    }
    queryMag = Math.sqrt(queryMag)
    if (queryMag === 0) return similarities

    for (let i = 0; i < len; i++) {
      const embedding: unknown = col.get(i)
      if (embedding === null || embedding === undefined) continue

      // embedding can be a Float32Array, Array, or FixedSizeList vector
      let vec: ArrayLike<number>
      if (embedding instanceof Float32Array || embedding instanceof Float64Array || Array.isArray(embedding)) {
        vec = embedding
      } else if (typeof embedding === 'object' && 'toArray' in (embedding as Record<string, unknown>)) {
        vec = (embedding as { toArray(): number[] }).toArray()
      } else {
        continue
      }

      if (vec.length !== queryEmbedding.length) continue

      let dot = 0
      let rowMag = 0
      for (let d = 0; d < vec.length; d++) {
        const v = vec[d] ?? 0
        const q = queryEmbedding[d] ?? 0
        dot += v * q
        rowMag += v * v
      }
      rowMag = Math.sqrt(rowMag)

      if (rowMag === 0) continue
      similarities[i] = dot / (queryMag * rowMag)
    }
  } catch {
    // Return zeros on error
  }

  return similarities
}
