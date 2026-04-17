/**
 * Deep coverage tests for @dzupagent/memory-ipc (Wave 22, W22-B1).
 *
 * Covers MEMORY_FRAME_SCHEMA field-level validation, Arrow IPC round-trips
 * (including oversized frames), cache-delta semantics (additions, removals,
 * modifications, merges), token-budget eviction/reset, phase-memory-selection
 * ordering, and shared-channel concurrent write integration.
 */

import { describe, it, expect, vi } from 'vitest'
import { tableFromArrays, Dictionary, type Table } from 'apache-arrow'

import {
  MEMORY_FRAME_SCHEMA,
  MEMORY_FRAME_VERSION,
  MEMORY_FRAME_COLUMNS,
  MEMORY_FRAME_FIELD_COUNT,
} from '../schema.js'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from '../ipc-serializer.js'
import { computeFrameDelta } from '../cache-delta.js'
import {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from '../token-budget.js'
import {
  phaseWeightedSelection,
  PHASE_NAMESPACE_WEIGHTS,
  PHASE_CATEGORY_WEIGHTS,
  type ConversationPhase,
} from '../phase-memory-selection.js'
import { SharedMemoryChannel } from '../shared-memory-channel.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildSpec {
  id: string
  namespace?: string
  key?: string
  text?: string
  category?: string | null
  importance?: number | null
  decayStrength?: number | null
  systemCreatedAt?: number
  tenant?: string | null
  project?: string | null
  agent?: string | null
  session?: string | null
  agentId?: string | null
  source?: string | null
  extra?: Record<string, unknown>
}

function buildTable(records: readonly BuildSpec[]): Table {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      importance: r.importance ?? null,
      category: r.category ?? null,
      _decay: { strength: r.decayStrength ?? null },
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
      },
      _provenance: {
        createdBy: r.agentId ?? null,
        source: r.source ?? null,
      },
      ...(r.extra ?? {}),
    }
    const meta: FrameRecordMeta = {
      id: r.id,
      namespace: r.namespace ?? 'test',
      key: r.key ?? r.id,
      scope: {
        tenant: r.tenant ?? null,
        project: r.project ?? null,
        agent: r.agent ?? null,
        session: r.session ?? null,
      },
    }
    builder.add(value, meta)
  }
  return builder.build()
}

// ---------------------------------------------------------------------------
// Schema — field-level assertions (10 tests)
// ---------------------------------------------------------------------------

describe('Schema — MEMORY_FRAME_SCHEMA required field validation', () => {
  it('identity fields (id, namespace, key) are all present and in order', () => {
    expect(MEMORY_FRAME_COLUMNS[0]).toBe('id')
    expect(MEMORY_FRAME_COLUMNS[1]).toBe('namespace')
    expect(MEMORY_FRAME_COLUMNS[2]).toBe('key')
  })

  it('required (non-nullable) fields are: id, namespace, key, system_created_at, valid_from, is_active', () => {
    const required = MEMORY_FRAME_SCHEMA.fields
      .filter((f) => !f.nullable)
      .map((f) => f.name)
    expect(required).toEqual(
      expect.arrayContaining([
        'id',
        'namespace',
        'key',
        'system_created_at',
        'valid_from',
        'is_active',
      ]),
    )
    expect(required.length).toBe(6)
  })

  it('content fields (text, payload_json) are nullable', () => {
    const text = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === 'text')
    const payload = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'payload_json',
    )
    expect(text?.nullable).toBe(true)
    expect(payload?.nullable).toBe(true)
  })

  it('temporal optional fields (system_expired_at, valid_until) are nullable', () => {
    const expired = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'system_expired_at',
    )
    const until = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'valid_until',
    )
    expect(expired?.nullable).toBe(true)
    expect(until?.nullable).toBe(true)
  })

  it('dictionary-encoded columns use Dictionary<Utf8, Int32> type', () => {
    const dictCols = ['namespace', 'agent_id', 'category', 'provenance_source']
    for (const name of dictCols) {
      const f = MEMORY_FRAME_SCHEMA.fields.find((c) => c.name === name)
      expect(f).toBeDefined()
      expect(f?.type).toBeInstanceOf(Dictionary)
    }
  })

  it('schema metadata preserves memory_frame_version value across reads', () => {
    const stored = MEMORY_FRAME_SCHEMA.metadata.get('memory_frame_version')
    expect(stored).toBe(String(MEMORY_FRAME_VERSION))
    expect(Number(stored)).toBe(1)
  })

  it('MEMORY_FRAME_COLUMNS and MEMORY_FRAME_FIELD_COUNT are in sync', () => {
    expect(MEMORY_FRAME_COLUMNS.length).toBe(MEMORY_FRAME_FIELD_COUNT)
    expect(MEMORY_FRAME_SCHEMA.fields.length).toBe(MEMORY_FRAME_FIELD_COUNT)
  })

  it('all expected columns are present (no silently dropped fields)', () => {
    const expectedCols = [
      'id',
      'namespace',
      'key',
      'scope_tenant',
      'scope_project',
      'scope_agent',
      'scope_session',
      'text',
      'payload_json',
      'system_created_at',
      'system_expired_at',
      'valid_from',
      'valid_until',
      'decay_strength',
      'decay_half_life_ms',
      'decay_last_accessed_at',
      'decay_access_count',
      'agent_id',
      'category',
      'importance',
      'provenance_source',
      'is_active',
    ]
    for (const col of expectedCols) {
      expect(MEMORY_FRAME_COLUMNS).toContain(col)
    }
  })

  it('version constant is preserved through schema re-reads', () => {
    // Read twice, value must not mutate
    const v1 = MEMORY_FRAME_SCHEMA.metadata.get('memory_frame_version')
    const v2 = MEMORY_FRAME_SCHEMA.metadata.get('memory_frame_version')
    expect(v1).toBe(v2)
    expect(v1).toBe('1')
  })

  it('provenance fields (agent_id, category, provenance_source) are optional (nullable)', () => {
    const agentId = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'agent_id',
    )
    const category = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'category',
    )
    const source = MEMORY_FRAME_SCHEMA.fields.find(
      (f) => f.name === 'provenance_source',
    )
    expect(agentId?.nullable).toBe(true)
    expect(category?.nullable).toBe(true)
    expect(source?.nullable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// MemoryFrame serialization round-trips (8 tests)
// ---------------------------------------------------------------------------

describe('MemoryFrame serialization — Arrow IPC round-trips', () => {
  it('preserves all identity fields through serialize -> deserialize', () => {
    const table = buildTable([
      { id: 'id-1', namespace: 'decisions', key: 'key-1' },
      { id: 'id-2', namespace: 'lessons', key: 'key-2' },
    ])
    const bytes = serializeToIPC(table)
    const restored = deserializeFromIPC(bytes)

    expect(restored.numRows).toBe(2)
    expect(restored.getChild('id')?.get(0)).toBe('id-1')
    expect(restored.getChild('id')?.get(1)).toBe('id-2')
    expect(restored.getChild('namespace')?.get(0)).toBe('decisions')
    expect(restored.getChild('key')?.get(1)).toBe('key-2')
  })

  it('preserves optional scope fields through round-trip', () => {
    const table = buildTable([
      {
        id: 's1',
        tenant: 'tenant-A',
        project: 'proj-X',
        agent: 'agent-42',
        session: 'sess-9',
      },
    ])
    const restored = deserializeFromIPC(serializeToIPC(table))
    expect(restored.getChild('scope_tenant')?.get(0)).toBe('tenant-A')
    expect(restored.getChild('scope_project')?.get(0)).toBe('proj-X')
    expect(restored.getChild('scope_agent')?.get(0)).toBe('agent-42')
    expect(restored.getChild('scope_session')?.get(0)).toBe('sess-9')
  })

  it('reconstructs records via FrameReader.toRecords() with correct fields', () => {
    const table = buildTable([
      {
        id: 'full-1',
        namespace: 'ns',
        text: 'content',
        importance: 0.75,
        category: 'decision',
        agentId: 'agent-abc',
        source: 'llm',
        extra: { custom: 'val' },
      },
    ])
    const bytes = serializeToIPC(table)
    const reader = FrameReader.fromIPC(bytes)
    const records = reader.toRecords()

    expect(records.length).toBe(1)
    expect(records[0]?.meta.id).toBe('full-1')
    expect(records[0]?.value.text).toBe('content')
    expect(records[0]?.value.importance).toBe(0.75)
    expect(records[0]?.value.category).toBe('decision')
    expect(records[0]?.value._agent).toBe('agent-abc')
    expect(records[0]?.value._provenance?.source).toBe('llm')
    // Overflow field
    expect(records[0]?.value.custom).toBe('val')
  })

  it('base64 round-trip preserves bytes exactly', () => {
    const table = buildTable([
      { id: 'r1', text: 'hello world' },
      { id: 'r2', text: 'goodbye' },
    ])
    const original = serializeToIPC(table)
    const encoded = ipcToBase64(original)
    const decoded = base64ToIPC(encoded)

    expect(decoded.byteLength).toBe(original.byteLength)
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBe(original[i])
    }
  })

  it('handles large frames (>1MB) without corruption', () => {
    // Build a frame with a large text payload per record to exceed ~1MB IPC size
    const longText = 'x'.repeat(2048) // ~2KB per record
    const records = Array.from({ length: 600 }, (_, i) => ({
      id: `bulk-${i}`,
      text: `${longText}-${i}`,
    }))
    const table = buildTable(records)

    const bytes = serializeToIPC(table)
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024)

    const restored = deserializeFromIPC(bytes)
    expect(restored.numRows).toBe(600)
    // Spot-check a record
    const txt = restored.getChild('text')?.get(599)
    expect(String(txt).endsWith('-599')).toBe(true)
  })

  it('numeric and bigint fields round-trip exactly', () => {
    const now = 1700000000000
    const builder = new FrameBuilder()
    builder.add(
      {
        text: 'numeric-check',
        importance: 0.42,
        _decay: {
          strength: 0.88,
          halfLifeMs: 86_400_000,
          lastAccessedAt: now - 1000,
          accessCount: 123,
        },
        _temporal: {
          systemCreatedAt: now,
          systemExpiredAt: now + 5000,
          validFrom: now,
          validUntil: now + 10000,
        },
      },
      { id: 'n1', namespace: 'ns', key: 'n1' },
    )
    const table = builder.build()
    const restored = deserializeFromIPC(serializeToIPC(table))
    const reader = new FrameReader(restored)
    const records = reader.toRecords()
    expect(records[0]?.value.importance).toBe(0.42)
    expect(records[0]?.value._decay?.strength).toBe(0.88)
    expect(records[0]?.value._decay?.halfLifeMs).toBe(86_400_000)
    expect(records[0]?.value._decay?.accessCount).toBe(123)
    expect(records[0]?.value._temporal?.systemCreatedAt).toBe(now)
    expect(records[0]?.value._temporal?.systemExpiredAt).toBe(now + 5000)
    expect(records[0]?.value._temporal?.validUntil).toBe(now + 10000)
  })

  it('multi-row frame preserves row order', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `ord-${i.toString().padStart(3, '0')}`)
    const table = buildTable(ids.map((id, i) => ({ id, text: `text-${i}` })))
    const restored = deserializeFromIPC(serializeToIPC(table))
    for (let i = 0; i < ids.length; i++) {
      expect(restored.getChild('id')?.get(i)).toBe(ids[i])
    }
  })

  it('is_active flag round-trips correctly (derived from expiry)', () => {
    const builder = new FrameBuilder()
    builder.add(
      { text: 'active', _temporal: { systemCreatedAt: Date.now() } },
      { id: 'a1', namespace: 'ns', key: 'a1' },
    )
    builder.add(
      {
        text: 'expired',
        _temporal: { systemCreatedAt: Date.now(), systemExpiredAt: Date.now() },
      },
      { id: 'e1', namespace: 'ns', key: 'e1' },
    )
    const restored = deserializeFromIPC(serializeToIPC(builder.build()))
    expect(restored.getChild('is_active')?.get(0)).toBe(true)
    expect(restored.getChild('is_active')?.get(1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CacheDelta — semantic correctness (9 tests)
// ---------------------------------------------------------------------------

describe('CacheDelta — computeFrameDelta', () => {
  it('identical frames produce empty delta', () => {
    const t1 = buildTable([
      { id: 'a', text: 'same' },
      { id: 'b', text: 'same' },
    ])
    const t2 = buildTable([
      { id: 'a', text: 'same' },
      { id: 'b', text: 'same' },
    ])
    const delta = computeFrameDelta(t1, t2)
    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(0)
    expect(delta.changeRatio).toBe(0)
    expect(delta.shouldRefreeze).toBe(false)
  })

  it('detects addition with no other changes', () => {
    const t1 = buildTable([{ id: 'a', text: 'x' }])
    const t2 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
    ])
    const delta = computeFrameDelta(t1, t2)
    expect(delta.added).toBe(1)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(0)
    expect(delta.currentTotal).toBe(2)
  })

  it('detects removal with no other changes', () => {
    const t1 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
    ])
    const t2 = buildTable([{ id: 'a', text: 'x' }])
    const delta = computeFrameDelta(t1, t2)
    expect(delta.removed).toBe(1)
    expect(delta.added).toBe(0)
    expect(delta.modified).toBe(0)
  })

  it('detects in-place text modification via content hash', () => {
    const t1 = buildTable([{ id: 'a', text: 'original content' }])
    const t2 = buildTable([{ id: 'a', text: 'modified content' }])
    const delta = computeFrameDelta(t1, t2)
    expect(delta.modified).toBe(1)
    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(0)
  })

  it('merging two non-overlapping deltas produces union of IDs', () => {
    // Start frame
    const base = buildTable([{ id: 'a', text: 'x' }])
    // First delta: +b
    const afterAdd1 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
    ])
    // Second delta: +c on top of afterAdd1
    const afterAdd2 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
      { id: 'c', text: 'z' },
    ])
    const d1 = computeFrameDelta(base, afterAdd1)
    const d2 = computeFrameDelta(afterAdd1, afterAdd2)
    // Merged (union): base -> afterAdd2
    const merged = computeFrameDelta(base, afterAdd2)

    // Union of "added" = d1.added + d2.added (both disjoint)
    expect(d1.added + d2.added).toBe(merged.added)
    expect(merged.removed).toBe(0)
  })

  it('applying delta (adding new records) brings source table to target', () => {
    const target = buildTable([
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
      { id: 'c', text: 'three' },
    ])
    const source = buildTable([{ id: 'a', text: 'one' }])

    // Delta from source to target: 2 added
    const delta = computeFrameDelta(source, target)
    expect(delta.added).toBe(2)

    // Reverse direction: should show the inverse
    const inverse = computeFrameDelta(target, source)
    expect(inverse.removed).toBe(2)
    expect(inverse.added).toBe(0)
  })

  it('respects custom refreeze threshold (low threshold trips earlier)', () => {
    const frozen = buildTable(
      Array.from({ length: 100 }, (_, i) => ({
        id: `r${i}`,
        text: `t${i}`,
      })),
    )
    // Add 2 records (2% change)
    const current = buildTable([
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `r${i}`,
        text: `t${i}`,
      })),
      { id: 'new-1', text: 'n1' },
      { id: 'new-2', text: 'n2' },
    ])
    const strict = computeFrameDelta(frozen, current, 0.01)
    const lenient = computeFrameDelta(frozen, current, 0.5)
    expect(strict.shouldRefreeze).toBe(true)
    expect(lenient.shouldRefreeze).toBe(false)
  })

  it('computes change ratio using max(frozen, current) as denominator', () => {
    const t1 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
    ])
    // +1 addition => total=3 records, so denominator=max(2,3)=3
    const t2 = buildTable([
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
      { id: 'c', text: 'z' },
    ])
    const delta = computeFrameDelta(t1, t2)
    expect(delta.changeRatio).toBeCloseTo(1 / 3, 5)
  })

  it('payload_json change is detected as modification', () => {
    const t1 = buildTable([
      { id: 'a', text: 'same', extra: { foo: 1 } },
    ])
    const t2 = buildTable([
      { id: 'a', text: 'same', extra: { foo: 2 } },
    ])
    const delta = computeFrameDelta(t1, t2)
    // Content hash includes text + payload_json, so payload change → modified
    expect(delta.modified).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// TokenBudget — eviction, counters, reset (8 tests)
// ---------------------------------------------------------------------------

describe('TokenBudget — selection, eviction, and counters', () => {
  it('returns [] when budget exceeded by every record', () => {
    // Each record: 100 chars → 25 tokens. Budget=10 → nothing fits.
    const table = buildTable(
      Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        text: 'x'.repeat(100),
        importance: 0.5,
        decayStrength: 1.0,
      })),
    )
    const selected = selectMemoriesByBudget(table, 10)
    expect(selected).toEqual([])
  })

  it('evicts lowest-efficiency records when budget tight', () => {
    const now = Date.now()
    // 3 records with identical token cost but different scores
    const records = [
      { id: 'lo', namespace: 'ns', text: 'x'.repeat(40), importance: 0.1, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'mid', namespace: 'ns', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'hi', namespace: 'ns', text: 'x'.repeat(40), importance: 0.95, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)
    // Each ~10 tokens, budget=20 fits 2
    const selected = selectMemoriesByBudget(table, 22, { now })
    expect(selected.length).toBe(2)
    // Should keep 'hi' and 'mid', evict 'lo'
    const ids = selected.map((s) => s.rowIndex).sort()
    expect(ids).toEqual([1, 2])
  })

  it('total token cost never exceeds budget', () => {
    const now = Date.now()
    const records = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'ns',
      text: 'x'.repeat(200),
      importance: 0.3,
      decayStrength: 1.0,
      systemCreatedAt: now - i * 1000,
    }))
    const table = buildTable(records)
    const selected = selectMemoriesByBudget(table, 500, { now })
    const total = selected.reduce((sum, r) => sum + r.tokenCost, 0)
    expect(total).toBeLessThanOrEqual(500)
  })

  it('allocator.rebalance(0) leaves memory budget available', () => {
    const now = Date.now()
    const table = buildTable(
      Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        namespace: 'ns',
        text: 'x'.repeat(40),
        importance: 0.5,
        decayStrength: 1.0,
        systemCreatedAt: now,
      })),
    )
    const alloc = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 500,
      toolTokens: 500,
      memoryFrame: table,
    })
    const r = alloc.rebalance(0)
    expect(r.conversationTokens).toBe(0)
    // Memory tokens should be > 0 (full memory budget available)
    expect(r.memoryTokens).toBeGreaterThan(0)
  })

  it('allocator respects maxMemoryFraction cap', () => {
    const now = Date.now()
    // Build a huge memory pool that would otherwise consume all tokens
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'ns',
      text: 'x'.repeat(400),
      importance: 0.9,
      decayStrength: 1.0,
      systemCreatedAt: now,
    }))
    const table = buildTable(records)
    const alloc = new TokenBudgetAllocator({
      totalBudget: 10000,
      systemPromptTokens: 100,
      toolTokens: 100,
      memoryFrame: table,
      maxMemoryFraction: 0.2,
      minResponseReserve: 500,
    })
    const r = alloc.rebalance(100)
    // Memory tokens must not exceed 20% of total budget
    expect(r.memoryTokens).toBeLessThanOrEqual(2000)
  })

  it('allocator fixed slots (system prompt, tools) stay constant across rebalance', () => {
    const table = buildTable([{ id: 'r0', namespace: 'ns' }])
    const alloc = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 777,
      toolTokens: 333,
      memoryFrame: table,
    })
    const r1 = alloc.rebalance(100)
    const r2 = alloc.rebalance(2000)
    const r3 = alloc.rebalance(5000)
    expect(r1.systemPromptTokens).toBe(777)
    expect(r2.systemPromptTokens).toBe(777)
    expect(r3.systemPromptTokens).toBe(777)
    expect(r1.toolTokens).toBe(333)
    expect(r2.toolTokens).toBe(333)
    expect(r3.toolTokens).toBe(333)
  })

  it('updateFrame() effectively "resets" the memory pool', () => {
    const t1 = buildTable(
      Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        namespace: 'ns',
        text: 'x'.repeat(40),
      })),
    )
    const t2 = buildTable([]) // empty — simulates reset/clear
    const alloc = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 100,
      toolTokens: 100,
      memoryFrame: t1,
    })
    const before = alloc.rebalance(100)
    expect(before.selectedMemoryIndices.length).toBeGreaterThan(0)
    alloc.updateFrame(t2)
    const after = alloc.rebalance(100)
    expect(after.selectedMemoryIndices).toEqual([])
    expect(after.memoryTokens).toBe(0)
  })

  it('minResponseReserve is respected (never drops below)', () => {
    const now = Date.now()
    const records = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'ns',
      text: 'x'.repeat(400),
      importance: 0.9,
      decayStrength: 1.0,
      systemCreatedAt: now,
    }))
    const table = buildTable(records)
    const alloc = new TokenBudgetAllocator({
      totalBudget: 10000,
      systemPromptTokens: 200,
      toolTokens: 200,
      memoryFrame: table,
      minResponseReserve: 3500,
    })
    const r = alloc.rebalance(3000)
    expect(r.responseReserve).toBeGreaterThanOrEqual(3500)
  })
})

// ---------------------------------------------------------------------------
// PhaseMemorySelection — ordering and phase priorities (8 tests)
// ---------------------------------------------------------------------------

describe('PhaseMemorySelection — phase-aware priority ordering', () => {
  it('empty table returns []', () => {
    const table = buildTable([])
    expect(phaseWeightedSelection(table, 'coding', 10000)).toEqual([])
  })

  it('zero budget returns []', () => {
    const table = buildTable([{ id: 'r0', namespace: 'ns' }])
    expect(phaseWeightedSelection(table, 'debugging', 0)).toEqual([])
  })

  it('unknown-seeming phases fall back to general (no multiplier)', () => {
    // 'general' phase has empty weight tables
    const now = Date.now()
    const records = [
      { id: 'a', namespace: 'decisions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'b', namespace: 'observations', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)
    const selected = phaseWeightedSelection(table, 'general', 100000, { now })
    expect(selected.length).toBe(2)
    // With no phase multiplier, scores are equal
    expect(selected[0]?.score).toBeCloseTo(selected[1]!.score, 5)
  })

  it('priority ordering: debugging phase prefers lessons > incidents > conventions', () => {
    // PHASE_NAMESPACE_WEIGHTS.debugging: lessons=2.5, incidents=2.0, conventions=0.8
    expect(PHASE_NAMESPACE_WEIGHTS.debugging.lessons).toBe(2.5)
    expect(PHASE_NAMESPACE_WEIGHTS.debugging.incidents).toBe(2.0)
    expect(PHASE_NAMESPACE_WEIGHTS.debugging.conventions).toBe(0.8)
  })

  it('category weights stack multiplicatively on top of namespace weights', () => {
    const now = Date.now()
    // Two identical records except one has lesson category boost
    const records = [
      { id: 'ns-only', namespace: 'lessons', category: null, text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'ns+cat', namespace: 'lessons', category: 'lesson', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)
    const selected = phaseWeightedSelection(table, 'debugging', 100000, { now })
    // ns+cat should have higher score (namespace * category multiplier)
    const nsOnly = selected.find((s) => s.rowIndex === 0)!
    const nsCat = selected.find((s) => s.rowIndex === 1)!
    expect(nsCat.score).toBeGreaterThan(nsOnly.score)
  })

  it('custom namespaceWeights override default phase weights', () => {
    const now = Date.now()
    const records = [
      { id: 'low', namespace: 'conventions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'high', namespace: 'custom-ns', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)
    const selected = phaseWeightedSelection(table, 'coding', 11, {
      now,
      namespaceWeights: { 'custom-ns': 10 },
    })
    expect(selected.length).toBe(1)
    // custom-ns got 10x boost, so it wins
    expect(selected[0]?.rowIndex).toBe(1)
  })

  it('all phases have defined weight tables (no missing phases)', () => {
    const phases: ConversationPhase[] = [
      'planning',
      'coding',
      'debugging',
      'reviewing',
      'general',
    ]
    for (const p of phases) {
      expect(PHASE_NAMESPACE_WEIGHTS[p]).toBeDefined()
      expect(PHASE_CATEGORY_WEIGHTS[p]).toBeDefined()
    }
  })

  it('reviewing phase de-prioritizes observations (weight 0.5)', () => {
    expect(PHASE_NAMESPACE_WEIGHTS.reviewing.observations).toBe(0.5)
    expect(PHASE_CATEGORY_WEIGHTS.reviewing.observation).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// Shared memory channel — concurrent writes and multi-agent integration (6 tests)
// ---------------------------------------------------------------------------

describe('Integration — SharedMemoryChannel write/read round-trip', () => {
  it('writes MemoryFrame, reads back, deserializes to matching fields', () => {
    const table = buildTable([
      {
        id: 'xfer-1',
        namespace: 'ns',
        text: 'transported content',
        importance: 0.42,
      },
    ])
    const channel = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 4 })
    const handle = channel.writeTable(table)
    const restored = channel.readTable(handle)

    expect(restored.numRows).toBe(1)
    expect(restored.getChild('id')?.get(0)).toBe('xfer-1')
    expect(restored.getChild('text')?.get(0)).toBe('transported content')
    expect(restored.getChild('importance')?.get(0)).toBe(0.42)
  })

  it('multiple concurrent writes from different agents do not corrupt data', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 4 * 1024 * 1024, maxSlots: 8 })
    // 4 different agents writing their own tables
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d']
    const handles = agents.map((agentId, i) => {
      const table = buildTable([
        { id: `${agentId}-rec-${i}`, namespace: agentId, text: `from ${agentId}` },
      ])
      return { agentId, handle: channel.writeTable(table) }
    })

    // Read back every handle and verify isolation (no cross-contamination)
    for (const { agentId, handle } of handles) {
      const table = channel.readTable(handle)
      expect(table.numRows).toBe(1)
      expect(table.getChild('namespace')?.get(0)).toBe(agentId)
      expect(String(table.getChild('text')?.get(0))).toContain(agentId)
    }
  })

  it('release() frees slot for reuse', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 2 })
    const t1 = buildTable([{ id: 'a', text: 'first' }])
    const t2 = buildTable([{ id: 'b', text: 'second' }])
    const t3 = buildTable([{ id: 'c', text: 'third' }])

    const h1 = channel.writeTable(t1)
    const h2 = channel.writeTable(t2)
    // Slots full; releasing h1 opens one
    channel.release(h1)
    const h3 = channel.writeTable(t3)
    expect(h3.slotIndex).toBe(h1.slotIndex)
    // h2 still valid
    const read2 = channel.readTable(h2)
    expect(read2.getChild('id')?.get(0)).toBe('b')
  })

  it('dispose() resets all slots so new writes start at slot 0', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 4 })
    channel.writeTable(buildTable([{ id: 'r1' }]))
    channel.writeTable(buildTable([{ id: 'r2' }]))
    channel.dispose()
    const next = channel.writeTable(buildTable([{ id: 'fresh' }]))
    expect(next.slotIndex).toBe(0)
  })

  it('sharedBuffer is a SharedArrayBuffer', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 2 })
    const buf = channel.sharedBuffer
    expect(buf).toBeInstanceOf(SharedArrayBuffer)
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('consumer-side channel (existingBuffer) rejects writes when multiWriter=false', () => {
    const producer = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 2 })
    const consumer = new SharedMemoryChannel({
      existingBuffer: producer.sharedBuffer,
    })
    expect(() =>
      consumer.write(new Uint8Array([1, 2, 3])),
    ).toThrow(/consumer-side instance/)
  })
})

// ---------------------------------------------------------------------------
// Error paths — corrupt IPC, oversized frames, schema violations (7 tests)
// ---------------------------------------------------------------------------

describe('Error paths — corrupt IPC, oversized frames, validation failures', () => {
  it('corrupt IPC buffer returns empty Table (non-fatal)', () => {
    // Non-fatal contract: deserializeFromIPC swallows errors and returns empty
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const table = deserializeFromIPC(garbage)
    expect(table.numRows).toBe(0)
  })

  it('oversized frame (> channel data region) rejects with error', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024, maxSlots: 2 })
    const huge = new Uint8Array(2048) // 2KB > 1KB
    expect(() => channel.write(huge)).toThrow(/exceeds data region/)
  })

  it('zero-length write rejects with typed error message', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024, maxSlots: 2 })
    expect(() => channel.write(new Uint8Array(0))).toThrow(/zero-length/)
  })

  it('all slots full returns error when no slots available', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024 * 1024, maxSlots: 2 })
    channel.write(new Uint8Array([1, 2, 3]))
    channel.write(new Uint8Array([4, 5, 6]))
    // Slots exhausted
    expect(() => channel.write(new Uint8Array([7, 8, 9]))).toThrow(
      /no free slots/,
    )
  })

  it('invalid slot index rejected in read', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024, maxSlots: 2 })
    expect(() =>
      channel.read({ slotIndex: 99, offset: 0, length: 10 }),
    ).toThrow(/invalid slot index/)
  })

  it('reading a FREE slot throws with state info', () => {
    const channel = new SharedMemoryChannel({ maxBytes: 1024, maxSlots: 2 })
    // Slot 0 is FREE (never written)
    expect(() =>
      channel.read({ slotIndex: 0, offset: 0, length: 5 }),
    ).toThrow(/not readable/)
  })

  it('ipcToBase64 on invalid input returns empty string (non-fatal)', () => {
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('forced failure')
    })
    try {
      const result = ipcToBase64(new Uint8Array([1, 2, 3]))
      expect(result).toBe('')
    } finally {
      spy.mockRestore()
    }
  })

  it('base64ToIPC on Buffer.from error returns empty Uint8Array', () => {
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('forced failure')
    })
    try {
      const result = base64ToIPC('anytext')
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result.byteLength).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('FrameBuilder is single-use: second build() throws', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 't' }, { id: 'a', namespace: 'ns', key: 'a' })
    builder.build()
    expect(() => builder.build()).toThrow(/already been consumed/)
  })

  it('FrameBuilder.add() after build() throws (validation guard)', () => {
    const builder = new FrameBuilder()
    builder.build()
    expect(() =>
      builder.add({ text: 't' }, { id: 'a', namespace: 'ns', key: 'a' }),
    ).toThrow(/already been consumed/)
  })

  it('missing required field: tableFromArrays with absent id column → read gives empty string', () => {
    // Simulate a corrupt frame: manually construct a table without an `id` column
    const badTable = tableFromArrays({
      namespace: ['ns'],
      key: ['k'],
    })
    // FrameReader gracefully handles missing required columns by returning '' for id
    const records = new FrameReader(badTable).toRecords()
    expect(records.length).toBe(1)
    expect(records[0]?.meta.id).toBe('')
    expect(records[0]?.meta.namespace).toBe('ns')
  })
})
