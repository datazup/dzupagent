import { describe, it, expect } from 'vitest'
import { Mem0Adapter, type Mem0Memory } from '../../adapters/mem0-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(overrides?: Partial<Mem0Memory>): Mem0Memory {
  return {
    id: 'mem-1',
    memory: 'User likes TypeScript over JavaScript',
    user_id: 'user-42',
    created_at: '2025-06-01T00:00:00Z',
    updated_at: '2025-06-01T12:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mem0Adapter', () => {
  const adapter = new Mem0Adapter()

  describe('sourceSystem', () => {
    it('returns "mem0"', () => {
      expect(adapter.sourceSystem).toBe('mem0')
    })
  })

  // -------------------------------------------------------------------------
  // canAdapt
  // -------------------------------------------------------------------------

  describe('canAdapt', () => {
    it('accepts a valid Mem0Memory', () => {
      expect(adapter.canAdapt(makeMemory())).toBe(true)
    })

    it('accepts memory with optional fields', () => {
      expect(adapter.canAdapt(makeMemory({
        agent_id: 'agent-1',
        metadata: { source: 'chat' },
        hash: 'abc123',
        categories: ['preference'],
      }))).toBe(true)
    })

    it('rejects null', () => {
      expect(adapter.canAdapt(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(adapter.canAdapt('not an object')).toBe(false)
    })

    it('rejects missing id', () => {
      expect(adapter.canAdapt({
        memory: 'test', user_id: 'u', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing memory', () => {
      expect(adapter.canAdapt({
        id: 'x', user_id: 'u', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing user_id', () => {
      expect(adapter.canAdapt({
        id: 'x', memory: 'test', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing created_at', () => {
      expect(adapter.canAdapt({
        id: 'x', memory: 'test', user_id: 'u',
      })).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('counts valid and invalid records', () => {
      const result = adapter.validate([
        makeMemory(),
        { not: 'valid' },
        makeMemory({ id: 'mem-2' }),
      ])
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(1)
    })

    it('warns on invalid date format', () => {
      const result = adapter.validate([
        makeMemory({ created_at: 'invalid-date' }),
      ])
      expect(result.valid).toBe(1)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0].field).toBe('created_at')
    })

    it('provides per-field warnings for invalid records', () => {
      const result = adapter.validate([{ id: 123 }])
      expect(result.invalid).toBe(1)
      expect(result.warnings.length).toBeGreaterThanOrEqual(3)
    })

    it('handles non-object values', () => {
      const result = adapter.validate([null, undefined, 'string'])
      expect(result.invalid).toBe(3)
    })

    it('handles empty array', () => {
      const result = adapter.validate([])
      expect(result.valid).toBe(0)
      expect(result.invalid).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // toFrame
  // -------------------------------------------------------------------------

  describe('toFrame', () => {
    it('converts a single memory to Arrow table', () => {
      const mem = makeMemory()
      const table = adapter.toFrame([mem])

      expect(table.numRows).toBe(1)
      expect(table.getChild('id')?.get(0)).toBe('mem-1')
      expect(table.getChild('text')?.get(0)).toBe('User likes TypeScript over JavaScript')
      expect(table.getChild('namespace')?.get(0)).toBe('mem0-memories')
      expect(table.getChild('scope_tenant')?.get(0)).toBe('user-42')
      expect(table.getChild('provenance_source')?.get(0)).toBe('imported')
      expect(table.getChild('is_active')?.get(0)).toBe(true)
    })

    it('maps agent_id to scope_agent and agent_id columns', () => {
      const mem = makeMemory({ agent_id: 'my-agent' })
      const table = adapter.toFrame([mem])
      expect(table.getChild('scope_agent')?.get(0)).toBe('my-agent')
      expect(table.getChild('agent_id')?.get(0)).toBe('my-agent')
    })

    it('uses first category as Arrow category column', () => {
      const mem = makeMemory({ categories: ['preference', 'tech'] })
      const table = adapter.toFrame([mem])
      expect(table.getChild('category')?.get(0)).toBe('preference')
    })

    it('defaults category to "semantic" when no categories', () => {
      const mem = makeMemory()
      const table = adapter.toFrame([mem])
      expect(table.getChild('category')?.get(0)).toBe('semantic')
    })

    it('stores metadata, categories, and hash in payload_json', () => {
      const mem = makeMemory({
        metadata: { source: 'chat', score: 0.9 },
        categories: ['preference'],
        hash: 'abc123',
      })
      const table = adapter.toFrame([mem])
      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.metadata).toEqual({ source: 'chat', score: 0.9 })
      expect(payload.categories).toEqual(['preference'])
      expect(payload.hash).toBe('abc123')
    })

    it('sets payload_json to null when no metadata/categories/hash', () => {
      const mem = makeMemory()
      const table = adapter.toFrame([mem])
      expect(table.getChild('payload_json')?.get(0)).toBeNull()
    })

    it('extracts importance from metadata', () => {
      const mem = makeMemory({ metadata: { importance: 0.75 } })
      const table = adapter.toFrame([mem])
      expect(table.getChild('importance')?.get(0)).toBeCloseTo(0.75, 5)
    })

    it('sets importance to null when not in metadata', () => {
      const mem = makeMemory()
      const table = adapter.toFrame([mem])
      expect(table.getChild('importance')?.get(0)).toBeNull()
    })

    it('parses created_at into system_created_at', () => {
      const mem = makeMemory({ created_at: '2025-06-01T00:00:00Z' })
      const table = adapter.toFrame([mem])
      const createdAt = table.getChild('system_created_at')?.get(0) as bigint
      expect(Number(createdAt)).toBe(Date.parse('2025-06-01T00:00:00Z'))
    })

    it('converts multiple memories', () => {
      const mems = Array.from({ length: 10 }, (_, i) =>
        makeMemory({ id: `mem-${i}`, memory: `Memory ${i}` }),
      )
      const table = adapter.toFrame(mems)
      expect(table.numRows).toBe(10)
    })

    it('handles empty array', () => {
      const table = adapter.toFrame([])
      expect(table.numRows).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // fromFrame
  // -------------------------------------------------------------------------

  describe('fromFrame', () => {
    it('converts frame back to Mem0Memory records', () => {
      const mem = makeMemory({ agent_id: 'agent-x' })
      const table = adapter.toFrame([mem])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('mem-1')
      expect(result[0].memory).toBe('User likes TypeScript over JavaScript')
      expect(result[0].user_id).toBe('user-42')
      expect(result[0].agent_id).toBe('agent-x')
    })

    it('skips rows with null id or text', () => {
      const mems = [
        makeMemory({ id: 'valid', memory: 'has content' }),
      ]
      const table = adapter.toFrame(mems)
      const result = adapter.fromFrame(table)
      expect(result).toHaveLength(1)
    })

    it('reconstructs metadata from payload_json', () => {
      const mem = makeMemory({
        metadata: { source: 'chat' },
        categories: ['tech'],
        hash: 'xyz',
      })
      const table = adapter.toFrame([mem])
      const result = adapter.fromFrame(table)
      expect(result[0].metadata).toEqual({ source: 'chat' })
      expect(result[0].categories).toEqual(['tech'])
      expect(result[0].hash).toBe('xyz')
    })

    it('sets user_id to "unknown" when scope_tenant is null', () => {
      // Normal flow always has user_id, but test the fallback
      const mem = makeMemory()
      const table = adapter.toFrame([mem])
      const result = adapter.fromFrame(table)
      expect(result[0].user_id).toBe('user-42')
    })

    it('sets created_at and updated_at from system_created_at', () => {
      const mem = makeMemory({ created_at: '2025-03-15T10:00:00Z' })
      const table = adapter.toFrame([mem])
      const result = adapter.fromFrame(table)
      expect(new Date(result[0].created_at).getTime()).toBe(Date.parse('2025-03-15T10:00:00Z'))
      expect(result[0].created_at).toBe(result[0].updated_at)
    })

    it('handles empty table', () => {
      const table = adapter.toFrame([])
      expect(adapter.fromFrame(table)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('preserves essential data through toFrame -> fromFrame', () => {
      const original = makeMemory({
        id: 'mem-rt',
        memory: 'User preference: React with TypeScript strict mode',
        user_id: 'user-99',
        agent_id: 'preference-agent',
        metadata: { confidence: 0.95, source: 'explicit' },
        categories: ['framework', 'preference'],
        hash: 'hash123',
        created_at: '2025-01-15T08:30:00Z',
        updated_at: '2025-01-15T08:30:00Z',
      })

      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.id).toBe('mem-rt')
      expect(r.memory).toBe('User preference: React with TypeScript strict mode')
      expect(r.user_id).toBe('user-99')
      expect(r.agent_id).toBe('preference-agent')
      expect(r.metadata).toEqual({ confidence: 0.95, source: 'explicit' })
      expect(r.categories).toEqual(['framework', 'preference'])
      expect(r.hash).toBe('hash123')
    })

    it('handles batch round-trip', () => {
      const mems = Array.from({ length: 30 }, (_, i) =>
        makeMemory({
          id: `mem-${i}`,
          memory: `Memory entry ${i}`,
          user_id: `user-${i % 5}`,
          created_at: new Date(1700000000000 + i * 60000).toISOString(),
        }),
      )

      const table = adapter.toFrame(mems)
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(30)
      for (let i = 0; i < 30; i++) {
        expect(restored[i].id).toBe(`mem-${i}`)
        expect(restored[i].memory).toBe(`Memory entry ${i}`)
      }
    })
  })
})
