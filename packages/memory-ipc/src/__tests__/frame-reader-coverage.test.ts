/**
 * Coverage tests for frame-reader.ts — filters, toRecords, factories.
 */

import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import { serializeToIPC } from '../ipc-serializer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReader(
  records: Array<{
    id: string
    namespace: string
    key: string
    text?: string
    agentId?: string
    category?: string
    importance?: number
    decayStrength?: number | null
    isActive?: boolean
    provenanceSource?: string
    scopeTenant?: string
    scopeProject?: string
    scopeAgent?: string
    scopeSession?: string
    systemCreatedAt?: number
    systemExpiredAt?: number | null
    validFrom?: number
    validUntil?: number | null
  }>,
): FrameReader {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Text for ${r.id}`,
      importance: r.importance ?? null,
      category: r.category ?? null,
      _agent: r.agentId ?? null,
      _decay: {
        strength: r.decayStrength ?? null,
        halfLifeMs: null,
        lastAccessedAt: null,
        accessCount: null,
      },
      _provenance: r.provenanceSource ? { source: r.provenanceSource } : undefined,
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
        systemExpiredAt: r.systemExpiredAt ?? null,
        validFrom: r.validFrom ?? Date.now(),
        validUntil: r.validUntil ?? null,
      },
    }
    const meta: FrameRecordMeta = {
      id: r.id,
      namespace: r.namespace,
      key: r.key,
      scope: (r.scopeTenant || r.scopeProject || r.scopeAgent || r.scopeSession)
        ? {
            tenant: r.scopeTenant ?? null,
            project: r.scopeProject ?? null,
            agent: r.scopeAgent ?? null,
            session: r.scopeSession ?? null,
          }
        : undefined,
    }
    builder.add(value, meta)
  }
  return new FrameReader(builder.build())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FrameReader — coverage', () => {
  describe('filterByAgent', () => {
    it('filters to matching agent_id', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0', agentId: 'agent-a' },
        { id: 'r1', namespace: 'ns', key: 'k1', agentId: 'agent-b' },
        { id: 'r2', namespace: 'ns', key: 'k2', agentId: 'agent-a' },
      ])
      const filtered = reader.filterByAgent('agent-a')
      expect(filtered.rowCount).toBe(2)
    })

    it('returns empty when no agent matches', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0', agentId: 'agent-a' },
      ])
      const filtered = reader.filterByAgent('agent-missing')
      expect(filtered.rowCount).toBe(0)
    })
  })

  describe('filterByDecayAbove', () => {
    it('includes records above threshold', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0', decayStrength: 0.8 },
        { id: 'r1', namespace: 'ns', key: 'k1', decayStrength: 0.2 },
        { id: 'r2', namespace: 'ns', key: 'k2', decayStrength: 0.5 },
      ])
      const filtered = reader.filterByDecayAbove(0.5)
      expect(filtered.rowCount).toBe(2) // 0.8 and 0.5 (>= threshold)
    })

    it('includes records with null decay (not subject to decay)', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0', decayStrength: null },
        { id: 'r1', namespace: 'ns', key: 'k1', decayStrength: 0.01 },
      ])
      const filtered = reader.filterByDecayAbove(0.5)
      expect(filtered.rowCount).toBe(1) // Only null passes
    })
  })

  describe('filterActive', () => {
    it('filters to active records only', () => {
      // FrameBuilder always sets is_active=true, but we can test the filter
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0' },
        { id: 'r1', namespace: 'ns', key: 'k1' },
      ])
      const filtered = reader.filterActive()
      // All records from FrameBuilder are active
      expect(filtered.rowCount).toBe(2)
    })
  })

  describe('filterByNamespace', () => {
    it('returns only matching namespace rows', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'lessons', key: 'k0' },
        { id: 'r1', namespace: 'decisions', key: 'k1' },
        { id: 'r2', namespace: 'lessons', key: 'k2' },
      ])
      const filtered = reader.filterByNamespace('lessons')
      expect(filtered.rowCount).toBe(2)
    })

    it('returns empty for non-existent namespace', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'lessons', key: 'k0' },
      ])
      const filtered = reader.filterByNamespace('missing')
      expect(filtered.rowCount).toBe(0)
    })
  })

  describe('accessors', () => {
    it('returns correct rowCount', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0' },
        { id: 'r1', namespace: 'ns', key: 'k1' },
      ])
      expect(reader.rowCount).toBe(2)
    })

    it('returns unique namespaces', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'a', key: 'k0' },
        { id: 'r1', namespace: 'b', key: 'k1' },
        { id: 'r2', namespace: 'a', key: 'k2' },
      ])
      const ns = reader.namespaces
      expect(ns).toHaveLength(2)
      expect(ns).toContain('a')
      expect(ns).toContain('b')
    })

    it('getColumn returns null for unknown column', () => {
      const reader = buildReader([{ id: 'r0', namespace: 'ns', key: 'k0' }])
      expect(reader.getColumn('nonexistent_column')).toBeNull()
    })

    it('getTable returns the underlying Arrow table', () => {
      const reader = buildReader([{ id: 'r0', namespace: 'ns', key: 'k0' }])
      const table = reader.getTable()
      expect(table.numRows).toBe(1)
    })

    it('schema returns the table schema', () => {
      const reader = buildReader([{ id: 'r0', namespace: 'ns', key: 'k0' }])
      expect(reader.schema).toBeDefined()
      expect(reader.schema.fields.length).toBeGreaterThan(0)
    })
  })

  describe('fromIPC', () => {
    it('constructs from IPC bytes', () => {
      const builder = new FrameBuilder()
      builder.add({ text: 'hello' }, { id: 'r0', namespace: 'ns', key: 'k0' })
      const table = builder.build()
      const bytes = serializeToIPC(table)
      const reader = FrameReader.fromIPC(bytes)
      expect(reader.rowCount).toBe(1)
    })
  })

  describe('toRecords', () => {
    it('reconstructs full records with all convention fields', () => {
      const reader = buildReader([
        {
          id: 'r0',
          namespace: 'lessons',
          key: 'k0',
          text: 'Remember this',
          agentId: 'agent-1',
          category: 'lesson',
          importance: 0.9,
          decayStrength: 0.8,
          provenanceSource: 'user-input',
          scopeTenant: 'tenant-1',
          scopeProject: 'proj-1',
          systemCreatedAt: 1700000000000,
          validFrom: 1700000000000,
        },
      ])

      const records = reader.toRecords()
      expect(records).toHaveLength(1)

      const rec = records[0]!
      expect(rec.meta.id).toBe('r0')
      expect(rec.meta.namespace).toBe('lessons')
      expect(rec.meta.key).toBe('k0')
      expect(rec.meta.scope?.tenant).toBe('tenant-1')
      expect(rec.meta.scope?.project).toBe('proj-1')
      expect(rec.value.text).toBe('Remember this')
      expect(rec.value._agent).toBe('agent-1')
      expect(rec.value.category).toBe('lesson')
      expect(rec.value.importance).toBe(0.9)
      expect(rec.value._decay?.strength).toBe(0.8)
      expect(rec.value._provenance?.source).toBe('user-input')
      expect(rec.value._provenance?.createdBy).toBe('agent-1')
      expect(rec.value._temporal?.systemCreatedAt).toBe(1700000000000)
    })

    it('handles records without optional fields', () => {
      const reader = buildReader([
        { id: 'r0', namespace: 'ns', key: 'k0' },
      ])
      const records = reader.toRecords()
      expect(records).toHaveLength(1)
      expect(records[0]!.meta.id).toBe('r0')
    })

    it('parses payload_json overflow fields', () => {
      const builder = new FrameBuilder()
      builder.add(
        { text: 'hello', customField: 'value', nested: { a: 1 } },
        { id: 'r0', namespace: 'ns', key: 'k0' },
      )
      const table = builder.build()
      const reader = new FrameReader(table)
      const records = reader.toRecords()

      // Extra fields are stored in payload_json and parsed back
      expect(records[0]!.value['customField']).toBe('value')
    })

    it('returns empty array for empty table', () => {
      const builder = new FrameBuilder()
      const reader = new FrameReader(builder.build())
      expect(reader.toRecords()).toEqual([])
    })
  })
})
