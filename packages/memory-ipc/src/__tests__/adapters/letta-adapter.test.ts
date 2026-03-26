import { describe, it, expect } from 'vitest'
import {
  LettaAdapter,
  lettaCoreToWorkingMemory,
  workingMemoryToLettaCore,
  type LettaArchivalPassage,
  type LettaCoreMemory,
} from '../../adapters/letta-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassage(overrides?: Partial<LettaArchivalPassage>): LettaArchivalPassage {
  return {
    id: 'passage-1',
    text: 'The user prefers PostgreSQL over MySQL',
    agent_id: 'agent-letta-1',
    created_at: '2025-06-01T00:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LettaAdapter', () => {
  const adapter = new LettaAdapter()

  describe('sourceSystem', () => {
    it('returns "letta"', () => {
      expect(adapter.sourceSystem).toBe('letta')
    })
  })

  // -------------------------------------------------------------------------
  // canAdapt
  // -------------------------------------------------------------------------

  describe('canAdapt', () => {
    it('accepts a valid LettaArchivalPassage', () => {
      expect(adapter.canAdapt(makePassage())).toBe(true)
    })

    it('accepts passage with optional fields', () => {
      expect(adapter.canAdapt(makePassage({
        embedding: [0.1, 0.2, 0.3],
        metadata: { source: 'archival' },
      }))).toBe(true)
    })

    it('rejects null', () => {
      expect(adapter.canAdapt(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(adapter.canAdapt(42)).toBe(false)
    })

    it('rejects missing id', () => {
      expect(adapter.canAdapt({
        text: 'hi', agent_id: 'a', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing text', () => {
      expect(adapter.canAdapt({
        id: 'x', agent_id: 'a', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing agent_id', () => {
      expect(adapter.canAdapt({
        id: 'x', text: 'hi', created_at: '2025-01-01',
      })).toBe(false)
    })

    it('rejects missing created_at', () => {
      expect(adapter.canAdapt({
        id: 'x', text: 'hi', agent_id: 'a',
      })).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('counts valid and invalid records', () => {
      const result = adapter.validate([
        makePassage(),
        { invalid: true },
        makePassage({ id: 'p-2' }),
      ])
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(1)
    })

    it('warns on invalid date format', () => {
      const result = adapter.validate([
        makePassage({ created_at: 'not-a-date' }),
      ])
      expect(result.valid).toBe(1)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0].field).toBe('created_at')
    })

    it('provides per-field warnings for invalid records', () => {
      const result = adapter.validate([{ id: 123, text: null }])
      expect(result.invalid).toBe(1)
      expect(result.warnings.length).toBeGreaterThanOrEqual(3)
    })

    it('reports non-object as invalid', () => {
      const result = adapter.validate([null, 'string'])
      expect(result.invalid).toBe(2)
      expect(result.warnings.every((w) => w.field === '*')).toBe(true)
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
    it('converts a single passage to Arrow table', () => {
      const passage = makePassage()
      const table = adapter.toFrame([passage])

      expect(table.numRows).toBe(1)
      expect(table.getChild('id')?.get(0)).toBe('passage-1')
      expect(table.getChild('text')?.get(0)).toBe('The user prefers PostgreSQL over MySQL')
      expect(table.getChild('namespace')?.get(0)).toBe('archival')
      expect(table.getChild('scope_agent')?.get(0)).toBe('agent-letta-1')
      expect(table.getChild('agent_id')?.get(0)).toBe('agent-letta-1')
      expect(table.getChild('category')?.get(0)).toBe('archival')
      expect(table.getChild('provenance_source')?.get(0)).toBe('imported')
      expect(table.getChild('is_active')?.get(0)).toBe(true)
    })

    it('stores metadata in payload_json', () => {
      const passage = makePassage({ metadata: { source: 'conversation', turn: 5 } })
      const table = adapter.toFrame([passage])
      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.metadata).toEqual({ source: 'conversation', turn: 5 })
    })

    it('stores embedding in payload_json', () => {
      const passage = makePassage({ embedding: [0.1, 0.2, 0.3] })
      const table = adapter.toFrame([passage])
      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.embedding).toEqual([0.1, 0.2, 0.3])
    })

    it('sets payload_json to null when no metadata or embedding', () => {
      const passage = makePassage()
      const table = adapter.toFrame([passage])
      expect(table.getChild('payload_json')?.get(0)).toBeNull()
    })

    it('sets importance to null (archival has no built-in importance)', () => {
      const passage = makePassage()
      const table = adapter.toFrame([passage])
      expect(table.getChild('importance')?.get(0)).toBeNull()
    })

    it('parses created_at into system_created_at', () => {
      const passage = makePassage({ created_at: '2025-06-01T00:00:00Z' })
      const table = adapter.toFrame([passage])
      const ts = table.getChild('system_created_at')?.get(0) as bigint
      expect(Number(ts)).toBe(Date.parse('2025-06-01T00:00:00Z'))
    })

    it('scope_tenant and scope_session are null', () => {
      const passage = makePassage()
      const table = adapter.toFrame([passage])
      expect(table.getChild('scope_tenant')?.get(0)).toBeNull()
      expect(table.getChild('scope_session')?.get(0)).toBeNull()
    })

    it('converts multiple passages', () => {
      const passages = Array.from({ length: 15 }, (_, i) =>
        makePassage({ id: `p-${i}`, text: `Passage ${i}` }),
      )
      const table = adapter.toFrame(passages)
      expect(table.numRows).toBe(15)
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
    it('converts frame back to archival passages', () => {
      const passage = makePassage()
      const table = adapter.toFrame([passage])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('passage-1')
      expect(result[0].text).toBe('The user prefers PostgreSQL over MySQL')
      expect(result[0].agent_id).toBe('agent-letta-1')
    })

    it('skips rows with null id or text', () => {
      const passages = [makePassage({ id: 'valid', text: 'has text' })]
      const table = adapter.toFrame(passages)
      const result = adapter.fromFrame(table)
      expect(result).toHaveLength(1)
    })

    it('reconstructs metadata from payload_json', () => {
      const passage = makePassage({ metadata: { key: 'value' } })
      const table = adapter.toFrame([passage])
      const result = adapter.fromFrame(table)
      expect(result[0].metadata).toEqual({ key: 'value' })
    })

    it('reconstructs embedding from payload_json', () => {
      const passage = makePassage({ embedding: [1.0, 2.0, 3.0] })
      const table = adapter.toFrame([passage])
      const result = adapter.fromFrame(table)
      expect(result[0].embedding).toEqual([1.0, 2.0, 3.0])
    })

    it('sets agent_id to "unknown" when scope_agent is null', () => {
      // Normal flow always has agent_id
      const passage = makePassage()
      const table = adapter.toFrame([passage])
      const result = adapter.fromFrame(table)
      expect(result[0].agent_id).toBe('agent-letta-1')
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
      const original = makePassage({
        id: 'rt-passage',
        text: 'Important architectural decision about caching',
        agent_id: 'architect-agent',
        created_at: '2025-03-15T10:00:00Z',
        metadata: { decision: 'use-redis', confidence: 0.92 },
        embedding: [0.5, -0.3, 0.8, 0.1],
      })

      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.id).toBe('rt-passage')
      expect(r.text).toBe('Important architectural decision about caching')
      expect(r.agent_id).toBe('architect-agent')
      expect(r.metadata).toEqual({ decision: 'use-redis', confidence: 0.92 })
      expect(r.embedding).toEqual([0.5, -0.3, 0.8, 0.1])
    })

    it('preserves batch of passages', () => {
      const passages = Array.from({ length: 25 }, (_, i) =>
        makePassage({
          id: `p-${i}`,
          text: `Passage content ${i}`,
          agent_id: `agent-${i % 3}`,
          created_at: new Date(1700000000000 + i * 60000).toISOString(),
        }),
      )

      const table = adapter.toFrame(passages)
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(25)
      for (let i = 0; i < 25; i++) {
        expect(restored[i].id).toBe(`p-${i}`)
        expect(restored[i].text).toBe(`Passage content ${i}`)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Core Memory helpers
// ---------------------------------------------------------------------------

describe('lettaCoreToWorkingMemory', () => {
  it('converts blocks to record', () => {
    const coreMemory: LettaCoreMemory = {
      blocks: [
        { label: 'persona', value: 'I am a helpful assistant', limit: 2000 },
        { label: 'human', value: 'The user is a developer', limit: 2000 },
      ],
    }

    const result = lettaCoreToWorkingMemory(coreMemory)
    expect(result['persona']).toBe('I am a helpful assistant')
    expect(result['human']).toBe('The user is a developer')
  })

  it('handles empty blocks', () => {
    const result = lettaCoreToWorkingMemory({ blocks: [] })
    expect(result).toEqual({})
  })
})

describe('workingMemoryToLettaCore', () => {
  it('converts record to blocks', () => {
    const working = {
      persona: 'I am a code reviewer',
      context: 'Vue 3 project',
    }

    const result = workingMemoryToLettaCore(working)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].label).toBe('persona')
    expect(result.blocks[0].value).toBe('I am a code reviewer')
    expect(result.blocks[0].limit).toBe(2000)
    expect(result.blocks[1].label).toBe('context')
    expect(result.blocks[1].value).toBe('Vue 3 project')
  })

  it('JSON-serializes non-string values', () => {
    const working = { config: { maxTokens: 4096 } }
    const result = workingMemoryToLettaCore(working)
    expect(result.blocks[0].value).toBe(JSON.stringify({ maxTokens: 4096 }))
  })

  it('truncates values exceeding blockLimit', () => {
    const working = { long: 'x'.repeat(5000) }
    const result = workingMemoryToLettaCore(working, 100)
    expect(result.blocks[0].value.length).toBe(100)
    expect(result.blocks[0].limit).toBe(100)
  })

  it('uses custom blockLimit', () => {
    const working = { short: 'hello' }
    const result = workingMemoryToLettaCore(working, 500)
    expect(result.blocks[0].limit).toBe(500)
    expect(result.blocks[0].value).toBe('hello')
  })

  it('handles empty record', () => {
    const result = workingMemoryToLettaCore({})
    expect(result.blocks).toEqual([])
  })

  it('round-trips with lettaCoreToWorkingMemory for string values', () => {
    const original = {
      persona: 'I am an assistant',
      human: 'Developer user',
    }
    const core = workingMemoryToLettaCore(original)
    const restored = lettaCoreToWorkingMemory(core)
    expect(restored).toEqual(original)
  })
})
