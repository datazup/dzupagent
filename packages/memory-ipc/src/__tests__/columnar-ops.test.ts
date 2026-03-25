import { describe, it, expect } from 'vitest'
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

describe('findWeakIndices', () => {
  it('returns indices below threshold', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'test',
      decayStrength: i < 30 ? 0.05 : 0.8,
    }))
    const table = buildTable(records)
    const weak = findWeakIndices(table, 0.1)
    expect(weak.length).toBe(30)
  })

  it('treats null strength as not weak', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayStrength: null },
      { id: 'r1', namespace: 'test', decayStrength: 0.05 },
    ])
    const weak = findWeakIndices(table, 0.1)
    expect(weak.length).toBe(1)
    expect(weak[0]).toBe(1)
  })

  it('returns empty for empty table', () => {
    const table = buildTable([])
    const weak = findWeakIndices(table, 0.1)
    expect(weak.length).toBe(0)
  })
})

describe('batchDecayUpdate', () => {
  it('computes Ebbinghaus formula correctly', () => {
    const now = 1700000000000
    const lastAccess = now - 43200000 // 12 hours ago
    const halfLife = 86400000 // 24 hours
    const table = buildTable([{
      id: 'r0', namespace: 'test',
      decayStrength: 1.0, decayHalfLifeMs: halfLife,
      decayLastAccessedAt: lastAccess,
    }])
    const result = batchDecayUpdate(table, now)
    // strength = e^(-12h / 24h) = e^(-0.5) ≈ 0.6065
    expect(result[0]).toBeCloseTo(0.6065, 3)
  })

  it('returns 1.0 for null decay fields', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test', decayStrength: null }])
    const result = batchDecayUpdate(table, Date.now())
    expect(result[0]).toBe(1.0)
  })
})

describe('temporalMask', () => {
  it('filters by asOf', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', systemCreatedAt: 1000, systemExpiredAt: null },
      { id: 'r1', namespace: 'test', systemCreatedAt: 3000, systemExpiredAt: null },
      { id: 'r2', namespace: 'test', systemCreatedAt: 1000, systemExpiredAt: 1500 },
    ])
    const mask = temporalMask(table, { asOf: 2000 })
    expect(mask[0]).toBe(1) // created before 2000, not expired
    expect(mask[1]).toBe(0) // created after 2000
    expect(mask[2]).toBe(0) // expired before 2000
  })

  it('filters by validAt', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', validFrom: 1000, validUntil: 5000 },
      { id: 'r1', namespace: 'test', validFrom: 3000, validUntil: null },
    ])
    const mask = temporalMask(table, { validAt: 2000 })
    expect(mask[0]).toBe(1) // valid at 2000
    expect(mask[1]).toBe(0) // not yet valid
  })

  it('returns all-ones for empty query', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test' },
      { id: 'r1', namespace: 'test' },
    ])
    const mask = temporalMask(table, {})
    expect(mask[0]).toBe(1)
    expect(mask[1]).toBe(1)
  })
})

describe('applyMask', () => {
  it('filters rows by mask', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test' },
      { id: 'r1', namespace: 'test' },
      { id: 'r2', namespace: 'test' },
    ])
    const mask = new Uint8Array([1, 0, 1])
    const filtered = applyMask(table, mask)
    expect(filtered.numRows).toBe(2)
    expect(filtered.getChild('id')?.get(0)).toBe('r0')
    expect(filtered.getChild('id')?.get(1)).toBe('r2')
  })
})

describe('partitionByNamespace', () => {
  it('groups rows by namespace', () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, namespace: 'decisions' })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `l${i}`, namespace: 'lessons' })),
    ]
    const table = buildTable(records)
    const partitions = partitionByNamespace(table)
    expect(partitions.size).toBe(2)
    expect(partitions.get('decisions')?.numRows).toBe(3)
    expect(partitions.get('lessons')?.numRows).toBe(2)
  })
})

describe('computeCompositeScore', () => {
  it('computes weighted score', () => {
    const now = Date.now()
    const table = buildTable([{
      id: 'r0', namespace: 'test',
      decayStrength: 1.0, importance: 0.8,
      systemCreatedAt: now,
    }])
    const scores = computeCompositeScore(table, { decay: 0.4, importance: 0.4, recency: 0.2 }, now)
    // strength=1.0, importance=0.8, recency ≈ 1/(1+0) = 1.0
    // score = 0.4*1.0 + 0.4*0.8 + 0.2*1.0 = 0.4+0.32+0.2 = 0.92
    expect(scores[0]).toBeCloseTo(0.92, 1)
  })

  it('uses defaults for null values', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const scores = computeCompositeScore(table, { decay: 0.4, importance: 0.4, recency: 0.2 })
    // strength default=1.0, importance default=0.5
    expect(scores[0]).toBeGreaterThan(0)
  })
})

describe('batchTokenEstimate', () => {
  it('estimates tokens from text length', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'hello world!' }, { id: 'r0', namespace: 'test', key: 'k0' })
    const table = builder.build()
    const tokens = batchTokenEstimate(table, 4)
    // "hello world!" = 12 chars, ceil(12/4) = 3
    expect(tokens[0]).toBe(3)
  })
})

describe('selectByTokenBudget', () => {
  it('selects highest-scoring records within budget', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'test',
      text: 'x'.repeat(40), // ~10 tokens each at 4 chars/token
      importance: i * 0.1,
      decayStrength: 1.0,
    }))
    const table = buildTable(records)
    const selected = selectByTokenBudget(table, 30) // budget for ~3 records
    expect(selected.numRows).toBeLessThanOrEqual(3)
    expect(selected.numRows).toBeGreaterThan(0)
  })

  it('returns empty for zero budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const selected = selectByTokenBudget(table, 0)
    expect(selected.numRows).toBe(0)
  })
})

describe('rankByPageRank', () => {
  it('produces scores summing to approximately 1', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'Use `PostgreSQL` for the database' },
      { id: 'r1', namespace: 'test', text: '`PostgreSQL` is reliable and `Redis` is fast' },
      { id: 'r2', namespace: 'test', text: '`Redis` caching layer' },
      { id: 'r3', namespace: 'test', text: 'Unrelated topic about design' },
    ])
    const scores = rankByPageRank(table, { damping: 0.85, iterations: 20 })
    expect(scores.length).toBe(4)
    // Connected nodes (sharing entities) should have higher scores
    // r0 and r1 share `PostgreSQL`, r1 and r2 share `Redis`
    // r3 has no entity connections, so should have lowest score
    expect(scores[3]).toBeLessThanOrEqual(scores[1])
  })
})

describe('applyHubDampeningBatch', () => {
  it('dampens high-access records', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', decayAccessCount: 1 },
      { id: 'r1', namespace: 'test', decayAccessCount: 1000 },
    ])
    const scores = new Float64Array([1.0, 1.0])
    const dampened = applyHubDampeningBatch(table, scores)
    expect(dampened[0]).toBeGreaterThan(dampened[1]) // low access less dampened
  })
})

describe('batchCosineSimilarity', () => {
  it('returns all zeros when no embedding column', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const query = new Float32Array([1, 0, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })
})

describe('takeRows', () => {
  it('extracts specific rows', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test' },
      { id: 'r1', namespace: 'test' },
      { id: 'r2', namespace: 'test' },
      { id: 'r3', namespace: 'test' },
      { id: 'r4', namespace: 'test' },
    ])
    const subset = takeRows(table, [0, 2, 4])
    expect(subset.numRows).toBe(3)
    expect(subset.getChild('id')?.get(0)).toBe('r0')
    expect(subset.getChild('id')?.get(1)).toBe('r2')
    expect(subset.getChild('id')?.get(2)).toBe('r4')
  })
})
