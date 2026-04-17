/**
 * Branch coverage deep-dive tests (W15-I2).
 *
 * Targets the lowest-branch-coverage modules in @dzupagent/memory-ipc:
 *   - memory-aware-compress.ts (70.83%)
 *   - memory-service-ext.ts (75%)
 *   - columnar-ops.ts (76.87%)
 *   - frame-reader.ts (77.21%)
 *   - phase-memory-selection.ts (77.41%)
 *   - cache-delta.ts (80.76%)
 *   - ipc-serializer.ts (80%)
 *   - mcp-memory-transport.ts (80%)
 *   - shared-memory-channel.ts (84.21%)
 *   - mastra-adapter.ts (80%)
 *
 * Each describe block documents which branch it covers.
 */

import { describe, it, expect, vi } from 'vitest'
import { tableFromArrays, type Table } from 'apache-arrow'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from '../ipc-serializer.js'
import { batchOverlapAnalysis } from '../memory-aware-compress.js'
import { extendMemoryServiceWithArrow } from '../memory-service-ext.js'
import type { MemoryServiceLike } from '../memory-service-ext.js'
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
import { phaseWeightedSelection } from '../phase-memory-selection.js'
import { computeFrameDelta } from '../cache-delta.js'
import {
  handleExportMemory,
  handleImportMemory,
  handleMemorySchema,
} from '../mcp-memory-transport.js'
import type {
  ExportMemoryDeps,
  ImportMemoryDeps,
} from '../mcp-memory-transport.js'
import { SharedMemoryChannel } from '../shared-memory-channel.js'
import { ArrowBlackboard } from '../blackboard.js'
import { MastraAdapter } from '../adapters/mastra-adapter.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildMemoryTable(
  records: Array<{
    id: string
    namespace?: string
    text?: string
    category?: string | null
    importance?: number | null
    decayStrength?: number | null
    decayHalfLifeMs?: number | null
    decayLastAccessedAt?: number | null
    decayAccessCount?: number | null
    systemCreatedAt?: number
    systemExpiredAt?: number | null
    validFrom?: number
    validUntil?: number | null
    agentId?: string | null
    provenanceSource?: string | null
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      importance: r.importance ?? null,
      category: r.category ?? null,
      _agent: r.agentId ?? null,
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
      _provenance: r.provenanceSource ? { source: r.provenanceSource } : undefined,
    }
    const meta: FrameRecordMeta = {
      id: r.id,
      namespace: r.namespace ?? 'test',
      key: r.id,
    }
    builder.add(value, meta)
  }
  return builder.build()
}

// ===========================================================================
// memory-aware-compress.ts branches
// ===========================================================================

describe('memory-aware-compress — branch coverage', () => {
  it('handles null values in memory table text column (continue branch)', () => {
    // Build a table with null text explicitly via tableFromArrays
    const table = tableFromArrays({
      id: ['mem0', 'mem1'],
      text: ['hello world', null],
    }) as Table

    const result = batchOverlapAnalysis(['hello world'], table)
    // Only the non-null memory counts, so first observation matches
    expect(result.duplicate.length).toBe(1)
  })

  it('handles empty-string text in memory table (skip branch)', () => {
    const table = tableFromArrays({
      id: ['mem0'],
      text: [''],
    }) as Table

    const result = batchOverlapAnalysis(['hello world'], table)
    expect(result.novel.length).toBe(1)
    expect(result.duplicate.length).toBe(0)
  })

  it('handles undefined observation at index (continue branch)', () => {
    // Sparse array: index 1 is undefined
    const observations = ['hello world']
    observations[2] = 'goodbye'

    const table = buildMemoryTable([{ id: 'm0', text: 'something else' }])
    const result = batchOverlapAnalysis(observations, table)
    // The undefined index is skipped; observations at 0 and 2 proceed
    expect(result.novel.length).toBe(2)
  })

  it('returns novel fallback when memoryTable is missing text column entirely', () => {
    const tableNoText = tableFromArrays({ id: ['m0', 'm1'] }) as Table
    const result = batchOverlapAnalysis(['observation text'], tableNoText)
    // text column missing => no memory tokens => observation is novel
    expect(result.novel.length).toBe(1)
  })

  it('handles both empty word sets (jaccard divide-by-zero branch)', () => {
    const table = buildMemoryTable([{ id: 'm0', text: '!!!' }]) // no word chars
    const result = batchOverlapAnalysis(['???'], table, 0.5)
    // Both sets empty => jaccard 0 => novel
    expect(result.novel.length).toBe(1)
  })

  it('handles observations with contractions (apostrophe stripping)', () => {
    const table = buildMemoryTable([
      { id: 'm0', text: "don't use any types" },
    ])
    // Same intent, nearly identical contractions
    const result = batchOverlapAnalysis(["don't use any types"], table, 0.9)
    expect(result.duplicate.length).toBe(1)
  })

  it('fallback: treats all observations as novel on internal error (try/catch)', () => {
    // Create a bad table where getChild throws
    const badTable = {
      numRows: 1,
      getChild: () => {
        throw new Error('boom')
      },
    } as unknown as Table
    const result = batchOverlapAnalysis(['o1', 'o2'], badTable)
    expect(result.novel.length).toBe(2)
    expect(result.duplicate.length).toBe(0)
  })
})

// ===========================================================================
// memory-service-ext.ts branches
// ===========================================================================

describe('memory-service-ext — branch coverage', () => {
  it('exportFrame with empty records from get() (skip loop)', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [],
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    expect(table.numRows).toBe(0)
  })

  it('exportFrame skips null records when get() returns sparse array', async () => {
    const svc: MemoryServiceLike = {
      get: async () => {
        const arr: Record<string, unknown>[] = []
        arr[0] = undefined as unknown as Record<string, unknown>
        arr[1] = { text: 'kept', key: 'k1' }
        return arr
      },
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    expect(table.numRows).toBe(1)
  })

  it('exportFrame synthesizes text from "content" when text missing', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [{ key: 'k1', content: 'from content' }],
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records[0]?.value.text).toBe('from content')
  })

  it('exportFrame synthesizes text from "value" field when text/content missing', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [{ key: 'k1', value: 'from value' }],
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records[0]?.value.text).toBe('from value')
  })

  it('exportFrame generates auto key when neither key nor id present', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [{ text: 'no key' }],
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    expect(table.numRows).toBe(1)
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records[0]?.meta.key).toMatch(/rec-0/)
  })

  it('exportFrame uses id when key is missing', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [{ id: 'the-id', text: 'ok' }],
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {})
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records[0]?.meta.key).toBe('the-id')
  })

  it('exportFrame slices results when more records than limit (over-limit branch)', async () => {
    const svc: MemoryServiceLike = {
      get: async () => {
        return Array.from({ length: 20 }, (_, i) => ({
          key: `k${i}`,
          text: `t${i}`,
        }))
      },
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)
    const table = await ext.exportFrame('ns', {}, { limit: 5 })
    expect(table.numRows).toBe(5)
  })

  it('importFrame skips frame records with empty key (skip branch)', async () => {
    const putMock = vi.fn(async () => {})
    const svc: MemoryServiceLike = {
      get: async () => [],
      search: async () => [],
      put: putMock,
    }
    const ext = extendMemoryServiceWithArrow(svc)

    // Build table with empty key
    const builder = new FrameBuilder()
    builder.add({ text: 'keyless' }, { id: 'id-0', namespace: 'ns', key: '' })
    const table = builder.build()

    const result = await ext.importFrame('ns', {}, table)
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(putMock).not.toHaveBeenCalled()
  })

  it('importFrame records conflicts when put() throws', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [],
      search: async () => [],
      put: async () => {
        throw new Error('put failed')
      },
    }
    const ext = extendMemoryServiceWithArrow(svc)

    const builder = new FrameBuilder()
    builder.add({ text: 'ok' }, { id: 'id-0', namespace: 'ns', key: 'k0' })
    const table = builder.build()

    const result = await ext.importFrame('ns', {}, table)
    expect(result.imported).toBe(0)
    expect(result.conflicts).toBe(1)
  })

  it('importFrame replace strategy throws when existing record has no key/id', async () => {
    const svc: MemoryServiceLike = {
      get: async () => [{ text: 'exists without key' }],
      search: async () => [],
      put: async () => {},
      delete: async () => true,
    }
    const ext = extendMemoryServiceWithArrow(svc)

    const builder = new FrameBuilder()
    builder.add({ text: 'new' }, { id: 'id-0', namespace: 'ns', key: 'k0' })
    const table = builder.build()

    await expect(ext.importFrame('ns', {}, table, 'replace')).rejects.toThrow(
      /existing records to expose a key/,
    )
  })

  it('importFrame append strategy handles existing records correctly', async () => {
    const existingKey = 'existing-key'
    const svc: MemoryServiceLike = {
      get: async (_ns, _scope, key) => {
        if (key === existingKey) return [{ key: existingKey, text: 'exists' }]
        return []
      },
      search: async () => [],
      put: async () => {},
    }
    const ext = extendMemoryServiceWithArrow(svc)

    const builder = new FrameBuilder()
    builder.add({ text: 't1' }, { id: 'id-0', namespace: 'ns', key: existingKey })
    builder.add({ text: 't2' }, { id: 'id-1', namespace: 'ns', key: 'new-key' })
    const table = builder.build()

    const result = await ext.importFrame('ns', {}, table, 'append')
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(1)
  })

  it('exportIPC produces valid bytes round-tripping through importIPC', async () => {
    const store = new Map<string, Record<string, unknown>>()
    const svc: MemoryServiceLike = {
      get: async () => Array.from(store.values()),
      search: async () => [],
      put: async (_ns, _scope, key, value) => {
        store.set(key, { ...value, key })
      },
    }
    const ext = extendMemoryServiceWithArrow(svc)
    await svc.put('ns', {}, 'k0', { text: 'hello' })

    const ipc = await ext.exportIPC('ns', {})
    expect(ipc.byteLength).toBeGreaterThan(0)

    // Import into fresh store
    const store2 = new Map<string, Record<string, unknown>>()
    const svc2: MemoryServiceLike = {
      get: async (_ns, _scope, key) => {
        if (key) return store2.has(key) ? [store2.get(key)!] : []
        return Array.from(store2.values())
      },
      search: async () => [],
      put: async (_ns, _scope, key, value) => {
        store2.set(key, { ...value, key })
      },
    }
    const ext2 = extendMemoryServiceWithArrow(svc2)
    const res = await ext2.importIPC('ns', {}, ipc)
    expect(res.imported).toBe(1)
  })
})

// ===========================================================================
// columnar-ops.ts branches
// ===========================================================================

describe('columnar-ops — branch coverage', () => {
  it('findWeakIndices returns empty when decay_strength column missing', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const result = findWeakIndices(table, 0.5)
    expect(result.length).toBe(0)
  })

  it('findWeakIndices skips null decay_strength values', () => {
    const table = tableFromArrays({
      id: ['r0', 'r1'],
      decay_strength: [null, 0.05],
    }) as Table
    const result = findWeakIndices(table, 0.1)
    expect(Array.from(result)).toEqual([1])
  })

  it('findWeakIndices handles bigint decay_strength', () => {
    // Simulated bigint-typed numeric column via tableFromArrays with BigInt64Array
    const table = tableFromArrays({
      id: ['r0'],
      decay_strength: new BigInt64Array([0n]),
    }) as Table
    const result = findWeakIndices(table, 0.5)
    expect(Array.from(result)).toEqual([0])
  })

  it('batchDecayUpdate: halfLifeMs=0 returns 1.0 (edge branch)', () => {
    const table = buildMemoryTable([
      { id: 'r0', decayHalfLifeMs: 0, decayLastAccessedAt: 100 },
    ])
    const result = batchDecayUpdate(table, 1000)
    expect(result[0]).toBe(1.0)
  })

  it('batchDecayUpdate: lastAccessedAt > now returns 1.0 (elapsed<=0 branch)', () => {
    const table = buildMemoryTable([
      {
        id: 'r0',
        decayHalfLifeMs: 1000,
        decayLastAccessedAt: 2000,
      },
    ])
    const result = batchDecayUpdate(table, 1000) // now is before last access
    expect(result[0]).toBe(1.0)
  })

  it('temporalMask with neither asOf nor validAt returns all-1 mask', () => {
    const table = buildMemoryTable([
      { id: 'r0', systemCreatedAt: 100 },
      { id: 'r1', systemCreatedAt: 200 },
    ])
    const mask = temporalMask(table, {})
    expect(Array.from(mask)).toEqual([1, 1])
  })

  it('temporalMask with asOf: system_created_at > asOf filters out', () => {
    const table = buildMemoryTable([
      { id: 'r0', systemCreatedAt: 100 },
      { id: 'r1', systemCreatedAt: 1000 },
    ])
    const mask = temporalMask(table, { asOf: 500 })
    expect(Array.from(mask)).toEqual([1, 0])
  })

  it('temporalMask with asOf: system_expired_at <= asOf filters out', () => {
    const table = buildMemoryTable([
      { id: 'r0', systemCreatedAt: 100, systemExpiredAt: 400 }, // expired before asOf
      { id: 'r1', systemCreatedAt: 100, systemExpiredAt: 1000 }, // still active
    ])
    const mask = temporalMask(table, { asOf: 500 })
    expect(Array.from(mask)).toEqual([0, 1])
  })

  it('temporalMask with validAt: valid_from > validAt filters out', () => {
    const table = buildMemoryTable([
      { id: 'r0', validFrom: 100 },
      { id: 'r1', validFrom: 1000 },
    ])
    const mask = temporalMask(table, { validAt: 500 })
    expect(Array.from(mask)).toEqual([1, 0])
  })

  it('temporalMask with validAt: valid_until <= validAt filters out', () => {
    const table = buildMemoryTable([
      { id: 'r0', validFrom: 100, validUntil: 300 },
      { id: 'r1', validFrom: 100, validUntil: null },
    ])
    const mask = temporalMask(table, { validAt: 500 })
    expect(Array.from(mask)).toEqual([0, 1])
  })

  it('temporalMask combines asOf AND validAt', () => {
    const table = buildMemoryTable([
      { id: 'r0', systemCreatedAt: 100, validFrom: 100 },
      { id: 'r1', systemCreatedAt: 100, validFrom: 9999 }, // fails validAt
    ])
    const mask = temporalMask(table, { asOf: 500, validAt: 500 })
    expect(Array.from(mask)).toEqual([1, 0])
  })

  it('applyMask handles mask shorter than table', () => {
    const table = buildMemoryTable([
      { id: 'r0' },
      { id: 'r1' },
      { id: 'r2' },
    ])
    const mask = new Uint8Array([1, 0])
    const filtered = applyMask(table, mask)
    expect(filtered.numRows).toBe(1)
  })

  it('applyMask handles mask longer than table', () => {
    const table = buildMemoryTable([{ id: 'r0' }])
    const mask = new Uint8Array([1, 1, 1, 1])
    const filtered = applyMask(table, mask)
    expect(filtered.numRows).toBe(1)
  })

  it('partitionByNamespace returns empty map when namespace column missing', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const result = partitionByNamespace(table)
    expect(result.size).toBe(0)
  })

  it('partitionByNamespace handles empty table', () => {
    const table = tableFromArrays({ id: [] as string[], namespace: [] as string[] }) as Table
    const result = partitionByNamespace(table)
    expect(result.size).toBe(0)
  })

  it('partitionByNamespace defaults null namespace to "unknown"', () => {
    const table = tableFromArrays({
      id: ['r0', 'r1'],
      namespace: [null, 'real'],
    }) as Table
    const result = partitionByNamespace(table)
    expect(result.has('unknown')).toBe(true)
    expect(result.has('real')).toBe(true)
  })

  it('computeCompositeScore uses Date.now() when no timestamp provided', () => {
    const table = buildMemoryTable([{ id: 'r0', importance: 0.5 }])
    const scores = computeCompositeScore(table, {
      decay: 0,
      importance: 1,
      recency: 0,
    })
    expect(scores[0]).toBeCloseTo(0.5, 5)
  })

  it('computeCompositeScore: ageHours=0 gives max recency score', () => {
    const now = 100000
    const table = buildMemoryTable([
      { id: 'r0', systemCreatedAt: now },
    ])
    const scores = computeCompositeScore(table, {
      decay: 0,
      importance: 0,
      recency: 1,
    }, now)
    expect(scores[0]).toBeCloseTo(1.0, 5)
  })

  it('batchTokenEstimate: charsPerToken=0 falls back to 4 default', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'hello world!' }, // 12 chars
    ])
    const tokens = batchTokenEstimate(table, 0)
    // Falls back to 4 chars/token: ceil(12/4) = 3
    expect(tokens[0]).toBe(3)
  })

  it('batchTokenEstimate: negative charsPerToken falls back to 4 default', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'hello world!' }, // 12 chars
    ])
    const tokens = batchTokenEstimate(table, -5)
    expect(tokens[0]).toBe(3)
  })

  it('selectByTokenBudget: empty table returns empty', () => {
    const table = buildMemoryTable([])
    const filtered = selectByTokenBudget(table, 1000)
    expect(filtered.numRows).toBe(0)
  })

  it('selectByTokenBudget: budget=0 returns empty', () => {
    const table = buildMemoryTable([{ id: 'r0', text: 'x' }])
    const filtered = selectByTokenBudget(table, 0)
    expect(filtered.numRows).toBe(0)
  })

  it('selectByTokenBudget: item larger than budget is skipped', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'x'.repeat(1000) }, // 250 tokens
      { id: 'r1', text: 'x' }, // 1 token
    ])
    const filtered = selectByTokenBudget(table, 5)
    expect(filtered.numRows).toBe(1)
  })

  it('rankByPageRank: no entities returns zeros', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'no entities here just words' },
    ])
    const scores = rankByPageRank(table)
    expect(scores[0]).toBe(0)
  })

  it('rankByPageRank: single backtick-entity produces nonzero score', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'see the `FooBar` symbol' },
      { id: 'r1', text: 'also see `FooBar` referenced' },
    ])
    const scores = rankByPageRank(table, { damping: 0.5, iterations: 5 })
    // The shared entity means both rows have the same max rank
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBeGreaterThan(0)
  })

  it('rankByPageRank: PascalCase entity detection', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'MyClass extends BaseClass' },
      { id: 'r1', text: 'MyClass also implements BaseClass' },
    ])
    const scores = rankByPageRank(table)
    expect(scores[0]).toBeGreaterThan(0)
  })

  it('rankByPageRank: isolated entity has base score', () => {
    const table = buildMemoryTable([
      { id: 'r0', text: 'solo `Entity` alone' },
    ])
    const scores = rankByPageRank(table)
    expect(scores[0]).toBeGreaterThanOrEqual(0)
  })

  it('applyHubDampeningBatch: accessCount=0 gives no dampening', () => {
    const table = buildMemoryTable([
      { id: 'r0', decayAccessCount: 0 },
    ])
    const baseScores = new Float64Array([1.0])
    const dampened = applyHubDampeningBatch(table, baseScores)
    expect(dampened[0]).toBe(1.0)
  })

  it('applyHubDampeningBatch: high access count heavily dampens', () => {
    const table = buildMemoryTable([
      { id: 'r0', decayAccessCount: 100 },
    ])
    const baseScores = new Float64Array([1.0])
    const dampened = applyHubDampeningBatch(table, baseScores, { accessThreshold: 10 })
    expect(dampened[0]).toBeLessThan(1.0)
  })

  it('applyHubDampeningBatch: scores shorter than table uses 0 padding', () => {
    const table = buildMemoryTable([
      { id: 'r0' },
      { id: 'r1' },
    ])
    const baseScores = new Float64Array([1.0]) // only 1 entry
    const dampened = applyHubDampeningBatch(table, baseScores)
    expect(dampened.length).toBe(2)
    expect(dampened[1]).toBe(0)
  })

  it('batchCosineSimilarity: embedding column missing returns zeros', () => {
    const table = buildMemoryTable([{ id: 'r0' }])
    const query = new Float32Array([0.5, 0.5])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })

  it('batchCosineSimilarity: zero-magnitude query returns zeros', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[0.1, 0.2]],
    }) as Table
    const query = new Float32Array([0, 0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })

  it('batchCosineSimilarity: dimension mismatch is skipped', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[0.1, 0.2, 0.3]], // length 3
    }) as Table
    const query = new Float32Array([1.0, 0.0]) // length 2
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })

  it('batchCosineSimilarity: zero-magnitude row is skipped', () => {
    const table = tableFromArrays({
      id: ['r0'],
      embedding: [[0, 0]],
    }) as Table
    const query = new Float32Array([1.0, 0.0])
    const scores = batchCosineSimilarity(table, query)
    expect(scores[0]).toBe(0)
  })

  it('takeRows with empty indices returns empty table preserving schema', () => {
    const table = buildMemoryTable([{ id: 'r0' }])
    const result = takeRows(table, [])
    expect(result.numRows).toBe(0)
    expect(result.schema.fields.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// frame-reader.ts branches
// ===========================================================================

describe('frame-reader — branch coverage', () => {
  it('namespaces returns empty when namespace column missing', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const reader = new FrameReader(table)
    expect(reader.namespaces).toEqual([])
  })

  it('filterByNamespace returns empty reader when column missing', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const reader = new FrameReader(table)
    const filtered = reader.filterByNamespace('anything')
    expect(filtered.rowCount).toBe(0)
  })

  it('filterActive returns all rows when is_active column missing', () => {
    const table = tableFromArrays({ id: ['r0', 'r1'] }) as Table
    const reader = new FrameReader(table)
    const filtered = reader.filterActive()
    expect(filtered.rowCount).toBe(2)
  })

  it('filterByDecayAbove: missing column returns all rows', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const reader = new FrameReader(table)
    const filtered = reader.filterByDecayAbove(0.5)
    expect(filtered.rowCount).toBe(1)
  })

  it('filterByAgent: missing column returns empty', () => {
    const table = tableFromArrays({ id: ['r0'] }) as Table
    const reader = new FrameReader(table)
    const filtered = reader.filterByAgent('anyone')
    expect(filtered.rowCount).toBe(0)
  })

  it('toRecords handles malformed payload_json gracefully (try/catch branch)', () => {
    // Directly build a table with malformed payload_json
    const table = tableFromArrays({
      id: ['r0'],
      namespace: ['ns'],
      key: ['k0'],
      text: ['valid text'],
      payload_json: ['not valid json {{{'],
    }) as Table
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.value.text).toBe('valid text')
  })

  it('toRecords handles payload_json that is non-object/array JSON', () => {
    const table = tableFromArrays({
      id: ['r0'],
      namespace: ['ns'],
      key: ['k0'],
      text: ['hello'],
      payload_json: ['"just a string"'],
    }) as Table
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    // Non-object JSON is ignored (not iterated)
    expect(records[0]?.value.text).toBe('hello')
  })

  it('toRecords handles payload_json as JSON array (skipped)', () => {
    const table = tableFromArrays({
      id: ['r0'],
      namespace: ['ns'],
      key: ['k0'],
      text: ['hello'],
      payload_json: ['[1, 2, 3]'],
    }) as Table
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    expect(records[0]?.value.text).toBe('hello')
  })

  it('toRecords reconstructs meta with no scope when all scope fields null', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'no scope' }, { id: 'r0', namespace: 'ns', key: 'k0' })
    const reader = new FrameReader(builder.build())
    const records = reader.toRecords()
    expect(records[0]?.meta.scope).toBeUndefined()
  })

  it('fromSharedBuffer constructs from SharedArrayBuffer', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'shared' }, { id: 'r0', namespace: 'ns', key: 'k0' })
    const shared = builder.toSharedBuffer()
    const reader = FrameReader.fromSharedBuffer(shared)
    expect(reader.rowCount).toBe(1)
  })

  it('buildEmptyTable returns schema-correct empty table for filterByNamespace misses', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'x' }, { id: 'r0', namespace: 'A', key: 'k0' })
    const reader = new FrameReader(builder.build())
    const filtered = reader.filterByNamespace('Z') // no match
    expect(filtered.rowCount).toBe(0)
  })

  it('toRecords reconstructs temporal fields partially', () => {
    // Build with only systemCreatedAt set
    const builder = new FrameBuilder()
    builder.add(
      {
        text: 'partial',
        _temporal: { systemCreatedAt: 1700000000000 },
      },
      { id: 'r0', namespace: 'ns', key: 'k0' },
    )
    const reader = new FrameReader(builder.build())
    const records = reader.toRecords()
    expect(records[0]?.value._temporal?.systemCreatedAt).toBe(1700000000000)
  })
})

// ===========================================================================
// phase-memory-selection.ts branches
// ===========================================================================

describe('phase-memory-selection — branch coverage', () => {
  it('uses options.namespaceWeights override', () => {
    const now = Date.now()
    const records = [
      { id: 'r0', namespace: 'custom', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r1', namespace: 'other', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildMemoryTable(records)

    // 'general' phase has no default weights, but override will apply
    const selected = phaseWeightedSelection(table, 'general', 100000, {
      now,
      namespaceWeights: { custom: 5.0, other: 0.1 },
    })
    const custom = selected.find((s) => s.rowIndex === 0)
    const other = selected.find((s) => s.rowIndex === 1)
    expect(custom!.score).toBeGreaterThan(other!.score)
  })

  it('uses options.categoryWeights override', () => {
    const now = Date.now()
    const records = [
      { id: 'r0', namespace: 'x', category: 'hot', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r1', namespace: 'x', category: 'cold', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildMemoryTable(records)

    const selected = phaseWeightedSelection(table, 'general', 100000, {
      now,
      categoryWeights: { hot: 3.0, cold: 0.1 },
    })
    const hot = selected.find((s) => s.rowIndex === 0)
    const cold = selected.find((s) => s.rowIndex === 1)
    expect(hot!.score).toBeGreaterThan(cold!.score)
  })

  it('charsPerToken override affects token estimates', () => {
    const now = Date.now()
    const table = buildMemoryTable([
      { id: 'r0', namespace: 'x', text: 'x'.repeat(100), systemCreatedAt: now },
    ])
    const selectedSmall = phaseWeightedSelection(table, 'general', 100000, {
      now,
      charsPerToken: 2, // 50 tokens
    })
    const selectedLarge = phaseWeightedSelection(table, 'general', 100000, {
      now,
      charsPerToken: 10, // 10 tokens
    })
    expect(selectedSmall[0]?.tokenCost).toBeGreaterThan(selectedLarge[0]?.tokenCost ?? 0)
  })

  it('stacks namespace + category multiplicatively', () => {
    const now = Date.now()
    // In debugging phase: lessons namespace=2.5, lesson category=2.5 => 6.25 multiplier
    const table = buildMemoryTable([
      { id: 'r0', namespace: 'lessons', category: 'lesson', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r1', namespace: 'other', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ])
    const selected = phaseWeightedSelection(table, 'debugging', 100000, { now })
    const stacked = selected.find((s) => s.rowIndex === 0)
    const unstacked = selected.find((s) => s.rowIndex === 1)
    expect(stacked!.score).toBeGreaterThan(unstacked!.score)
  })

  it('null namespace and category are unaffected by weights', () => {
    const now = Date.now()
    const table = tableFromArrays({
      id: ['r0'],
      namespace: [null],
      text: ['x'.repeat(40)],
      decay_strength: new Float64Array([1.0]),
      importance: new Float64Array([0.5]),
      system_created_at: new BigInt64Array([BigInt(now)]),
    }) as Table
    const selected = phaseWeightedSelection(table, 'debugging', 100000, { now })
    // Should not crash; row selected with base score
    expect(selected.length).toBeLessThanOrEqual(1)
  })

  it('returns empty on internal error (try/catch)', () => {
    const badTable = {
      numRows: 1,
      getChild: () => { throw new Error('boom') },
    } as unknown as Table
    const result = phaseWeightedSelection(badTable, 'general', 1000)
    expect(result).toEqual([])
  })
})

// ===========================================================================
// cache-delta.ts branches
// ===========================================================================

describe('cache-delta — branch coverage', () => {
  it('handles null id values (skip branch)', () => {
    const frozen = tableFromArrays({
      id: [null, 'r1'],
      text: ['skip', 'keep'],
    }) as Table
    const current = tableFromArrays({
      id: ['r1'],
      text: ['keep'],
    }) as Table

    const delta = computeFrameDelta(frozen, current)
    // Should not crash; r1 is shared unchanged
    expect(delta.modified).toBe(0)
  })

  it('handles missing id column in frozen (no hash map)', () => {
    const frozen = tableFromArrays({ text: ['t1'] }) as Table
    const current = buildMemoryTable([{ id: 'r0', text: 't1' }])
    const delta = computeFrameDelta(frozen, current)
    expect(delta.added).toBe(1)
  })

  it('handles missing text column (empty hash)', () => {
    const frozen = tableFromArrays({ id: ['r0'], payload_json: ['x'] }) as Table
    const current = tableFromArrays({ id: ['r0'], payload_json: ['x'] }) as Table
    const delta = computeFrameDelta(frozen, current)
    expect(delta.modified).toBe(0)
  })

  it('returns shouldRefreeze=true on internal error (try/catch fallback)', () => {
    const badTable = {
      numRows: 5,
      getChild: () => { throw new Error('broken') },
    } as unknown as Table
    const good = buildMemoryTable([{ id: 'r0' }])

    const delta = computeFrameDelta(badTable, good)
    expect(delta.shouldRefreeze).toBe(true)
    expect(delta.frozenTotal).toBe(5)
  })

  it('empty frozen but non-empty current: all added', () => {
    const frozen = buildMemoryTable([])
    const current = buildMemoryTable([{ id: 'r0', text: 'new' }])
    const delta = computeFrameDelta(frozen, current)
    expect(delta.added).toBe(1)
    expect(delta.removed).toBe(0)
  })

  it('empty current but non-empty frozen: all removed', () => {
    const frozen = buildMemoryTable([{ id: 'r0', text: 'old' }])
    const current = buildMemoryTable([])
    const delta = computeFrameDelta(frozen, current)
    expect(delta.removed).toBe(1)
    expect(delta.added).toBe(0)
  })

  it('change at exact threshold: shouldRefreeze=false (>, not >=)', () => {
    // 1 change out of 10 = 0.1 changeRatio, threshold=0.1 => 0.1 > 0.1 is false
    const frozen = buildMemoryTable(
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: `t${i}` })),
    )
    const current = buildMemoryTable(
      Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        text: i === 0 ? 'changed' : `t${i}`,
      })),
    )
    const delta = computeFrameDelta(frozen, current, 0.1)
    expect(delta.shouldRefreeze).toBe(false)
  })
})

// ===========================================================================
// ipc-serializer.ts branches
// ===========================================================================

describe('ipc-serializer — branch coverage', () => {
  it('ipcToBase64 survives with valid input', () => {
    const b64 = ipcToBase64(new Uint8Array([1, 2, 3]))
    expect(b64).toBe('AQID')
  })

  it('base64ToIPC handles malformed base64 gracefully', () => {
    // Buffer is surprisingly lenient; hard to cause throw but empty string works
    const bytes = base64ToIPC('not_really_valid_b64_!@#$%')
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it('serializeToIPC round-trip preserves BigInt64Array columns', () => {
    const table = tableFromArrays({
      id: ['a', 'b'],
      ts: new BigInt64Array([1n, 2n]),
    }) as Table
    const bytes = serializeToIPC(table, { format: 'stream' })
    const restored = deserializeFromIPC(bytes)
    expect(restored.numRows).toBe(2)
  })

  it('deserializeFromIPC: single-byte input returns empty table', () => {
    const result = deserializeFromIPC(new Uint8Array([42]))
    expect(result.numRows).toBe(0)
  })

  it('serialize with undefined options uses default format', () => {
    const table = tableFromArrays({ x: [1] })
    const bytes = serializeToIPC(table, undefined)
    expect(bytes.byteLength).toBeGreaterThan(0)
  })
})

// ===========================================================================
// mcp-memory-transport.ts branches
// ===========================================================================

describe('mcp-memory-transport — branch coverage', () => {
  function makeDepsWithResult(
    result: { imported: number; skipped: number; conflicts: number },
  ): ImportMemoryDeps {
    return {
      importFrame: async () => result,
    }
  }

  it('handleExportMemory without scope defaults to empty scope object', async () => {
    let seenScope: Record<string, string> | null = null
    const deps: ExportMemoryDeps = {
      exportFrame: async (_ns, scope) => {
        seenScope = scope
        return new FrameBuilder().build()
      },
    }
    await handleExportMemory(
      { namespace: 'ns', format: 'arrow_ipc', limit: 10 },
      deps,
    )
    expect(seenScope).toEqual({})
  })

  it('handleExportMemory omits query when undefined', async () => {
    let seenOpts: { query?: string; limit?: number } | undefined
    const deps: ExportMemoryDeps = {
      exportFrame: async (_ns, _scope, opts) => {
        seenOpts = opts
        return new FrameBuilder().build()
      },
    }
    await handleExportMemory(
      { namespace: 'ns', format: 'arrow_ipc', limit: 10 },
      deps,
    )
    expect(seenOpts?.query).toBeUndefined()
    expect(seenOpts?.limit).toBe(10)
  })

  it('handleImportMemory json: returns error for non-array top-level', async () => {
    const b64 = ipcToBase64(new TextEncoder().encode('{"not":"array"}'))
    const deps = makeDepsWithResult({ imported: 0, skipped: 0, conflicts: 0 })
    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      deps,
    )
    expect(result.imported).toBe(0)
    expect(result.warnings[0]).toMatch(/expected an array/)
  })

  it('handleImportMemory json: preserves scope shape from record meta', async () => {
    const jsonData = JSON.stringify([
      {
        meta: {
          id: 'r0',
          namespace: 'ns',
          key: 'k0',
          scope: { tenant: 't1' },
        },
        value: { text: 'with partial scope' },
      },
    ])
    const b64 = ipcToBase64(new TextEncoder().encode(jsonData))
    const deps = makeDepsWithResult({ imported: 1, skipped: 0, conflicts: 0 })
    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      deps,
    )
    expect(result.imported).toBe(1)
  })

  it('handleImportMemory json: records without scope still process', async () => {
    const jsonData = JSON.stringify([
      {
        meta: { id: 'r0', namespace: 'ns', key: 'k0' }, // no scope
        value: { text: 'scopeless' },
      },
    ])
    const b64 = ipcToBase64(new TextEncoder().encode(jsonData))
    const deps = makeDepsWithResult({ imported: 1, skipped: 0, conflicts: 0 })
    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      deps,
    )
    expect(result.imported).toBe(1)
  })

  it('handleImportMemory: empty table returns warning', async () => {
    const emptyTable = new FrameBuilder().build()
    const bytes = serializeToIPC(emptyTable)
    const b64 = ipcToBase64(bytes)
    const deps = makeDepsWithResult({ imported: 0, skipped: 0, conflicts: 0 })

    const result = await handleImportMemory(
      {
        data: b64,
        format: 'arrow_ipc',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      deps,
    )
    expect(result.imported).toBe(0)
    expect(result.warnings.some((w) => w.includes('No records'))).toBe(true)
  })

  it('handleImportMemory without scope defaults to empty', async () => {
    const table = new FrameBuilder()
      .add({ text: 'x' }, { id: 'r0', namespace: 'ns', key: 'k0' })
      .build()
    const b64 = ipcToBase64(serializeToIPC(table))
    let seenScope: Record<string, string> | null = null
    const deps: ImportMemoryDeps = {
      importFrame: async (_ns, scope) => {
        seenScope = scope
        return { imported: 1, skipped: 0, conflicts: 0 }
      },
    }
    await handleImportMemory(
      {
        data: b64,
        format: 'arrow_ipc',
        namespace: 'ns',
        merge_strategy: 'upsert',
      },
      deps,
    )
    expect(seenScope).toEqual({})
  })

  it('handleMemorySchema: falls back to field name for unknown fields', () => {
    const result = handleMemorySchema()
    // Every field must have a description (non-empty)
    for (const f of result.fields) {
      expect(f.description.length).toBeGreaterThan(0)
    }
  })
})

// ===========================================================================
// shared-memory-channel.ts branches
// ===========================================================================

describe('shared-memory-channel — branch coverage', () => {
  it('consumer side throws on write without multiWriter', () => {
    const producer = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 4096 })
    const consumer = new SharedMemoryChannel({
      existingBuffer: producer.sharedBuffer,
      maxSlots: 2,
      // multiWriter defaults false
    })
    expect(() => consumer.write(new Uint8Array([1, 2, 3]))).toThrow(
      /consumer-side/,
    )
  })

  it('consumer side allows write when multiWriter=true', () => {
    const producer = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 4096 })
    const consumer = new SharedMemoryChannel({
      existingBuffer: producer.sharedBuffer,
      maxSlots: 2,
      multiWriter: true,
    })
    const handle = consumer.write(new Uint8Array([1, 2, 3]))
    expect(handle.slotIndex).toBeGreaterThanOrEqual(0)
  })

  it('writeTable throws when serialization produces empty bytes', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 4096 })
    const badTable = { not: 'a table' } as unknown as Table
    expect(() => channel.writeTable(badTable)).toThrow(/serialize table/)
  })

  it('read after release throws "not readable"', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 4096 })
    const handle = channel.write(new Uint8Array([1, 2, 3]))
    channel.release(handle)
    expect(() => channel.read(handle)).toThrow(/not readable/)
  })

  it('bump allocator wraps around when data fills region', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 8, maxBytes: 200 })
    // Fill with 3 x 50-byte writes => 150 bytes used
    const h1 = channel.write(new Uint8Array(50).fill(0xA1))
    const h2 = channel.write(new Uint8Array(50).fill(0xA2))
    const h3 = channel.write(new Uint8Array(50).fill(0xA3))
    // Release slots so we can write more (slot count is not the limit here)
    channel.release(h1)
    channel.release(h2)
    channel.release(h3)
    // Bump pointer is at 150; an 80-byte write pushes to 230 > 200 => wrap
    const h4 = channel.write(new Uint8Array(80).fill(0xA4))
    expect(h4.offset).toBe(0) // wrapped to 0
  })

  it('validateHandle rejects negative slot index', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 100 })
    expect(() => channel.release({ slotIndex: -1, offset: 0, length: 1 })).toThrow(
      /invalid slot index/,
    )
  })

  it('validateHandle rejects slot index >= maxSlots', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 100 })
    expect(() => channel.release({ slotIndex: 2, offset: 0, length: 1 })).toThrow(
      /invalid slot index/,
    )
  })

  it('CAS contention retries eventually succeed in sequence', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 4, maxBytes: 4096 })
    // Just verify sequential writes each get unique slots
    const handles = [
      channel.write(new Uint8Array(10).fill(1)),
      channel.write(new Uint8Array(10).fill(2)),
      channel.write(new Uint8Array(10).fill(3)),
    ]
    const indices = new Set(handles.map((h) => h.slotIndex))
    expect(indices.size).toBe(3)
  })

  it('dispose resets state and allows re-use', () => {
    const channel = new SharedMemoryChannel({ maxSlots: 2, maxBytes: 100 })
    channel.write(new Uint8Array(10))
    channel.dispose()

    // After dispose, slot 0 should be writable again
    const h = channel.write(new Uint8Array(10))
    expect(h.slotIndex).toBe(0)
  })
})

// ===========================================================================
// blackboard.ts branches
// ===========================================================================

describe('blackboard — branch coverage', () => {
  const config = {
    tables: {
      plan: { writer: 'agent://planner' },
    },
  }

  it('concatTables: A has no matching column (null padding branch)', () => {
    const bb = new ArrowBlackboard(config)
    const tableA = tableFromArrays({ id: ['a1'] }) as Table
    const tableB = tableFromArrays({ id: ['b1'], newCol: ['value'] }) as Table
    bb.append('plan', 'agent://planner', tableA)
    bb.append('plan', 'agent://planner', tableB)

    const snapshot = bb.read('plan')
    expect(snapshot!.table.numRows).toBe(2)
  })

  it('concatTables: B has no matching column in schema A (null padding)', () => {
    const bb = new ArrowBlackboard(config)
    const tableA = tableFromArrays({ id: ['a1'], alpha: ['x'] }) as Table
    const tableB = tableFromArrays({ id: ['b1'] }) as Table
    bb.append('plan', 'agent://planner', tableA)
    bb.append('plan', 'agent://planner', tableB)

    const snapshot = bb.read('plan')
    expect(snapshot!.table.numRows).toBe(2)
    // alpha should have null for row 1
    const col = snapshot!.table.getChild('alpha')
    expect(col?.get(1)).toBeNull()
  })

  it('increments writeSeq correctly across many appends', () => {
    const bb = new ArrowBlackboard(config)
    for (let i = 0; i < 5; i++) {
      bb.append('plan', 'agent://planner', tableFromArrays({ id: [`r${i}`] }) as Table)
    }
    expect(bb.getWriteSeq('plan')).toBe(5)
  })
})

// ===========================================================================
// mastra-adapter.ts branches
// ===========================================================================

describe('mastra-adapter — branch coverage', () => {
  const adapter = new MastraAdapter()

  it('validate: warns on priority < 1', () => {
    const result = adapter.validate([
      {
        content: 'ok',
        date: '2024-01-01',
        priority: 0,
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    expect(result.warnings.some((w) => w.field === 'priority')).toBe(true)
  })

  it('validate: warns on priority > 5', () => {
    const result = adapter.validate([
      {
        content: 'ok',
        date: '2024-01-01',
        priority: 10,
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    expect(result.warnings.some((w) => w.field === 'priority')).toBe(true)
  })

  it('validate: warns on invalid date', () => {
    const result = adapter.validate([
      {
        content: 'ok',
        date: 'not-a-date',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    expect(result.warnings.some((w) => w.field === 'date')).toBe(true)
  })

  it('validate: non-object record warning', () => {
    const result = adapter.validate([null, 'string-not-object'])
    expect(result.invalid).toBe(2)
    expect(result.warnings.some((w) => w.field === '*')).toBe(true)
  })

  it('validate: missing each required field reports distinctly', () => {
    const result = adapter.validate([
      { content: 'ok', date: '2024', priority: 3 /* missing threadId/resourceId */ },
    ])
    expect(result.invalid).toBe(1)
    const fields = result.warnings.map((w) => w.field)
    expect(fields).toContain('threadId')
    expect(fields).toContain('resourceId')
  })

  it('toFrame: omits agentId when undefined (null branch)', () => {
    const table = adapter.toFrame([
      {
        content: 'no agent',
        date: '2024-01-01',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    expect(table.numRows).toBe(1)
    const col = table.getChild('agent_id')
    expect(col?.get(0)).toBeNull()
  })

  it('toFrame: clamps priority outside [0, 1] range for importance', () => {
    const table = adapter.toFrame([
      {
        content: 'high',
        date: '2024-01-01',
        priority: 10, // > 5 → would be > 1
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    const importance = table.getChild('importance')?.get(0)
    expect(importance).toBeLessThanOrEqual(1)
  })

  it('toFrame: assigns null payload when no tags', () => {
    const table = adapter.toFrame([
      {
        content: 'no tags',
        date: '2024-01-01',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
      },
    ])
    const payloadCol = table.getChild('payload_json')
    expect(payloadCol?.get(0)).toBeNull()
  })

  it('toFrame: assigns null payload when tags array is empty', () => {
    const table = adapter.toFrame([
      {
        content: 'empty tags',
        date: '2024-01-01',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
        tags: [],
      },
    ])
    const payloadCol = table.getChild('payload_json')
    expect(payloadCol?.get(0)).toBeNull()
  })

  it('toFrame: includes payload when tags are present', () => {
    const table = adapter.toFrame([
      {
        content: 'with tags',
        date: '2024-01-01',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
        tags: ['important', 'urgent'],
      },
    ])
    const payloadCol = table.getChild('payload_json')
    const payload = payloadCol?.get(0) as string | null
    expect(payload).toContain('important')
  })

  it('toFrame: uses createdAt when present', () => {
    const createdAt = '2024-06-01T00:00:00Z'
    const table = adapter.toFrame([
      {
        content: 'with createdAt',
        date: '2024-01-01',
        priority: 3,
        threadId: 't1',
        resourceId: 'r1',
        createdAt,
      },
    ])
    const col = table.getChild('system_created_at')
    const val = col?.get(0)
    expect(typeof val === 'bigint').toBe(true)
  })

  it('fromFrame: skips records with null text', () => {
    const table = tableFromArrays({
      id: ['r0', 'r1'],
      text: [null, 'valid'],
      scope_tenant: ['t1', 't1'],
      scope_session: ['s1', 's1'],
      valid_from: new BigInt64Array([BigInt(0), BigInt(Date.now())]),
      importance: new Float64Array([0.5, 0.5]),
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records.length).toBe(1)
  })

  it('fromFrame: default priority 3 when importance is null', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: ['t1'],
      scope_session: ['s1'],
      valid_from: new BigInt64Array([BigInt(Date.now())]),
      importance: [null],
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records[0]?.priority).toBe(3)
  })

  it('fromFrame: default threadId="unknown" when scope_session null', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: ['t1'],
      scope_session: [null],
      valid_from: new BigInt64Array([BigInt(Date.now())]),
      importance: new Float64Array([0.5]),
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records[0]?.threadId).toBe('unknown')
  })

  it('fromFrame: default resourceId="unknown" when scope_tenant null', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: [null],
      scope_session: ['s1'],
      valid_from: new BigInt64Array([BigInt(Date.now())]),
      importance: new Float64Array([0.5]),
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records[0]?.resourceId).toBe('unknown')
  })

  it('fromFrame: null valid_from falls back to current time ISO', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: ['t1'],
      scope_session: ['s1'],
      valid_from: [null],
      importance: new Float64Array([0.5]),
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records[0]?.date).toMatch(/\d{4}-/)
  })

  it('fromFrame: malformed payload_json is skipped (try/catch)', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: ['t1'],
      scope_session: ['s1'],
      valid_from: new BigInt64Array([BigInt(Date.now())]),
      importance: new Float64Array([0.5]),
      payload_json: ['not json {{{'],
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records.length).toBe(1)
    expect(records[0]?.tags).toBeUndefined()
  })

  it('fromFrame: payload_json without tags array is ignored', () => {
    const table = tableFromArrays({
      id: ['r0'],
      text: ['hello'],
      scope_tenant: ['t1'],
      scope_session: ['s1'],
      valid_from: new BigInt64Array([BigInt(Date.now())]),
      importance: new Float64Array([0.5]),
      payload_json: ['{"other":"field"}'],
    }) as Table
    const records = adapter.fromFrame(table)
    expect(records[0]?.tags).toBeUndefined()
  })
})
