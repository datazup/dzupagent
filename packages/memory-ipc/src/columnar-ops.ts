/**
 * Columnar batch operations over Apache Arrow Tables conforming to MEMORY_FRAME_SCHEMA.
 *
 * All functions are pure, non-fatal (catch errors, return empty/default),
 * and handle empty tables gracefully.
 */

import { Table, tableFromArrays } from 'apache-arrow'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely read a numeric value from a column at a given row index.
 * Handles BigInt (Int64) by converting to Number, and returns the
 * provided default if the value is null/undefined.
 */
function readNum(
  table: Table,
  columnName: string,
  row: number,
  defaultValue: number,
): number {
  const col = table.getChild(columnName)
  if (!col) return defaultValue
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return defaultValue
  return typeof raw === 'bigint' ? Number(raw) : (raw as number)
}

/**
 * Safely read a string value from a column at a given row index.
 * Returns the provided default if the value is null/undefined.
 */
function readStr(
  table: Table,
  columnName: string,
  row: number,
  defaultValue: string | null = null,
): string | null {
  const col = table.getChild(columnName)
  if (!col) return defaultValue
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return defaultValue
  return String(raw)
}

/**
 * Build a new Table by selecting specific row indices from the source table.
 * Iterates each column, extracts values at the given indices, and reconstructs
 * the table via `tableFromArrays`.
 */
export function takeRows(table: Table, indices: number[]): Table {
  if (indices.length === 0 || table.numRows === 0) {
    // Return an empty table preserving column names
    const empty: Record<string, unknown[]> = {}
    for (const field of table.schema.fields) {
      empty[field.name] = []
    }
    return tableFromArrays(empty)
  }

  const data: Record<string, unknown[]> = {}
  for (const field of table.schema.fields) {
    const col = table.getChild(field.name)
    if (!col) {
      data[field.name] = indices.map(() => null)
      continue
    }
    data[field.name] = indices.map((i) => col.get(i) as unknown)
  }

  return tableFromArrays(data)
}

// ---------------------------------------------------------------------------
// 1. findWeakIndices
// ---------------------------------------------------------------------------

/**
 * Scan the `decay_strength` column and return row indices where the value
 * is below the given threshold. Null values are treated as NOT weak (they
 * indicate records without decay tracking).
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param threshold Strength threshold (default 0.1)
 * @returns Int32Array of row indices where decay_strength < threshold
 */
export function findWeakIndices(table: Table, threshold = 0.1): Int32Array {
  try {
    const col = table.getChild('decay_strength')
    if (!col) return new Int32Array(0)

    const results: number[] = []
    for (let i = 0; i < table.numRows; i++) {
      const val: unknown = col.get(i)
      if (val === null || val === undefined) continue
      const num = typeof val === 'bigint' ? Number(val) : (val as number)
      if (num < threshold) {
        results.push(i)
      }
    }
    return new Int32Array(results)
  } catch {
    return new Int32Array(0)
  }
}

// ---------------------------------------------------------------------------
// 2. batchDecayUpdate
// ---------------------------------------------------------------------------

/**
 * Compute updated decay strengths using the Ebbinghaus forgetting curve:
 *   strength = e^(-elapsed / halfLifeMs)
 * where elapsed = now - lastAccessedAt.
 *
 * Null `decay_half_life_ms` defaults to 86400000 (24h).
 * Null `decay_last_accessed_at` defaults to now (=> strength 1.0).
 * Missing columns => all strengths 1.0.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param now Current timestamp in epoch milliseconds
 * @returns Float64Array of new strength values per row
 */
export function batchDecayUpdate(table: Table, now: number): Float64Array {
  const len = table.numRows
  const result = new Float64Array(len)

  try {
    const DEFAULT_HALF_LIFE = 86400000 // 24h in ms

    for (let i = 0; i < len; i++) {
      const halfLife = readNum(table, 'decay_half_life_ms', i, DEFAULT_HALF_LIFE)
      const lastAccess = readNum(table, 'decay_last_accessed_at', i, now)
      const elapsed = now - lastAccess
      if (elapsed <= 0 || halfLife <= 0) {
        result[i] = 1.0
      } else {
        result[i] = Math.exp(-elapsed / halfLife)
      }
    }
  } catch {
    result.fill(1.0)
  }

  return result
}

// ---------------------------------------------------------------------------
// 3. temporalMask
// ---------------------------------------------------------------------------

/**
 * Create a bitmask for records matching a temporal query.
 *
 * - `asOf`: system time point. Record matches if system_created_at <= asOf
 *   AND (system_expired_at IS NULL OR system_expired_at > asOf).
 * - `validAt`: validity time point. Record matches if valid_from <= validAt
 *   AND (valid_until IS NULL OR valid_until > validAt).
 *
 * If both are provided, BOTH conditions must be satisfied.
 * If neither is provided, all records match.
 *
 * @returns Uint8Array bitmask (1=matches, 0=filtered)
 */
export function temporalMask(
  table: Table,
  query: { asOf?: number; validAt?: number },
): Uint8Array {
  const len = table.numRows
  const mask = new Uint8Array(len)

  try {
    mask.fill(1)

    if (query.asOf !== undefined) {
      const asOf = query.asOf
      for (let i = 0; i < len; i++) {
        if (mask[i] === 0) continue
        const created = readNum(table, 'system_created_at', i, 0)
        if (created > asOf) {
          mask[i] = 0
          continue
        }
        const expiredCol = table.getChild('system_expired_at')
        if (expiredCol) {
          const raw: unknown = expiredCol.get(i)
          if (raw !== null && raw !== undefined) {
            const expired = typeof raw === 'bigint' ? Number(raw) : (raw as number)
            if (expired <= asOf) {
              mask[i] = 0
            }
          }
        }
      }
    }

    if (query.validAt !== undefined) {
      const validAt = query.validAt
      for (let i = 0; i < len; i++) {
        if (mask[i] === 0) continue
        const validFrom = readNum(table, 'valid_from', i, 0)
        if (validFrom > validAt) {
          mask[i] = 0
          continue
        }
        const validUntilCol = table.getChild('valid_until')
        if (validUntilCol) {
          const raw: unknown = validUntilCol.get(i)
          if (raw !== null && raw !== undefined) {
            const until = typeof raw === 'bigint' ? Number(raw) : (raw as number)
            if (until <= validAt) {
              mask[i] = 0
            }
          }
        }
      }
    }
  } catch {
    mask.fill(0)
  }

  return mask
}

// ---------------------------------------------------------------------------
// 4. applyMask
// ---------------------------------------------------------------------------

/**
 * Filter a Table using a bitmask. Returns a new Table containing only
 * the rows where mask[i] === 1.
 *
 * @param table Source Arrow Table
 * @param mask Uint8Array bitmask (1=keep, 0=filter)
 * @returns New Table with only matching rows
 */
export function applyMask(table: Table, mask: Uint8Array): Table {
  try {
    const indices: number[] = []
    const limit = Math.min(mask.length, table.numRows)
    for (let i = 0; i < limit; i++) {
      if (mask[i]) {
        indices.push(i)
      }
    }
    return takeRows(table, indices)
  } catch {
    return takeRows(table, [])
  }
}

// ---------------------------------------------------------------------------
// 5. partitionByNamespace
// ---------------------------------------------------------------------------

/**
 * Group rows by the `namespace` column into separate Tables.
 *
 * @returns Map from namespace string to Table containing only rows with that namespace
 */
export function partitionByNamespace(table: Table): Map<string, Table> {
  const result = new Map<string, Table>()

  try {
    const col = table.getChild('namespace')
    if (!col || table.numRows === 0) return result

    const groups = new Map<string, number[]>()
    for (let i = 0; i < table.numRows; i++) {
      const ns = String(col.get(i) ?? 'unknown')
      let group = groups.get(ns)
      if (!group) {
        group = []
        groups.set(ns, group)
      }
      group.push(i)
    }

    for (const [ns, indices] of groups) {
      result.set(ns, takeRows(table, indices))
    }
  } catch {
    // Return empty map on error
  }

  return result
}

// ---------------------------------------------------------------------------
// 6. computeCompositeScore
// ---------------------------------------------------------------------------

/**
 * Compute a weighted combination of decay strength, importance, and recency.
 *
 *   score = w_decay * strength + w_importance * importance + w_recency * recency
 *   recency = 1 / (1 + ageHours)
 *   ageHours = (now - system_created_at) / 3600000
 *
 * Defaults: strength=1.0 if null, importance=0.5 if null.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param weights Weight coefficients for each scoring dimension
 * @param now Current timestamp in epoch milliseconds (default: Date.now())
 * @returns Float64Array of composite scores per row
 */
export function computeCompositeScore(
  table: Table,
  weights: { decay: number; importance: number; recency: number },
  now?: number,
): Float64Array {
  const len = table.numRows
  const scores = new Float64Array(len)

  try {
    const currentTime = now ?? Date.now()

    for (let i = 0; i < len; i++) {
      const strength = readNum(table, 'decay_strength', i, 1.0)
      const importance = readNum(table, 'importance', i, 0.5)
      const createdAt = readNum(table, 'system_created_at', i, currentTime)
      const ageHours = Math.max(0, (currentTime - createdAt) / 3600000)
      const recency = 1 / (1 + ageHours)

      scores[i] =
        weights.decay * strength +
        weights.importance * importance +
        weights.recency * recency
    }
  } catch {
    scores.fill(0)
  }

  return scores
}

// ---------------------------------------------------------------------------
// 7. batchTokenEstimate
// ---------------------------------------------------------------------------

/**
 * Estimate tokens per record from `text` and `payload_json` column lengths.
 *
 *   tokens = ceil((text.length + payload.length) / charsPerToken)
 *
 * Missing or null text/payload treated as empty string (0 chars).
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param charsPerToken Characters per token ratio (default 4)
 * @returns Int32Array of token estimates per row
 */
export function batchTokenEstimate(
  table: Table,
  charsPerToken = 4,
): Int32Array {
  const len = table.numRows
  const tokens = new Int32Array(len)

  try {
    const effectiveCpt = charsPerToken > 0 ? charsPerToken : 4

    for (let i = 0; i < len; i++) {
      const text = readStr(table, 'text', i, '') ?? ''
      const payload = readStr(table, 'payload_json', i, '') ?? ''
      const totalChars = text.length + payload.length
      tokens[i] = Math.ceil(totalChars / effectiveCpt)
    }
  } catch {
    // Return zeros on error
  }

  return tokens
}

// ---------------------------------------------------------------------------
// 8. selectByTokenBudget
// ---------------------------------------------------------------------------

/**
 * Greedy knapsack: pick the highest-scoring records that fit within a token budget.
 *
 * 1. Compute composite scores
 * 2. Compute token estimates
 * 3. Sort by score descending
 * 4. Greedily select until budget exhausted
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param budget Maximum total tokens to select
 * @param weights Scoring weights (default: decay=0.4, importance=0.3, recency=0.3)
 * @param charsPerToken Characters per token ratio (default 4)
 * @returns Filtered Table within budget
 */
export function selectByTokenBudget(
  table: Table,
  budget: number,
  weights?: { decay: number; importance: number; recency: number },
  charsPerToken?: number,
): Table {
  try {
    const effectiveWeights = weights ?? { decay: 0.4, importance: 0.3, recency: 0.3 }
    const scores = computeCompositeScore(table, effectiveWeights)
    const tokens = batchTokenEstimate(table, charsPerToken)

    // Create index array sorted by score descending
    const order: number[] = []
    for (let i = 0; i < table.numRows; i++) {
      order.push(i)
    }
    order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))

    // Greedy selection
    const selected: number[] = []
    let remaining = budget
    for (const idx of order) {
      const cost = tokens[idx] ?? 0
      if (cost <= remaining) {
        selected.push(idx)
        remaining -= cost
      }
    }

    // Sort selected indices to preserve original order
    selected.sort((a, b) => a - b)
    return takeRows(table, selected)
  } catch {
    return takeRows(table, [])
  }
}

// ---------------------------------------------------------------------------
// 9. rankByPageRank
// ---------------------------------------------------------------------------

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
    const entityRegex = /`([^`]+)`|(?<![a-zA-Z])([A-Z][a-z]+(?:[A-Z][a-z]*)+)(?![a-zA-Z])/g

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

// ---------------------------------------------------------------------------
// 10. applyHubDampeningBatch
// ---------------------------------------------------------------------------

/**
 * Logarithmic attenuation for over-accessed records (hub dampening).
 *
 *   dampened = score * (1 / (1 + log(1 + accessCount / threshold)))
 *
 * Reads `decay_access_count` from the table. Null access count treated as 0.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param scores Base scores to dampen
 * @param config Hub dampening configuration
 * @returns Float64Array of dampened scores
 */
export function applyHubDampeningBatch(
  table: Table,
  scores: Float64Array,
  config?: { accessThreshold?: number },
): Float64Array {
  const len = table.numRows
  const dampened = new Float64Array(len)

  try {
    const threshold = config?.accessThreshold ?? 10

    for (let i = 0; i < len; i++) {
      const accessCount = readNum(table, 'decay_access_count', i, 0)
      const score = i < scores.length ? (scores[i] ?? 0) : 0
      const dampeningFactor = 1 / (1 + Math.log(1 + accessCount / threshold))
      dampened[i] = score * dampeningFactor
    }
  } catch {
    // Return zeros on error
  }

  return dampened
}

// ---------------------------------------------------------------------------
// 11. batchCosineSimilarity
// ---------------------------------------------------------------------------

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
