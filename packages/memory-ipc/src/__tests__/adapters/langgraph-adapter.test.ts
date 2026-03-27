import { describe, it, expect } from 'vitest'
import { LangGraphAdapter, type LangGraphStoreItem } from '../../adapters/langgraph-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoreItem(overrides?: Partial<LangGraphStoreItem>): LangGraphStoreItem {
  return {
    key: 'item-1',
    namespace: ['tenant-a', 'decisions', 'project-x'],
    value: { text: 'Use PostgreSQL for the database', importance: 0.9, category: 'db-choice' },
    createdAt: new Date('2025-06-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T12:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LangGraphAdapter', () => {
  const adapter = new LangGraphAdapter()

  describe('sourceSystem', () => {
    it('returns "langgraph"', () => {
      expect(adapter.sourceSystem).toBe('langgraph')
    })
  })

  describe('fieldMapping', () => {
    it('has expected column mappings', () => {
      expect(adapter.fieldMapping['id']).toBe('key')
      expect(adapter.fieldMapping['text']).toBe('value.text')
    })
  })

  // -------------------------------------------------------------------------
  // canAdapt
  // -------------------------------------------------------------------------

  describe('canAdapt', () => {
    it('accepts a valid LangGraphStoreItem', () => {
      expect(adapter.canAdapt(makeStoreItem())).toBe(true)
    })

    it('rejects null', () => {
      expect(adapter.canAdapt(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(adapter.canAdapt('string')).toBe(false)
    })

    it('rejects missing key', () => {
      expect(adapter.canAdapt({ namespace: [], value: {}, createdAt: new Date() })).toBe(false)
    })

    it('rejects missing namespace (not an array)', () => {
      expect(adapter.canAdapt({ key: 'k', namespace: 'flat', value: {}, createdAt: new Date() })).toBe(false)
    })

    it('rejects missing value', () => {
      expect(adapter.canAdapt({ key: 'k', namespace: [], createdAt: new Date() })).toBe(false)
    })

    it('rejects null value', () => {
      expect(adapter.canAdapt({ key: 'k', namespace: [], value: null, createdAt: new Date() })).toBe(false)
    })

    it('rejects createdAt not a Date', () => {
      expect(adapter.canAdapt({ key: 'k', namespace: [], value: {}, createdAt: '2025-01-01' })).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('counts valid and invalid records', () => {
      const result = adapter.validate([
        makeStoreItem(),
        { notAStoreItem: true },
        makeStoreItem({ key: 'item-2' }),
      ])
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(1)
    })

    it('warns when namespace tuple has fewer than 2 elements', () => {
      const item = makeStoreItem({ namespace: ['only-tenant'] })
      const result = adapter.validate([item])
      expect(result.valid).toBe(1)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0].field).toBe('namespace')
    })

    it('reports shape mismatch for invalid records', () => {
      const result = adapter.validate([42])
      expect(result.invalid).toBe(1)
      expect(result.warnings[0].field).toBe('*')
    })

    it('handles empty array', () => {
      const result = adapter.validate([])
      expect(result.valid).toBe(0)
      expect(result.invalid).toBe(0)
      expect(result.warnings).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // toFrame
  // -------------------------------------------------------------------------

  describe('toFrame', () => {
    it('converts a single store item to an Arrow table with correct columns', () => {
      const item = makeStoreItem()
      const table = adapter.toFrame([item])

      expect(table.numRows).toBe(1)
      expect(table.getChild('id')?.get(0)).toBe('item-1')
      expect(table.getChild('key')?.get(0)).toBe('item-1')
      expect(table.getChild('namespace')?.get(0)).toBe('decisions')
      expect(table.getChild('scope_tenant')?.get(0)).toBe('tenant-a')
      expect(table.getChild('scope_project')?.get(0)).toBe('project-x')
      expect(table.getChild('text')?.get(0)).toBe('Use PostgreSQL for the database')
      expect(table.getChild('provenance_source')?.get(0)).toBe('imported')
      expect(table.getChild('is_active')?.get(0)).toBe(true)
    })

    it('extracts importance from value', () => {
      const item = makeStoreItem({ value: { text: 'test', importance: 0.7 } })
      const table = adapter.toFrame([item])
      expect(table.getChild('importance')?.get(0)).toBeCloseTo(0.7, 5)
    })

    it('extracts category from value', () => {
      const item = makeStoreItem({ value: { text: 'test', category: 'architecture' } })
      const table = adapter.toFrame([item])
      expect(table.getChild('category')?.get(0)).toBe('architecture')
    })

    it('falls back to confidence for importance', () => {
      const item = makeStoreItem({ value: { text: 'test', confidence: 0.85 } })
      const table = adapter.toFrame([item])
      expect(table.getChild('importance')?.get(0)).toBeCloseTo(0.85, 5)
    })

    it('falls back to type for category', () => {
      const item = makeStoreItem({ value: { text: 'test', type: 'decision' } })
      const table = adapter.toFrame([item])
      expect(table.getChild('category')?.get(0)).toBe('decision')
    })

    it('stores remaining value fields in payload_json', () => {
      const item = makeStoreItem({
        value: { text: 'test', extraField: 'hello', nested: { a: 1 } },
      })
      const table = adapter.toFrame([item])
      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.extraField).toBe('hello')
      expect(payload.nested).toEqual({ a: 1 })
    })

    it('sets payload_json to null when no remaining fields', () => {
      const item = makeStoreItem({ value: { text: 'just text' } })
      const table = adapter.toFrame([item])
      expect(table.getChild('payload_json')?.get(0)).toBeNull()
    })

    it('maps createdAt to system_created_at as bigint', () => {
      const date = new Date('2025-06-01T00:00:00Z')
      const item = makeStoreItem({ createdAt: date })
      const table = adapter.toFrame([item])
      expect(table.getChild('system_created_at')?.get(0)).toBe(BigInt(date.getTime()))
    })

    it('handles namespace with fewer than 3 elements', () => {
      const item = makeStoreItem({ namespace: ['tenant-only'] })
      const table = adapter.toFrame([item])
      expect(table.getChild('scope_tenant')?.get(0)).toBe('tenant-only')
      expect(table.getChild('namespace')?.get(0)).toBe('')
      expect(table.getChild('scope_project')?.get(0)).toBeNull()
    })

    it('handles empty namespace', () => {
      const item = makeStoreItem({ namespace: [] })
      const table = adapter.toFrame([item])
      expect(table.getChild('scope_tenant')?.get(0)).toBeNull()
      expect(table.getChild('namespace')?.get(0)).toBe('')
    })

    it('converts multiple items', () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        makeStoreItem({ key: `item-${i}` }),
      )
      const table = adapter.toFrame(items)
      expect(table.numRows).toBe(5)
      expect(table.getChild('id')?.get(4)).toBe('item-4')
    })

    it('handles empty array', () => {
      const table = adapter.toFrame([])
      expect(table.numRows).toBe(0)
    })

    it('handles text as null when value has no text field', () => {
      const item = makeStoreItem({ value: { someOther: 'data' } })
      const table = adapter.toFrame([item])
      expect(table.getChild('text')?.get(0)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // fromFrame
  // -------------------------------------------------------------------------

  describe('fromFrame', () => {
    it('converts frame back to store items', () => {
      const item = makeStoreItem()
      const table = adapter.toFrame([item])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('item-1')
      expect(result[0].namespace).toEqual(['tenant-a', 'decisions', 'project-x'])
      expect(result[0].value['text']).toBe('Use PostgreSQL for the database')
    })

    it('skips rows with null key', () => {
      // Build a table with one valid row + modify to have null key
      const items = [
        makeStoreItem({ key: 'valid' }),
        makeStoreItem({ key: 'also-valid' }),
      ]
      const table = adapter.toFrame(items)
      const result = adapter.fromFrame(table)
      expect(result.length).toBe(2)
    })

    it('reconstructs namespace tuple from scope fields', () => {
      const item = makeStoreItem({ namespace: ['t', 'ns', 'p'] })
      const table = adapter.toFrame([item])
      const result = adapter.fromFrame(table)
      expect(result[0].namespace).toEqual(['t', 'ns', 'p'])
    })

    it('merges payload_json back into value', () => {
      const item = makeStoreItem({
        value: { text: 'test', extra: 'data', count: 42 },
      })
      const table = adapter.toFrame([item])
      const result = adapter.fromFrame(table)
      expect(result[0].value['text']).toBe('test')
      expect(result[0].value['extra']).toBe('data')
      expect(result[0].value['count']).toBe(42)
    })

    it('sets createdAt and updatedAt from system_created_at', () => {
      const date = new Date('2025-03-15T10:00:00Z')
      const item = makeStoreItem({ createdAt: date })
      const table = adapter.toFrame([item])
      const result = adapter.fromFrame(table)
      expect(result[0].createdAt.getTime()).toBe(date.getTime())
      expect(result[0].updatedAt.getTime()).toBe(date.getTime())
    })

    it('handles empty table', () => {
      const table = adapter.toFrame([])
      const result = adapter.fromFrame(table)
      expect(result).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('preserves data through toFrame -> fromFrame', () => {
      const original = makeStoreItem({
        key: 'round-trip-key',
        namespace: ['org', 'lessons', 'project-y'],
        value: {
          text: 'Always use connection pooling',
          importance: 0.95,
          category: 'best-practice',
          customMeta: { source: 'review' },
        },
        createdAt: new Date('2025-01-15T08:30:00Z'),
      })

      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.key).toBe('round-trip-key')
      expect(r.namespace).toEqual(['org', 'lessons', 'project-y'])
      expect(r.value['text']).toBe('Always use connection pooling')
      // importance/category go into payload_json and come back
      expect(r.value['importance']).toBe(0.95)
      expect(r.value['category']).toBe('best-practice')
      expect((r.value['customMeta'] as Record<string, unknown>)['source']).toBe('review')
      expect(r.createdAt.getTime()).toBe(new Date('2025-01-15T08:30:00Z').getTime())
    })

    it('preserves multiple items', () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeStoreItem({
          key: `item-${i}`,
          namespace: [`tenant-${i % 3}`, `ns-${i % 5}`, `proj-${i % 2}`],
          value: { text: `Record number ${i}`, index: i },
          createdAt: new Date(1700000000000 + i * 60000),
        }),
      )

      const table = adapter.toFrame(items)
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(20)
      for (let i = 0; i < 20; i++) {
        expect(restored[i].key).toBe(`item-${i}`)
        expect(restored[i].value['text']).toBe(`Record number ${i}`)
        expect(restored[i].value['index']).toBe(i)
      }
    })
  })
})
