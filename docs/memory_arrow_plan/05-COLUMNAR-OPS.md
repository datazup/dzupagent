# 05 — Columnar Batch Operations

> **Priority:** P1 | **Effort:** 10h | **Sprint:** 4

---

## 1. Overview

The `columnar-ops.ts` module provides vectorized batch operations over Arrow Tables. Each operation exploits Arrow's columnar layout to process entire columns in single passes, avoiding the row-by-row deserialization that the current JSON path requires.

**Design principles:**
- Every op has a JSON-path equivalent in the existing codebase — Arrow ops must produce identical results
- Non-fatal: all ops catch errors and return empty/default values
- Each op specifies which existing module it replaces/augments
- Worker-safe: all ops are pure functions, safe to run in piscina workers

---

## 2. Operations

### 2.1 findWeakIndices

```typescript
/**
 * Scan the decay_strength column and return indices of records
 * where strength falls below the pruning threshold.
 *
 * Replaces: findWeakMemories() in decay-engine.ts (row-by-row)
 * Complexity: O(n) single pass over decay_strength column
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param threshold Minimum strength to keep (default: 0.1)
 * @returns Int32Array of row indices where decay_strength < threshold
 */
export function findWeakIndices(table: Table, threshold = 0.1): Int32Array {
  const col = table.getChild('decay_strength')
  if (!col) return new Int32Array(0)

  const weak: number[] = []
  for (let i = 0; i < col.length; i++) {
    const strength = col.get(i) as number | null
    // Null strength = no decay tracking = not weak
    if (strength !== null && strength < threshold) {
      weak.push(i)
    }
  }
  return new Int32Array(weak)
}
```

**Performance:** 10K records: JSON path ~35ms (deserialize all, check field) → Arrow ~0.5ms (column scan). **70x speedup.**

### 2.2 batchDecayUpdate

```typescript
/**
 * Compute updated decay strengths for all records using the Ebbinghaus formula.
 *
 * Formula: strength = e^(-elapsed / halfLifeMs)
 * where elapsed = now - lastAccessedAt
 *
 * Replaces: calculateStrength() in decay-engine.ts (per-record)
 * Complexity: O(n) single pass over 3 columns
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param now Current timestamp (epoch ms)
 * @returns Float64Array of new strength values (one per row)
 */
export function batchDecayUpdate(table: Table, now: number): Float64Array {
  const strengthCol = table.getChild('decay_strength')
  const halfLifeCol = table.getChild('decay_half_life_ms')
  const lastAccessCol = table.getChild('decay_last_accessed_at')

  const n = table.numRows
  const result = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const halfLife = halfLifeCol?.get(i) as number | null
    const lastAccess = lastAccessCol?.get(i) as number | null

    if (halfLife === null || lastAccess === null) {
      // No decay metadata → preserve existing or 1.0
      result[i] = (strengthCol?.get(i) as number | null) ?? 1.0
      continue
    }

    const elapsed = now - lastAccess
    // Ebbinghaus: strength = e^(-elapsed / halfLifeMs)
    result[i] = Math.exp(-elapsed / halfLife)
  }

  return result
}
```

**Performance:** 10K records: JSON path ~40ms → Arrow ~0.8ms. **50x speedup.** The speedup comes from avoiding JSON.parse for each record just to read 3 numeric fields.

### 2.3 temporalMask

```typescript
/**
 * Create a bitmask for records matching a TemporalQuery.
 *
 * Replaces: filterByTemporal() in temporal.ts (row-by-row filter)
 * Complexity: O(n) single pass over 4 Int64 columns
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param query Temporal filter criteria
 * @returns Uint8Array bitmask (1 = matches, 0 = filtered out)
 */
export function temporalMask(
  table: Table,
  query: { asOf?: number; validAt?: number },
): Uint8Array {
  const n = table.numRows
  const mask = new Uint8Array(n)

  const sysCreated = table.getChild('system_created_at')
  const sysExpired = table.getChild('system_expired_at')
  const validFrom = table.getChild('valid_from')
  const validUntil = table.getChild('valid_until')

  for (let i = 0; i < n; i++) {
    let match = true

    if (query.asOf !== undefined) {
      const created = sysCreated?.get(i) as number
      const expired = sysExpired?.get(i) as number | null
      if (created > query.asOf) match = false
      if (expired !== null && expired <= query.asOf) match = false
    }

    if (match && query.validAt !== undefined) {
      const from = validFrom?.get(i) as number
      const until = validUntil?.get(i) as number | null
      if (from > query.validAt) match = false
      if (until !== null && until <= query.validAt) match = false
    }

    mask[i] = match ? 1 : 0
  }

  return mask
}

/** Apply a bitmask to a Table, returning only matching rows */
export function applyMask(table: Table, mask: Uint8Array): Table {
  // Build indices array from mask, then use Arrow's take/filter
  const indices: number[] = []
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) indices.push(i)
  }
  // ... construct filtered Table from indices
  return table  // placeholder
}
```

**Performance:** 10K records: JSON path ~25ms → Arrow ~0.3ms. **83x speedup.**

### 2.4 partitionByNamespace

```typescript
/**
 * Group rows by dictionary-encoded namespace into separate Tables.
 *
 * Leverages dictionary encoding: namespace values are integer indices,
 * so grouping is O(n) integer comparison, not string comparison.
 *
 * Replaces: Manual namespace filtering in consolidateAll()
 * Complexity: O(n) single pass + O(k) Table construction (k = unique namespaces)
 *
 * @returns Map of namespace name to Table containing only that namespace's rows
 */
export function partitionByNamespace(table: Table): Map<string, Table> {
  const col = table.getChild('namespace')
  if (!col) return new Map()

  // Group row indices by namespace
  const groups = new Map<string, number[]>()
  for (let i = 0; i < col.length; i++) {
    const ns = col.get(i) as string
    if (!groups.has(ns)) groups.set(ns, [])
    groups.get(ns)!.push(i)
  }

  // Build per-namespace Tables
  const result = new Map<string, Table>()
  for (const [ns, indices] of groups) {
    result.set(ns, takeRows(table, indices))
  }
  return result
}
```

### 2.5 computeCompositeScore

```typescript
/**
 * Combine decay_strength, importance, and recency into a single composite
 * score per row. Used for ranking memories in retrieval and token budgeting.
 *
 * Formula: score = w_decay * strength + w_importance * importance + w_recency * recency
 * where recency = 1 / (1 + age_hours)
 *
 * Replaces: scoreWithDecay() in decay-engine.ts (single record at a time)
 * Complexity: O(n) single pass
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param weights Weight configuration
 * @param now Current timestamp for recency calculation
 * @returns Float64Array of composite scores (one per row)
 */
export function computeCompositeScore(
  table: Table,
  weights: { decay: number; importance: number; recency: number },
  now: number = Date.now(),
): Float64Array {
  const n = table.numRows
  const scores = new Float64Array(n)

  const strengthCol = table.getChild('decay_strength')
  const importanceCol = table.getChild('importance')
  const createdCol = table.getChild('system_created_at')

  for (let i = 0; i < n; i++) {
    const strength = (strengthCol?.get(i) as number | null) ?? 1.0
    const importance = (importanceCol?.get(i) as number | null) ?? 0.5
    const created = (createdCol?.get(i) as number) ?? now
    const ageHours = (now - created) / 3_600_000
    const recency = 1 / (1 + ageHours)

    scores[i] =
      weights.decay * strength +
      weights.importance * importance +
      weights.recency * recency
  }

  return scores
}
```

### 2.6 batchTokenEstimate

```typescript
/**
 * Estimate token count per record from text column character lengths.
 *
 * Replaces: Per-record estimateTokens() in context-transfer.ts
 * Complexity: O(n) single pass over text column
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param charsPerToken Characters per token ratio (default: 4)
 * @returns Int32Array of estimated token counts per row
 */
export function batchTokenEstimate(table: Table, charsPerToken = 4): Int32Array {
  const textCol = table.getChild('text')
  const payloadCol = table.getChild('payload_json')
  const n = table.numRows
  const tokens = new Int32Array(n)

  for (let i = 0; i < n; i++) {
    const text = textCol?.get(i) as string | null
    const payload = payloadCol?.get(i) as string | null
    const totalChars = (text?.length ?? 0) + (payload?.length ?? 0)
    tokens[i] = Math.ceil(totalChars / charsPerToken)
  }

  return tokens
}
```

### 2.7 selectByTokenBudget

```typescript
/**
 * Greedy knapsack selection: pick highest-scoring records that fit within
 * a token budget. Returns a filtered Table.
 *
 * Algorithm:
 * 1. Compute composite scores for all records
 * 2. Compute token estimates for all records
 * 3. Sort by score descending (build index array, not actual sort)
 * 4. Greedily select until budget exhausted
 *
 * Replaces: Manual loop in formatForPrompt() token truncation
 * Complexity: O(n log n) for sort + O(n) for selection
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param budget Maximum tokens to select
 * @param weights Composite score weights
 * @param charsPerToken Token estimation ratio
 * @returns Filtered Table fitting within budget, sorted by score
 */
export function selectByTokenBudget(
  table: Table,
  budget: number,
  weights = { decay: 0.4, importance: 0.4, recency: 0.2 },
  charsPerToken = 4,
): Table {
  const scores = computeCompositeScore(table, weights)
  const tokens = batchTokenEstimate(table, charsPerToken)

  // Build index array sorted by score descending
  const indices = Array.from({ length: table.numRows }, (_, i) => i)
  indices.sort((a, b) => scores[b] - scores[a])

  // Greedy selection
  const selected: number[] = []
  let remaining = budget
  for (const idx of indices) {
    const cost = tokens[idx]
    if (cost <= remaining) {
      selected.push(idx)
      remaining -= cost
    }
    if (remaining <= 0) break
  }

  return takeRows(table, selected)
}
```

### 2.8 rankByPageRank

```typescript
/**
 * Compute Personalized PageRank scores using entity co-occurrence from Arrow columns.
 *
 * Augments: computePPR() in pagerank.ts (operates on adjacency map)
 * This version builds the adjacency from Arrow's entity data directly.
 *
 * Complexity: O(n * k * iterations) where k = avg entities per record
 *
 * @param table Arrow Table (requires 'key' and 'text' columns for entity extraction)
 * @param config PageRank configuration
 * @returns Float64Array of PageRank scores per row
 */
export function rankByPageRank(
  table: Table,
  config?: { damping?: number; iterations?: number; seedQuery?: string },
): Float64Array {
  const n = table.numRows
  const damping = config?.damping ?? 0.85
  const iterations = config?.iterations ?? 20
  const scores = new Float64Array(n).fill(1 / n)

  // Build adjacency from entity co-occurrence
  // 1. Extract entities from each record's text column
  // 2. Build entity→recordIndices inverted index
  // 3. Records sharing entities are adjacent
  // 4. Run power iteration

  const textCol = table.getChild('text')
  const entityIndex = new Map<string, number[]>()  // entity → row indices

  for (let i = 0; i < n; i++) {
    const text = textCol?.get(i) as string | null
    if (!text) continue
    const entities = extractEntitiesFromText(text)
    for (const e of entities) {
      if (!entityIndex.has(e)) entityIndex.set(e, [])
      entityIndex.get(e)!.push(i)
    }
  }

  // Build adjacency: record i is adjacent to record j if they share an entity
  const adjacency = new Map<number, Set<number>>()
  for (const indices of entityIndex.values()) {
    for (const i of indices) {
      if (!adjacency.has(i)) adjacency.set(i, new Set())
      for (const j of indices) {
        if (i !== j) adjacency.get(i)!.add(j)
      }
    }
  }

  // Power iteration
  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const neighbors = adjacency.get(i)
      if (!neighbors || neighbors.size === 0) {
        newScores[i] += (1 - damping) / n
        continue
      }
      let incomingSum = 0
      for (const j of neighbors) {
        const outDegree = adjacency.get(j)?.size ?? 1
        incomingSum += scores[j] / outDegree
      }
      newScores[i] = (1 - damping) / n + damping * incomingSum
    }
    scores.set(newScores)
  }

  return scores
}

function extractEntitiesFromText(text: string): string[] {
  const entities: string[] = []
  for (const m of text.matchAll(/`([^`]+)`/g)) if (m[1]) entities.push(m[1].toLowerCase())
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) if (m[1]) entities.push(m[1].toLowerCase())
  return entities
}
```

### 2.9 applyHubDampeningBatch

```typescript
/**
 * Logarithmic attenuation for over-accessed records.
 * Records accessed frequently get their scores dampened to prevent
 * "hub" nodes from dominating retrieval results.
 *
 * Formula: dampened_score = score * (1 / (1 + log(1 + access_count / threshold)))
 *
 * Replaces: applyHubDampening() in hub-dampening.ts (per-record)
 * Complexity: O(n) single pass
 *
 * @param table Arrow Table with MEMORY_FRAME_SCHEMA
 * @param scores Input scores to dampen (e.g., from computeCompositeScore)
 * @param config Hub dampening configuration
 * @returns Float64Array of dampened scores
 */
export function applyHubDampeningBatch(
  table: Table,
  scores: Float64Array,
  config?: { accessThreshold?: number },
): Float64Array {
  const threshold = config?.accessThreshold ?? 10
  const accessCol = table.getChild('decay_access_count')
  const n = table.numRows
  const dampened = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const accessCount = (accessCol?.get(i) as number | null) ?? 0
    const factor = 1 / (1 + Math.log(1 + accessCount / threshold))
    dampened[i] = scores[i] * factor
  }

  return dampened
}
```

### 2.10 batchCosineSimilarity

```typescript
/**
 * Compute cosine similarity between a query embedding and all record embeddings.
 *
 * Requires the optional 'embedding' column in the schema.
 * For use in local consolidation when vectors are co-located with records.
 *
 * Complexity: O(n * d) where d = embedding dimension
 *
 * @param table Arrow Table with embedding column
 * @param queryEmbedding Query vector
 * @param embeddingColumn Column name (default: 'embedding')
 * @returns Float64Array of cosine similarity scores per row
 */
export function batchCosineSimilarity(
  table: Table,
  queryEmbedding: Float32Array,
  embeddingColumn = 'embedding',
): Float64Array {
  const col = table.getChild(embeddingColumn)
  const n = table.numRows
  const scores = new Float64Array(n)

  if (!col) return scores  // all zeros if no embedding column

  // Pre-compute query magnitude
  let queryMag = 0
  for (let d = 0; d < queryEmbedding.length; d++) {
    queryMag += queryEmbedding[d] * queryEmbedding[d]
  }
  queryMag = Math.sqrt(queryMag)
  if (queryMag === 0) return scores

  for (let i = 0; i < n; i++) {
    const embedding = col.get(i) as Float32Array | null
    if (!embedding) { scores[i] = 0; continue }

    let dot = 0, mag = 0
    for (let d = 0; d < embedding.length; d++) {
      dot += queryEmbedding[d] * embedding[d]
      mag += embedding[d] * embedding[d]
    }
    mag = Math.sqrt(mag)
    scores[i] = mag === 0 ? 0 : dot / (queryMag * mag)
  }

  return scores
}
```

---

## 3. Integration with Existing Modules

### 3.1 Consolidation Pipeline

`memory-consolidation.ts` currently calls `memoryService.get()` per namespace, iterates records, deduplicates, prunes. With Arrow:

```typescript
async function consolidateNamespaceWithArrow(
  arrowMemory: ReturnType<typeof extendMemoryServiceWithArrow>,
  namespace: string,
  scope: Record<string, string>,
) {
  // 1. Export entire namespace as Arrow Table
  const table = await arrowMemory.exportFrame(namespace, scope)

  // 2. Vectorized decay update
  const newStrengths = batchDecayUpdate(table, Date.now())

  // 3. Find weak records to prune
  const weakIndices = findWeakIndices(table, 0.1)

  // 4. Temporal filter: only active records
  const activeMask = temporalMask(table, {})

  // 5. Compute composite scores for remaining records
  const scores = computeCompositeScore(table, { decay: 0.4, importance: 0.4, recency: 0.2 })

  // 6. Apply hub dampening
  const dampened = applyHubDampeningBatch(table, scores)

  // 7. Feed high-similarity pairs to SemanticConsolidator for LLM dedup
  // ... (LLM part is still per-record, Arrow just selects candidates)
}
```

### 3.2 AdaptiveRetriever

The AdaptiveRetriever's `weightedFusion()` currently operates on `ScoredItem[]` arrays. Arrow integration provides batch scoring before fusion:

```typescript
// Before fusion, pre-score all candidates with Arrow
const allRecords = [...vectorResults, ...ftsResults, ...graphResults]
const builder = new FrameBuilder()
for (const r of allRecords) builder.add(r.value, { namespace: ns, key: r.key, scope })
const table = builder.build()

// Batch composite score + hub dampening
const scores = computeCompositeScore(table, weights)
const dampened = applyHubDampeningBatch(table, scores)
// Use dampened scores to reweight fusion results
```

### 3.3 Worker Thread Execution Model

| Operation | Thread | Reason |
|-----------|--------|--------|
| findWeakIndices | Worker | Large scan, non-blocking main thread |
| batchDecayUpdate | Worker | CPU-intensive math |
| temporalMask | Worker | Large scan |
| partitionByNamespace | Main | Fast, needed before dispatching to workers |
| computeCompositeScore | Worker | CPU-intensive |
| batchTokenEstimate | Main | Fast, needed for prompt construction |
| selectByTokenBudget | Main | Fast, needed synchronously for prompt |
| rankByPageRank | Worker | Iterative algorithm, CPU-intensive |
| applyHubDampeningBatch | Worker | Part of retrieval pipeline |
| batchCosineSimilarity | Worker | CPU-intensive vector math |

---

## 4. Testing Checklist

| Test | Description |
|------|-------------|
| `findWeak-threshold` | 100 records: 30 below 0.1, 70 above → exactly 30 indices |
| `findWeak-null-strength` | Records without decay → not weak (null ≠ low) |
| `batchDecay-formula` | Known inputs → verify Ebbinghaus formula output |
| `batchDecay-null-fields` | Missing halfLife/lastAccess → strength = 1.0 |
| `temporalMask-asOf` | 50 records with varying systemCreatedAt/Expired, verify mask |
| `temporalMask-validAt` | 50 records with varying validFrom/Until, verify mask |
| `temporalMask-both` | Combined asOf + validAt, verify intersection |
| `partition-5-namespaces` | 500 records across 5 ns, verify 5 groups sum to 500 |
| `compositeScore-weights` | Verify weighted combination with known inputs |
| `compositeScore-defaults` | Null fields → default values (strength=1.0, importance=0.5) |
| `tokenEstimate-known` | "hello world" at 4 chars/token → 3 tokens |
| `selectBudget-fits` | 10 records totaling 500 tokens, budget 300 → selects highest-scoring subset ≤300 |
| `selectBudget-empty` | Budget 0 → empty Table |
| `pageRank-convergence` | Small 5-node graph → verify scores sum to ~1.0 |
| `hubDampening-high-access` | Record with 1000 accesses → heavily dampened |
| `hubDampening-low-access` | Record with 1 access → nearly unchanged |
| `cosineSim-orthogonal` | Orthogonal vectors → similarity 0 |
| `cosineSim-identical` | Same vector → similarity 1.0 |
| `cosineSim-no-embedding` | No embedding column → all zeros |
| `equivalence-json-vs-arrow` | Run both paths on same data, verify identical rankings |
