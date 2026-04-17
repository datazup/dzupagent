/**
 * Coverage tests for columnar-ops.ts — error paths, edge cases in
 * batchCosineSimilarity, rankByPageRank, batchTokenEstimate, and more.
 */

import { describe, it, expect } from 'vitest'
import { tableFromArrays } from 'apache-arrow'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import {
  findWeakIndices,
  batchDecayUpdate,
  temporalMask,
  applyMask,
  partitionByNamespace,
  computeCompositeScore,
  batchTokenEstimate,
  selectByTokenBudget,
  rankByPageRank,
  applyHubDampeningBatch,
  batchCosineSimilarity,
  takeRows,
} from '../columnar-ops.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTable(
  records: Array<{
    id: string
    namespace: string
    text?: string
    decayStrength?: number | null
    decayHalfLifeMs?: number | null
    decayLastAccessedAt?: number | null
    decayAccessCount?: number | null
    importance?: number | null
    systemCreatedAt?: number
    systemExpiredAt?: number | null
    validFrom?: number
    validUntil?: number | null
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      importance: r.importance ?? null,
      _decay: {
        strength: r.decayStrength ?? null,
        halfLifeMs: r.decayHalfLifeMs ?? null,
        lastAccessedAt: r.decayLastAccessedAt ?? null,
        accessCount: r.decayAccessCount ?? null,
      },
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
        systemExpiredAt: r.systemExpiredAt ?? null,
        validFrom: r.validFrom ?? r.systemCreatedAt ?? Date.now(),
        validUntil: r.validUntil ?? null,
      },
    }
    const meta: FrameRecordMeta = { id: r.id, namespace: r.namespace, key: r.id }
    builder.add(value, meta)
  }
  return builder.build()
}

// ---------------------------------------------------------------------------
// batchCosineSimilarity — detailed coverage
// ---------------------------------------------------------------------------

describe('batchCosineSimilarity — coverage', () => {
  it('computes similarity for regular arrays', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[0.6, 0.8, 0]],
    })
    const query = new Float32Array([0.6, 0.8, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBeCloseTo(1.0, 3)
  })

  it('returns 0 for zero-magnitude query', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[1, 0, 0]],
    })
    const query = new Float32Array([0, 0, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })

  it('handles dimension mismatch', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[1, 0]],
    })
    const query = new Float32Array([1, 0, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0) // Different dimensions
  })

  it('uses custom embedding column name', () => {
    const table = tableFromArrays({
      id: ['r0'],
      my_emb: [[1, 0, 0]],
    })
    const query = new Float32Array([1, 0, 0])
    const scores = batchCosineSimilarity(table, query, 'my_emb')
    expect(scores[0]).toBeCloseTo(1.0, 4)
  })

  it('computes orthogonal vectors correctly', () => {
    const table = tableFromArrays({
      id: ['r0', 'r1'],
      embedding: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    })
    const query = new Float32Array([1, 0, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBeCloseTo(1.0, 3) // identical direction
    expect(scores[1]).toBeCloseTo(0.0, 3) // orthogonal
  })
})

// ---------------------------------------------------------------------------
// rankByPageRank — edge cases
// ---------------------------------------------------------------------------

describe('rankByPageRank — coverage', () => {
  it('returns all zeros when no entities are found', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'simple text without entities' },
      { id: 'r1', namespace: 'test', text: 'another plain sentence' },
    ])
    const scores = rankByPageRank(table)
    expect(scores[0]).toBe(0)
    expect(scores[1]).toBe(0)
  })

  it('handles records with only backtick entities', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'Use `react` for the frontend' },
      { id: 'r1', namespace: 'test', text: '`react` works well with `typescript`' },
      { id: 'r2', namespace: 'test', text: '`typescript` is typed' },
    ])
    const scores = rankByPageRank(table)
    // r1 should have highest score (connects two entities)
    expect(scores[1]).toBeGreaterThan(0)
  })

  it('handles PascalCase entity extraction', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'The EventBus handles events' },
      { id: 'r1', namespace: 'test', text: 'EventBus connects to MessageQueue' },
    ])
    const scores = rankByPageRank(table)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBeGreaterThan(0)
  })

  it('returns zeros for empty table', () => {
    const table = buildTable([])
    const scores = rankByPageRank(table)
    expect(scores.length).toBe(0)
  })

  it('respects custom damping and iterations', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: '`A` and `B` are related' },
      { id: 'r1', namespace: 'test', text: '`B` and `C` are related' },
    ])
    const scores1 = rankByPageRank(table, { damping: 0.5, iterations: 5 })
    const scores2 = rankByPageRank(table, { damping: 0.95, iterations: 50 })
    // Both should produce valid scores, but different values
    expect(scores1[0]).toBeGreaterThan(0)
    expect(scores2[0]).toBeGreaterThan(0)
  })

  it('handles single entity shared across rows', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: '`OnlyEntity` used here' },
      { id: 'r1', namespace: 'test', text: '`OnlyEntity` used there too' },
    ])
    const scores = rankByPageRank(table)
    // Single entity with no co-occurrence edges => each row gets its PageRank
    expect(scores[0]).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// batchDecayUpdate — edge cases
// ---------------------------------------------------------------------------

describe('batchDecayUpdate — coverage', () => {
  it('returns 1.0 when elapsed is zero', () => {
    const now = Date.now()
    const table = buildTable([{
      id: 'r0', namespace: 'test',
      decayHalfLifeMs: 86400000,
      decayLastAccessedAt: now,
    }])
    const result = batchDecayUpdate(table, now)
    expect(result[0]).toBe(1.0)
  })

  it('returns 1.0 when halfLife is zero', () => {
    const now = Date.now()
    const table = buildTable([{
      id: 'r0', namespace: 'test',
      decayHalfLifeMs: 0,
      decayLastAccessedAt: now - 1000,
    }])
    const result = batchDecayUpdate(table, now)
    expect(result[0]).toBe(1.0)
  })

  it('handles empty table', () => {
    const table = buildTable([])
    const result = batchDecayUpdate(table, Date.now())
    expect(result.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// temporalMask — combined asOf + validAt
// ---------------------------------------------------------------------------

describe('temporalMask — combined filtering', () => {
  it('filters by both asOf and validAt', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', systemCreatedAt: 1000, systemExpiredAt: null, validFrom: 500, validUntil: 3000 },
      { id: 'r1', namespace: 'test', systemCreatedAt: 1000, systemExpiredAt: null, validFrom: 3000, validUntil: null },
      { id: 'r2', namespace: 'test', systemCreatedAt: 3000, systemExpiredAt: null, validFrom: 500, validUntil: null },
    ])
    const mask = temporalMask(table, { asOf: 2000, validAt: 2000 })
    expect(mask[0]).toBe(1) // created <= 2000, valid 500-3000 covers 2000
    expect(mask[1]).toBe(0) // valid_from 3000 > 2000
    expect(mask[2]).toBe(0) // created 3000 > 2000
  })

  it('handles records with validUntil <= validAt', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', validFrom: 500, validUntil: 1000 },
    ])
    const mask = temporalMask(table, { validAt: 1500 })
    expect(mask[0]).toBe(0) // validUntil 1000 <= 1500
  })
})

// ---------------------------------------------------------------------------
// batchTokenEstimate — edge cases
// ---------------------------------------------------------------------------

describe('batchTokenEstimate — coverage', () => {
  it('handles zero or negative charsPerToken', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'test text here' }, { id: 'r0', namespace: 'ns', key: 'k0' })
    const table = builder.build()
    const tokens = batchTokenEstimate(table, 0)
    // Should fallback to 4 chars per token
    expect(tokens[0]).toBe(Math.ceil(14 / 4))
  })

  it('estimates tokens from text plus payload_json', () => {
    const builder = new FrameBuilder()
    builder.add(
      { text: 'hi', extraField: 'data' },
      { id: 'r0', namespace: 'ns', key: 'k0' },
    )
    const table = builder.build()
    const tokens = batchTokenEstimate(table, 4)
    // Should be > 0 (text + payload_json)
    expect(tokens[0]).toBeGreaterThan(0)
  })

  it('returns 0 for empty table', () => {
    const table = buildTable([])
    const tokens = batchTokenEstimate(table)
    expect(tokens.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// selectByTokenBudget — edge cases
// ---------------------------------------------------------------------------

describe('selectByTokenBudget — coverage', () => {
  it('returns empty table for empty input', () => {
    const table = buildTable([])
    const selected = selectByTokenBudget(table, 1000)
    expect(selected.numRows).toBe(0)
  })

  it('returns empty table for negative budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test', text: 'hello' }])
    const selected = selectByTokenBudget(table, -10)
    expect(selected.numRows).toBe(0)
  })

  it('selects all records when budget is huge', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'short' },
      { id: 'r1', namespace: 'test', text: 'also short' },
    ])
    const selected = selectByTokenBudget(table, 100000)
    expect(selected.numRows).toBe(2)
  })

  it('preserves original row order in output', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(20), importance: 0.1 },
      { id: 'r1', namespace: 'test', text: 'x'.repeat(20), importance: 0.9 },
      { id: 'r2', namespace: 'test', text: 'x'.repeat(20), importance: 0.5 },
    ])
    const selected = selectByTokenBudget(table, 100000)
    const ids: string[] = []
    const idCol = selected.getChild('id')
    for (let i = 0; i < selected.numRows; i++) {
      ids.push(idCol?.get(i) as string)
    }
    expect(ids).toEqual(['r0', 'r1', 'r2'])
  })
})

// ---------------------------------------------------------------------------
// applyHubDampeningBatch — edge cases
// ---------------------------------------------------------------------------

describe('applyHubDampeningBatch — coverage', () => {
  it('applies dampening with custom threshold', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayAccessCount: 100 },
    ])
    const scores = new Float64Array([1.0])

    const dampened1 = applyHubDampeningBatch(table, scores, { accessThreshold: 1 })
    const dampened2 = applyHubDampeningBatch(table, scores, { accessThreshold: 1000 })

    // Lower threshold means more dampening for same access count
    expect(dampened1[0]).toBeLessThan(dampened2[0])
  })

  it('handles zero access count', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayAccessCount: 0 },
    ])
    const scores = new Float64Array([1.0])
    const dampened = applyHubDampeningBatch(table, scores)
    // With 0 access count, dampening factor = 1/(1+ln(1+0/10)) = 1/(1+0) = 1.0
    expect(dampened[0]).toBeCloseTo(1.0, 4)
  })

  it('handles scores array shorter than table', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayAccessCount: 1 },
      { id: 'r1', namespace: 'test', decayAccessCount: 1 },
    ])
    const scores = new Float64Array([0.8]) // Only 1 score for 2 rows
    const dampened = applyHubDampeningBatch(table, scores)
    expect(dampened[0]).toBeGreaterThan(0)
    expect(dampened[1]).toBe(0) // No score for this row
  })
})

// ---------------------------------------------------------------------------
// takeRows — edge cases
// ---------------------------------------------------------------------------

describe('takeRows — coverage', () => {
  it('returns empty table for empty indices', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test' },
      { id: 'r1', namespace: 'test' },
    ])
    const subset = takeRows(table, [])
    expect(subset.numRows).toBe(0)
  })

  it('returns empty table when source is empty', () => {
    const table = buildTable([])
    const subset = takeRows(table, [0, 1])
    expect(subset.numRows).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// partitionByNamespace — edge cases
// ---------------------------------------------------------------------------

describe('partitionByNamespace — coverage', () => {
  it('returns empty map for empty table', () => {
    const table = buildTable([])
    const partitions = partitionByNamespace(table)
    expect(partitions.size).toBe(0)
  })

  it('handles single namespace', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'only-ns' },
      { id: 'r1', namespace: 'only-ns' },
    ])
    const partitions = partitionByNamespace(table)
    expect(partitions.size).toBe(1)
    expect(partitions.get('only-ns')!.numRows).toBe(2)
  })

  it('handles many namespaces', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      namespace: `ns-${i}`,
    }))
    const table = buildTable(records)
    const partitions = partitionByNamespace(table)
    expect(partitions.size).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// findWeakIndices — edge cases
// ---------------------------------------------------------------------------

describe('findWeakIndices — coverage', () => {
  it('uses default threshold of 0.1', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayStrength: 0.05 },
      { id: 'r1', namespace: 'test', decayStrength: 0.15 },
    ])
    const weak = findWeakIndices(table)
    expect(weak.length).toBe(1)
    expect(weak[0]).toBe(0)
  })

  it('returns empty when no decay_strength column exists', () => {
    const table = tableFromArrays({ id: ['r0'], text: ['hello'] })
    const weak = findWeakIndices(table, 0.1)
    expect(weak.length).toBe(0)
  })
})
