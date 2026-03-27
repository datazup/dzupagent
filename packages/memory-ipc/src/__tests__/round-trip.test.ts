import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import { serializeToIPC, deserializeFromIPC, ipcToBase64, base64ToIPC } from '../ipc-serializer.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'

function makeMeta(i: number): FrameRecordMeta {
  return {
    id: `rec-${i}`,
    namespace: 'decisions',
    key: `key-${i}`,
    scope: { tenant: 'tenant-1', project: 'proj-1', agent: 'agent-a', session: `sess-${i}` },
  }
}

function makeValue(i: number): FrameRecordValue {
  return {
    text: `Decision number ${i}: use PostgreSQL`,
    _temporal: {
      systemCreatedAt: 1700000000000 + i * 1000,
      systemExpiredAt: null,
      validFrom: 1700000000000 + i * 1000,
      validUntil: null,
    },
    _decay: {
      strength: 0.5 + (i % 10) * 0.05,
      halfLifeMs: 86400000,
      lastAccessedAt: 1700000000000 + i * 500,
      accessCount: i,
    },
    _provenance: { createdBy: 'agent-a', source: 'llm-generated' },
    category: 'decision',
    importance: 0.8,
    customField: `extra-${i}`,
  }
}

describe('FrameBuilder', () => {
  it('produces empty table from empty builder', () => {
    const builder = new FrameBuilder()
    const table = builder.build()
    expect(table.numRows).toBe(0)
  })

  it('builds a table with one record', () => {
    const builder = new FrameBuilder()
    builder.add(makeValue(0), makeMeta(0))
    const table = builder.build()
    expect(table.numRows).toBe(1)
    expect(table.getChild('id')?.get(0)).toBe('rec-0')
    expect(table.getChild('text')?.get(0)).toBe('Decision number 0: use PostgreSQL')
  })

  it('throws when build() called twice', () => {
    const builder = new FrameBuilder()
    builder.add(makeValue(0), makeMeta(0))
    builder.build()
    expect(() => builder.build()).toThrow()
  })

  it('supports addBatch()', () => {
    const builder = new FrameBuilder()
    const batch = Array.from({ length: 10 }, (_, i) => ({
      meta: makeMeta(i),
      value: makeValue(i),
    }))
    builder.addBatch(batch)
    const table = builder.build()
    expect(table.numRows).toBe(10)
  })

  it('reports count correctly', () => {
    const builder = new FrameBuilder()
    expect(builder.size).toBe(0)
    builder.add(makeValue(0), makeMeta(0))
    expect(builder.size).toBe(1)
    builder.add(makeValue(1), makeMeta(1))
    expect(builder.size).toBe(2)
  })

  it('handles records without _temporal or _decay', () => {
    const builder = new FrameBuilder()
    const value: FrameRecordValue = { text: 'simple value' }
    builder.add(value, { id: 'r1', namespace: 'test', key: 'k1' })
    const table = builder.build()
    expect(table.numRows).toBe(1)
    expect(table.getChild('decay_strength')?.get(0)).toBeNull()
  })

  it('puts overflow fields into payload_json', () => {
    const builder = new FrameBuilder()
    const value: FrameRecordValue = {
      text: 'hello',
      customField: 'extra',
      anotherField: 42,
    }
    builder.add(value, { id: 'r1', namespace: 'test', key: 'k1' })
    const table = builder.build()
    const payload = table.getChild('payload_json')?.get(0) as string
    expect(payload).toBeDefined()
    const parsed = JSON.parse(payload)
    expect(parsed.customField).toBe('extra')
    expect(parsed.anotherField).toBe(42)
  })

  it('toIPC() returns Uint8Array', () => {
    const builder = new FrameBuilder()
    builder.add(makeValue(0), makeMeta(0))
    const ipc = builder.toIPC()
    expect(ipc).toBeInstanceOf(Uint8Array)
    expect(ipc.length).toBeGreaterThan(0)
  })
})

describe('FrameReader', () => {
  function buildReader(count: number): FrameReader {
    const builder = new FrameBuilder()
    for (let i = 0; i < count; i++) {
      builder.add(makeValue(i), makeMeta(i))
    }
    return new FrameReader(builder.build())
  }

  it('reports rowCount', () => {
    const reader = buildReader(5)
    expect(reader.rowCount).toBe(5)
  })

  it('lists unique namespaces', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'a' }, { id: '1', namespace: 'decisions', key: 'k1' })
    builder.add({ text: 'b' }, { id: '2', namespace: 'lessons', key: 'k2' })
    builder.add({ text: 'c' }, { id: '3', namespace: 'decisions', key: 'k3' })
    const reader = new FrameReader(builder.build())
    const ns = reader.namespaces
    expect(ns).toContain('decisions')
    expect(ns).toContain('lessons')
    expect(ns.length).toBe(2)
  })

  it('getColumn returns Vector', () => {
    const reader = buildReader(3)
    const col = reader.getColumn('text')
    expect(col).not.toBeNull()
    expect(col?.length).toBe(3)
  })

  it('filterByNamespace returns correct subset', () => {
    const builder = new FrameBuilder()
    builder.add({ text: 'a' }, { id: '1', namespace: 'decisions', key: 'k1' })
    builder.add({ text: 'b' }, { id: '2', namespace: 'lessons', key: 'k2' })
    builder.add({ text: 'c' }, { id: '3', namespace: 'decisions', key: 'k3' })
    const reader = new FrameReader(builder.build())
    const filtered = reader.filterByNamespace('decisions')
    expect(filtered.rowCount).toBe(2)
  })

  it('filterActive returns only active records', () => {
    const builder = new FrameBuilder()
    builder.add(
      { text: 'active', _temporal: { systemCreatedAt: 1000, systemExpiredAt: null, validFrom: 1000 } },
      { id: '1', namespace: 'test', key: 'k1' },
    )
    builder.add(
      { text: 'expired', _temporal: { systemCreatedAt: 1000, systemExpiredAt: 2000, validFrom: 1000 } },
      { id: '2', namespace: 'test', key: 'k2' },
    )
    const reader = new FrameReader(builder.build())
    const filtered = reader.filterActive()
    expect(filtered.rowCount).toBe(1)
    const records = filtered.toRecords()
    expect(records[0].value.text).toBe('active')
  })

  it('filterByDecayAbove returns correct subset', () => {
    const builder = new FrameBuilder()
    builder.add(
      { text: 'strong', _decay: { strength: 0.8 } },
      { id: '1', namespace: 'test', key: 'k1' },
    )
    builder.add(
      { text: 'weak', _decay: { strength: 0.05 } },
      { id: '2', namespace: 'test', key: 'k2' },
    )
    builder.add(
      { text: 'no-decay' },
      { id: '3', namespace: 'test', key: 'k3' },
    )
    const reader = new FrameReader(builder.build())
    const filtered = reader.filterByDecayAbove(0.3)
    expect(filtered.rowCount).toBe(2) // strong + no-decay (null passes)
  })
})

describe('Full Round Trip: Record → Arrow → IPC → Arrow → Record', () => {
  it('preserves all convention fields through full round trip', () => {
    const originalMeta = makeMeta(42)
    const originalValue = makeValue(42)

    const builder = new FrameBuilder()
    builder.add(originalValue, originalMeta)
    const table = builder.build()

    // Table → IPC → Table
    const ipcBytes = serializeToIPC(table)
    const restored = deserializeFromIPC(ipcBytes)

    const reader = new FrameReader(restored)
    expect(reader.rowCount).toBe(1)

    const records = reader.toRecords()
    const rec = records[0]

    // Identity
    expect(rec.meta.id).toBe('rec-42')
    expect(rec.meta.namespace).toBe('decisions')
    expect(rec.meta.key).toBe('key-42')

    // Scope
    expect(rec.meta.scope?.tenant).toBe('tenant-1')
    expect(rec.meta.scope?.project).toBe('proj-1')
    expect(rec.meta.scope?.agent).toBe('agent-a')

    // Text
    expect(rec.value.text).toBe('Decision number 42: use PostgreSQL')

    // Temporal
    expect(rec.value._temporal?.systemCreatedAt).toBe(1700000042000)
    expect(rec.value._temporal?.systemExpiredAt).toBeUndefined()
    expect(rec.value._temporal?.validFrom).toBe(1700000042000)

    // Decay
    expect(rec.value._decay?.strength).toBeCloseTo(0.6, 5)
    expect(rec.value._decay?.halfLifeMs).toBe(86400000)
    expect(rec.value._decay?.accessCount).toBe(42)

    // Provenance
    expect(rec.value._agent).toBe('agent-a')

    // Category & importance
    expect(rec.value.category).toBe('decision')
    expect(rec.value.importance).toBe(0.8)

    // Overflow field in payload_json
    expect(rec.value['customField']).toBe('extra-42')
  })

  it('handles 100 records', () => {
    const builder = new FrameBuilder()
    for (let i = 0; i < 100; i++) {
      builder.add(makeValue(i), makeMeta(i))
    }
    const ipcBytes = builder.toIPC()
    const reader = FrameReader.fromIPC(ipcBytes)
    expect(reader.rowCount).toBe(100)

    const records = reader.toRecords()
    expect(records.length).toBe(100)
    expect(records[99].meta.id).toBe('rec-99')
  })

  it('preserves unicode content', () => {
    const builder = new FrameBuilder()
    builder.add(
      { text: '日本語テスト 🎉 émojis & accénts' },
      { id: 'u1', namespace: 'test', key: 'unicode' },
    )
    const reader = FrameReader.fromIPC(builder.toIPC())
    const rec = reader.toRecords()[0]
    expect(rec.value.text).toBe('日本語テスト 🎉 émojis & accénts')
  })

  it('handles empty batch', () => {
    const builder = new FrameBuilder()
    const table = builder.build()
    expect(table.numRows).toBe(0)
    const ipc = serializeToIPC(table)
    const restored = deserializeFromIPC(ipc)
    expect(restored.numRows).toBe(0)
  })
})

describe('IPC Serializer', () => {
  it('serializes and deserializes', () => {
    const builder = new FrameBuilder()
    builder.add(makeValue(0), makeMeta(0))
    const table = builder.build()
    const ipc = serializeToIPC(table)
    const restored = deserializeFromIPC(ipc)
    expect(restored.numRows).toBe(1)
  })

  it('base64 round-trip', () => {
    const builder = new FrameBuilder()
    builder.add(makeValue(0), makeMeta(0))
    const ipc = builder.toIPC()
    const b64 = ipcToBase64(ipc)
    const decoded = base64ToIPC(b64)
    expect(decoded.length).toBe(ipc.length)
    const reader = FrameReader.fromIPC(decoded)
    expect(reader.rowCount).toBe(1)
  })

  it('handles invalid bytes non-fatally', () => {
    const bad = new Uint8Array([1, 2, 3, 4])
    const table = deserializeFromIPC(bad)
    expect(table.numRows).toBe(0)
  })
})
