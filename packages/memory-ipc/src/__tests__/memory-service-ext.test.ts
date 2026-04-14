import { describe, it, expect, beforeEach, vi } from 'vitest'
import { extendMemoryServiceWithArrow } from '../memory-service-ext.js'
import type { MemoryServiceLike } from '../memory-service-ext.js'
import { FrameBuilder } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'

// ---------------------------------------------------------------------------
// Mock MemoryServiceLike — simple in-memory Map-based store
// ---------------------------------------------------------------------------

class MockMemoryService implements MemoryServiceLike {
  /** Storage: Map<compositeKey, record> where compositeKey = ns|scopeHash|key */
  private store = new Map<string, Record<string, unknown>>()
  private deleted = new Set<string>()

  private compositeKey(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): string {
    const scopeStr = Object.entries(scope)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    return `${namespace}|${scopeStr}|${key}`
  }

  private scopePrefix(
    namespace: string,
    scope: Record<string, string>,
  ): string {
    const scopeStr = Object.entries(scope)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    return `${namespace}|${scopeStr}|`
  }

  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    if (key) {
      const ck = this.compositeKey(namespace, scope, key)
      const val = this.store.get(ck)
      return val ? [{ ...val, key, id: ck }] : []
    }
    // Return all records matching namespace + scope
    const prefix = this.scopePrefix(namespace, scope)
    const results: Record<string, unknown>[] = []
    for (const [ck, val] of this.store) {
      if (ck.startsWith(prefix)) {
        const recKey = ck.slice(prefix.length)
        results.push({ ...val, key: recKey, id: ck })
      }
    }
    return results
  }

  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const all = await this.get(namespace, scope)
    const filtered = all.filter((r) => {
      const text = typeof r['text'] === 'string' ? r['text'] : ''
      return text.toLowerCase().includes(query.toLowerCase())
    })
    return limit ? filtered.slice(0, limit) : filtered
  }

  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const ck = this.compositeKey(namespace, scope, key)
    this.store.set(ck, { ...value })
  }

  async delete(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<void> {
    const ck = this.compositeKey(namespace, scope, key)
    this.deleted.add(ck)
    this.store.delete(ck)
  }

  /** Helper to get store size for test assertions. */
  get size(): number {
    return this.store.size
  }

  /** Helper to check whether a key was deleted during replace. */
  wasDeleted(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): boolean {
    return this.deleted.has(this.compositeKey(namespace, scope, key))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extendMemoryServiceWithArrow', () => {
  let mock: MockMemoryService
  let ext: ReturnType<typeof extendMemoryServiceWithArrow>
  const ns = 'test-ns'
  const scope = { tenant: 't1', project: 'p1' }

  beforeEach(() => {
    mock = new MockMemoryService()
    ext = extendMemoryServiceWithArrow(mock)
  })

  describe('exportFrame', () => {
    it('should export 50 records as an Arrow Table', async () => {
      // Populate 50 records
      for (let i = 0; i < 50; i++) {
        await mock.put(ns, scope, `key-${i}`, {
          text: `Record number ${i}`,
          category: 'test',
          importance: i / 100,
        })
      }

      const table = await ext.exportFrame(ns, scope)

      expect(table.numRows).toBe(50)

      // Verify some data survived the round trip
      const textCol = table.getChild('text')
      expect(textCol).not.toBeNull()

      // Check a sample of texts
      const reader = new FrameReader(table)
      const records = reader.toRecords()
      expect(records.length).toBe(50)

      // All texts should contain "Record number"
      for (const rec of records) {
        const text = rec.value.text
        expect(typeof text).toBe('string')
        expect((text as string).startsWith('Record number')).toBe(true)
      }
    })

    it('should respect limit option', async () => {
      for (let i = 0; i < 20; i++) {
        await mock.put(ns, scope, `key-${i}`, { text: `item ${i}` })
      }

      const table = await ext.exportFrame(ns, scope, { limit: 5 })
      expect(table.numRows).toBe(5)
    })

    it('should use search when query is provided', async () => {
      await mock.put(ns, scope, 'alpha', { text: 'Alpha release notes' })
      await mock.put(ns, scope, 'beta', { text: 'Beta testing guide' })
      await mock.put(ns, scope, 'gamma', { text: 'Gamma configuration' })

      const table = await ext.exportFrame(ns, scope, { query: 'beta' })
      expect(table.numRows).toBe(1)

      const reader = new FrameReader(table)
      const records = reader.toRecords()
      expect(records[0]?.value.text).toBe('Beta testing guide')
    })

    it('should return empty table when no records exist', async () => {
      const table = await ext.exportFrame(ns, scope)
      expect(table.numRows).toBe(0)
    })
  })

  describe('importFrame', () => {
    it('should import records with upsert strategy (default)', async () => {
      const builder = new FrameBuilder()
      for (let i = 0; i < 5; i++) {
        builder.add(
          { text: `imported-${i}`, category: 'import-test' },
          { id: `id-${i}`, namespace: ns, key: `imp-${i}` },
        )
      }
      const table = builder.build()

      const result = await ext.importFrame(ns, scope, table)

      expect(result.imported).toBe(5)
      expect(result.skipped).toBe(0)
      expect(result.conflicts).toBe(0)
      expect(mock.size).toBe(5)
    })

    it('should skip existing records with append strategy', async () => {
      // Pre-populate some keys
      await mock.put(ns, scope, 'imp-0', { text: 'existing-0' })
      await mock.put(ns, scope, 'imp-2', { text: 'existing-2' })

      const builder = new FrameBuilder()
      for (let i = 0; i < 5; i++) {
        builder.add(
          { text: `new-${i}` },
          { id: `id-${i}`, namespace: ns, key: `imp-${i}` },
        )
      }
      const table = builder.build()

      const result = await ext.importFrame(ns, scope, table, 'append')

      expect(result.imported).toBe(3)
      expect(result.skipped).toBe(2)
      expect(result.conflicts).toBe(0)

      // Original values should be preserved for skipped keys
      const existing = await mock.get(ns, scope, 'imp-0')
      expect(existing[0]?.['text']).toBe('existing-0')
    })

    it('should overwrite existing records with upsert strategy', async () => {
      await mock.put(ns, scope, 'imp-0', { text: 'old-value' })

      const builder = new FrameBuilder()
      builder.add(
        { text: 'new-value' },
        { id: 'id-0', namespace: ns, key: 'imp-0' },
      )
      const table = builder.build()

      const result = await ext.importFrame(ns, scope, table, 'upsert')

      expect(result.imported).toBe(1)

      const updated = await mock.get(ns, scope, 'imp-0')
      expect(updated[0]?.['text']).toBe('new-value')
    })

    it('should replace existing records when delete is supported', async () => {
      await mock.put(ns, scope, 'stale-0', { text: 'old-0' })
      await mock.put(ns, scope, 'stale-1', { text: 'old-1' })

      const builder = new FrameBuilder()
      builder.add(
        { text: 'replacement-value' },
        { id: 'replacement-id', namespace: ns, key: 'fresh-0' },
      )
      const table = builder.build()

      const result = await ext.importFrame(ns, scope, table, 'replace')

      expect(result.imported).toBe(1)
      expect(result.skipped).toBe(0)
      expect(result.conflicts).toBe(0)
      expect(mock.size).toBe(1)
      expect(mock.wasDeleted(ns, scope, 'stale-0')).toBe(true)
      expect(mock.wasDeleted(ns, scope, 'stale-1')).toBe(true)

      const remaining = await mock.get(ns, scope)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]?.['key']).toBe('fresh-0')
      expect(remaining[0]?.['text']).toBe('replacement-value')
    })

    it('should reject replace when delete capability is absent', async () => {
      const put = vi.fn(async () => undefined)
      const service: MemoryServiceLike = {
        get: async () => [{ key: 'existing-0', text: 'old-value' }],
        search: async () => [],
        put,
      }

      const extWithoutDelete = extendMemoryServiceWithArrow(service)

      const builder = new FrameBuilder()
      builder.add(
        { text: 'replacement-value' },
        { id: 'replacement-id', namespace: ns, key: 'fresh-0' },
      )
      const table = builder.build()

      await expect(
        extWithoutDelete.importFrame(ns, scope, table, 'replace'),
      ).rejects.toThrow(/delete\(\) support/)

      expect(put).not.toHaveBeenCalled()
    })
  })

  describe('exportIPC / importIPC round-trip', () => {
    it('should round-trip records through IPC bytes', async () => {
      // Populate
      for (let i = 0; i < 10; i++) {
        await mock.put(ns, scope, `rt-${i}`, {
          text: `round-trip-${i}`,
          importance: (i + 1) / 10,
        })
      }

      // Export to IPC bytes
      const ipcBytes = await ext.exportIPC(ns, scope)
      expect(ipcBytes.byteLength).toBeGreaterThan(0)

      // Create a fresh service and import
      const mock2 = new MockMemoryService()
      const ext2 = extendMemoryServiceWithArrow(mock2)
      const newScope = { tenant: 't2', project: 'p2' }

      const result = await ext2.importIPC('imported-ns', newScope, ipcBytes)

      expect(result.imported).toBe(10)
      expect(result.skipped).toBe(0)
      expect(result.conflicts).toBe(0)
      expect(mock2.size).toBe(10)

      // Verify data integrity
      const reimported = await mock2.get('imported-ns', newScope)
      expect(reimported.length).toBe(10)

      const texts = reimported
        .map((r) => r['text'])
        .filter((t) => typeof t === 'string')
      expect(texts.length).toBe(10)
      for (const t of texts) {
        expect((t as string).startsWith('round-trip-')).toBe(true)
      }
    })

    it('should handle empty IPC bytes gracefully', async () => {
      const mock2 = new MockMemoryService()
      const ext2 = extendMemoryServiceWithArrow(mock2)

      // Export from empty service produces valid empty IPC
      const ipcBytes = await ext2.exportIPC(ns, scope)
      expect(ipcBytes.byteLength).toBeGreaterThan(0)

      // Import empty IPC into another service
      const result = await ext2.importIPC(ns, scope, ipcBytes)
      expect(result.imported).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.conflicts).toBe(0)
    })
  })

  describe('edge cases', () => {
    it('should handle records without text field', async () => {
      await mock.put(ns, scope, 'no-text', {
        category: 'meta',
        importance: 0.5,
      })

      const table = await ext.exportFrame(ns, scope)
      expect(table.numRows).toBe(1)
    })

    it('should preserve extra fields through payload_json', async () => {
      await mock.put(ns, scope, 'extras', {
        text: 'with extras',
        customField: 'custom-value',
        nestedObj: { a: 1 },
      })

      const ipcBytes = await ext.exportIPC(ns, scope)
      const mock2 = new MockMemoryService()
      const ext2 = extendMemoryServiceWithArrow(mock2)
      await ext2.importIPC(ns, scope, ipcBytes)

      const records = await mock2.get(ns, scope, 'extras')
      expect(records.length).toBe(1)
      expect(records[0]?.['text']).toBe('with extras')
      // Extra fields should survive via payload_json
      expect(records[0]?.['customField']).toBe('custom-value')
    })
  })
})
