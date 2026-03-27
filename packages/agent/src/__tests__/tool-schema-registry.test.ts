import { describe, it, expect, beforeEach } from 'vitest'
import { ToolSchemaRegistry } from '../tools/tool-schema-registry.js'
import type { ToolSchemaEntry } from '../tools/tool-schema-registry.js'

function makeEntry(
  name: string,
  version: string,
  inputSchema: Record<string, unknown>,
  description = `Tool ${name}`,
): ToolSchemaEntry {
  return {
    name,
    version,
    description,
    inputSchema,
    registeredAt: new Date().toISOString(),
  }
}

describe('ToolSchemaRegistry', () => {
  let registry: ToolSchemaRegistry

  beforeEach(() => {
    registry = new ToolSchemaRegistry()
  })

  describe('register and get', () => {
    it('registers and retrieves a tool entry', () => {
      const entry = makeEntry('read_file', '1.0.0', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      })

      registry.register(entry)
      const retrieved = registry.get('read_file')

      expect(retrieved).toEqual(entry)
    })

    it('returns undefined for unregistered tools', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })

    it('retrieves a specific version', () => {
      const v1 = makeEntry('tool', '1.0.0', { type: 'object', properties: {} })
      const v2 = makeEntry('tool', '2.0.0', { type: 'object', properties: { extra: { type: 'string' } } })

      registry.register(v1)
      registry.register(v2)

      expect(registry.get('tool', '1.0.0')).toEqual(v1)
      expect(registry.get('tool', '2.0.0')).toEqual(v2)
    })
  })

  describe('get latest version', () => {
    it('returns the latest version when no version specified', () => {
      registry.register(makeEntry('tool', '1.0.0', {}))
      registry.register(makeEntry('tool', '2.0.0', {}))
      registry.register(makeEntry('tool', '1.5.0', {}))

      const latest = registry.get('tool')
      expect(latest?.version).toBe('2.0.0')
    })
  })

  describe('list', () => {
    it('lists all entries across all tools', () => {
      registry.register(makeEntry('a', '1.0.0', {}))
      registry.register(makeEntry('b', '1.0.0', {}))
      registry.register(makeEntry('a', '2.0.0', {}))

      const all = registry.list()
      expect(all).toHaveLength(3)

      const names = all.map((e) => `${e.name}@${e.version}`)
      expect(names).toContain('a@1.0.0')
      expect(names).toContain('a@2.0.0')
      expect(names).toContain('b@1.0.0')
    })

    it('returns empty array when no tools registered', () => {
      expect(registry.list()).toEqual([])
    })
  })

  describe('checkBackwardCompat', () => {
    it('reports compatible when an optional field is added', () => {
      registry.register(makeEntry('tool', '1.0.0', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      }))

      registry.register(makeEntry('tool', '2.0.0', {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string' },
        },
        required: ['path'],
      }))

      const result = registry.checkBackwardCompat('tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(true)
      expect(result.breaking).toEqual([])
    })

    it('reports breaking when a field is removed', () => {
      registry.register(makeEntry('tool', '1.0.0', {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string' },
        },
        required: ['path'],
      }))

      registry.register(makeEntry('tool', '2.0.0', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      }))

      const result = registry.checkBackwardCompat('tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.length).toBeGreaterThan(0)
      expect(result.breaking[0]).toContain('encoding')
      expect(result.breaking[0]).toContain('removed')
    })

    it('reports breaking when a field type changes', () => {
      registry.register(makeEntry('tool', '1.0.0', {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      }))

      registry.register(makeEntry('tool', '2.0.0', {
        type: 'object',
        properties: {
          count: { type: 'string' },
        },
      }))

      const result = registry.checkBackwardCompat('tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking.some((b) => b.includes('type changed'))).toBe(true)
    })

    it('reports not found for missing versions', () => {
      const result = registry.checkBackwardCompat('tool', '1.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.breaking[0]).toContain('not found')
    })
  })

  describe('generateDocs', () => {
    it('produces markdown documentation', () => {
      registry.register(makeEntry('read_file', '1.0.0', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }, 'Read a file from disk'))

      registry.register(makeEntry('write_file', '1.0.0', {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      }, 'Write content to a file'))

      const docs = registry.generateDocs()

      expect(docs).toContain('# Tool Schema Registry')
      expect(docs).toContain('## read_file')
      expect(docs).toContain('## write_file')
      expect(docs).toContain('Read a file from disk')
      expect(docs).toContain('Write content to a file')
      expect(docs).toContain('**Latest Version:** 1.0.0')
      expect(docs).toContain('```json')
    })

    it('shows all versions when multiple exist', () => {
      registry.register(makeEntry('tool', '1.0.0', {}))
      registry.register(makeEntry('tool', '2.0.0', {}))

      const docs = registry.generateDocs()
      expect(docs).toContain('1.0.0, 2.0.0')
    })
  })
})
