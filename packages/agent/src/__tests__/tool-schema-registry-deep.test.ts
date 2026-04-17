import { describe, it, expect, beforeEach } from 'vitest'
import { ToolSchemaRegistry } from '../tools/tool-schema-registry.js'
import type { ToolSchemaEntry } from '../tools/tool-schema-registry.js'

function makeEntry(overrides: Partial<ToolSchemaEntry> = {}): ToolSchemaEntry {
  return {
    name: 'my-tool',
    version: '1.0.0',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    registeredAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('ToolSchemaRegistry - extended', () => {
  let registry: ToolSchemaRegistry

  beforeEach(() => {
    registry = new ToolSchemaRegistry()
  })

  describe('register', () => {
    it('registers a new tool', () => {
      registry.register(makeEntry())
      expect(registry.get('my-tool')).toBeDefined()
    })

    it('replaces existing version', () => {
      registry.register(makeEntry({ description: 'v1' }))
      registry.register(makeEntry({ description: 'v1-updated' }))
      expect(registry.get('my-tool')!.description).toBe('v1-updated')
    })

    it('adds new version to existing tool', () => {
      registry.register(makeEntry({ version: '1.0.0' }))
      registry.register(makeEntry({ version: '2.0.0' }))
      expect(registry.list().filter(e => e.name === 'my-tool')).toHaveLength(2)
    })

    it('sorts versions correctly after insertion', () => {
      registry.register(makeEntry({ version: '2.0.0' }))
      registry.register(makeEntry({ version: '1.0.0' }))
      registry.register(makeEntry({ version: '1.5.0' }))

      const entries = registry.list().filter(e => e.name === 'my-tool')
      expect(entries.map(e => e.version)).toEqual(['1.0.0', '1.5.0', '2.0.0'])
    })
  })

  describe('get', () => {
    it('returns undefined for unknown tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })

    it('returns latest version by default', () => {
      registry.register(makeEntry({ version: '1.0.0', description: 'old' }))
      registry.register(makeEntry({ version: '2.0.0', description: 'new' }))
      expect(registry.get('my-tool')!.version).toBe('2.0.0')
    })

    it('returns specific version when requested', () => {
      registry.register(makeEntry({ version: '1.0.0', description: 'old' }))
      registry.register(makeEntry({ version: '2.0.0', description: 'new' }))
      expect(registry.get('my-tool', '1.0.0')!.description).toBe('old')
    })

    it('returns undefined for unknown version', () => {
      registry.register(makeEntry({ version: '1.0.0' }))
      expect(registry.get('my-tool', '3.0.0')).toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns empty for no registrations', () => {
      expect(registry.list()).toEqual([])
    })

    it('returns all entries across tools', () => {
      registry.register(makeEntry({ name: 'tool-a', version: '1.0.0' }))
      registry.register(makeEntry({ name: 'tool-a', version: '2.0.0' }))
      registry.register(makeEntry({ name: 'tool-b', version: '1.0.0' }))
      expect(registry.list()).toHaveLength(3)
    })
  })

  describe('checkBackwardCompat', () => {
    it('reports compatible when no breaking changes', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            limit: { type: 'number' },
          },
        },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(true)
      expect(result.breaking).toHaveLength(0)
    })

    it('reports breaking when field removed', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
        },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.some(b => b.includes('limit') && b.includes('removed'))).toBe(true)
    })

    it('reports breaking when field type changed', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: { type: 'object', properties: { q: { type: 'number' } } },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.some(b => b.includes('type changed'))).toBe(true)
    })

    it('reports breaking when new required field added', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' }, newField: { type: 'string' } },
          required: ['newField'],
        },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.some(b => b.includes('new required field'))).toBe(true)
    })

    it('reports error when old version not found', () => {
      registry.register(makeEntry({ version: '2.0.0' }))
      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking[0]).toContain("'1.0.0'")
    })

    it('reports error when new version not found', () => {
      registry.register(makeEntry({ version: '1.0.0' }))
      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '3.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking[0]).toContain("'3.0.0'")
    })

    it('checks array items schema', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: { type: 'array', items: { type: 'string' } },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: { type: 'array', items: { type: 'number' } },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.some(b => b.includes('type changed'))).toBe(true)
    })

    it('top-level type change is breaking', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: { type: 'object', properties: {} },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: { type: 'string' },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
    })

    it('required field that already existed is not breaking', () => {
      registry.register(makeEntry({
        version: '1.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      }))
      registry.register(makeEntry({
        version: '2.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      }))

      const result = registry.checkBackwardCompat('my-tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(true)
    })
  })

  describe('generateDocs', () => {
    it('generates markdown for registered tools', () => {
      registry.register(makeEntry({
        name: 'search',
        version: '1.0.0',
        description: 'Search for things',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }))

      const docs = registry.generateDocs()
      expect(docs).toContain('# Tool Schema Registry')
      expect(docs).toContain('## search')
      expect(docs).toContain('Search for things')
      expect(docs).toContain('1.0.0')
      expect(docs).toContain('### Input Schema')
    })

    it('shows all versions when multiple exist', () => {
      registry.register(makeEntry({ name: 'tool', version: '1.0.0' }))
      registry.register(makeEntry({ name: 'tool', version: '2.0.0' }))

      const docs = registry.generateDocs()
      expect(docs).toContain('**All Versions:** 1.0.0, 2.0.0')
    })

    it('includes output schema when present', () => {
      registry.register(makeEntry({
        name: 'tool',
        outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      }))

      const docs = registry.generateDocs()
      expect(docs).toContain('### Output Schema')
    })

    it('does not include output schema section when absent', () => {
      registry.register(makeEntry({ name: 'tool' }))

      const docs = registry.generateDocs()
      expect(docs).not.toContain('### Output Schema')
    })

    it('returns just header for empty registry', () => {
      const docs = registry.generateDocs()
      expect(docs).toContain('# Tool Schema Registry')
    })

    it('sorts tools alphabetically', () => {
      registry.register(makeEntry({ name: 'zebra' }))
      registry.register(makeEntry({ name: 'apple' }))

      const docs = registry.generateDocs()
      const appleIdx = docs.indexOf('## apple')
      const zebraIdx = docs.indexOf('## zebra')
      expect(appleIdx).toBeLessThan(zebraIdx)
    })
  })
})
