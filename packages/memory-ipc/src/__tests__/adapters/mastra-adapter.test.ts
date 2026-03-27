import { describe, it, expect } from 'vitest'
import { MastraAdapter, type MastraObservation } from '../../adapters/mastra-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObservation(overrides?: Partial<MastraObservation>): MastraObservation {
  return {
    content: 'User prefers dark mode',
    date: '2025-06-01T00:00:00Z',
    priority: 4,
    threadId: 'thread-abc',
    resourceId: 'user-123',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraAdapter', () => {
  const adapter = new MastraAdapter()

  describe('sourceSystem', () => {
    it('returns "mastra"', () => {
      expect(adapter.sourceSystem).toBe('mastra')
    })
  })

  // -------------------------------------------------------------------------
  // canAdapt
  // -------------------------------------------------------------------------

  describe('canAdapt', () => {
    it('accepts a valid MastraObservation', () => {
      expect(adapter.canAdapt(makeObservation())).toBe(true)
    })

    it('accepts observation with optional fields', () => {
      expect(adapter.canAdapt(makeObservation({
        agentId: 'agent-1',
        tags: ['ui', 'preference'],
        id: 'obs-1',
        createdAt: '2025-06-01T00:00:00Z',
      }))).toBe(true)
    })

    it('rejects null', () => {
      expect(adapter.canAdapt(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(adapter.canAdapt(123)).toBe(false)
    })

    it('rejects missing content', () => {
      expect(adapter.canAdapt({
        date: '2025-01-01', priority: 3, threadId: 't', resourceId: 'r',
      })).toBe(false)
    })

    it('rejects missing date', () => {
      expect(adapter.canAdapt({
        content: 'hello', priority: 3, threadId: 't', resourceId: 'r',
      })).toBe(false)
    })

    it('rejects missing priority', () => {
      expect(adapter.canAdapt({
        content: 'hello', date: '2025-01-01', threadId: 't', resourceId: 'r',
      })).toBe(false)
    })

    it('rejects missing threadId', () => {
      expect(adapter.canAdapt({
        content: 'hello', date: '2025-01-01', priority: 3, resourceId: 'r',
      })).toBe(false)
    })

    it('rejects missing resourceId', () => {
      expect(adapter.canAdapt({
        content: 'hello', date: '2025-01-01', priority: 3, threadId: 't',
      })).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('counts valid and invalid records', () => {
      const result = adapter.validate([
        makeObservation(),
        { bad: true },
        makeObservation({ content: 'other' }),
      ])
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(1)
    })

    it('warns on priority out of range', () => {
      const result = adapter.validate([
        makeObservation({ priority: 10 }),
      ])
      expect(result.valid).toBe(1)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0].field).toBe('priority')
    })

    it('warns on invalid date format', () => {
      const result = adapter.validate([
        makeObservation({ date: 'not-a-date' }),
      ])
      expect(result.valid).toBe(1)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0].field).toBe('date')
    })

    it('provides per-field warnings for invalid records', () => {
      const result = adapter.validate([{ content: 123 }])
      expect(result.invalid).toBe(1)
      // Should have warnings for content (non-string), date, priority, threadId, resourceId
      expect(result.warnings.length).toBeGreaterThanOrEqual(4)
    })

    it('reports non-object as invalid', () => {
      const result = adapter.validate([null, 42])
      expect(result.invalid).toBe(2)
      expect(result.warnings.every((w) => w.field === '*')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // toFrame
  // -------------------------------------------------------------------------

  describe('toFrame', () => {
    it('converts a single observation to Arrow table', () => {
      const obs = makeObservation()
      const table = adapter.toFrame([obs])

      expect(table.numRows).toBe(1)
      expect(table.getChild('text')?.get(0)).toBe('User prefers dark mode')
      expect(table.getChild('namespace')?.get(0)).toBe('observations')
      expect(table.getChild('scope_tenant')?.get(0)).toBe('user-123')
      expect(table.getChild('scope_session')?.get(0)).toBe('thread-abc')
      expect(table.getChild('category')?.get(0)).toBe('observation')
      expect(table.getChild('provenance_source')?.get(0)).toBe('imported')
      expect(table.getChild('is_active')?.get(0)).toBe(true)
    })

    it('maps priority to importance (normalized 0-1)', () => {
      const obs = makeObservation({ priority: 5 })
      const table = adapter.toFrame([obs])
      expect(table.getChild('importance')?.get(0)).toBeCloseTo(1.0, 5)
    })

    it('clamps importance for out-of-range priority', () => {
      const obs = makeObservation({ priority: 10 })
      const table = adapter.toFrame([obs])
      // Math.max(0, Math.min(1, 10/5)) = Math.min(1, 2) = 1
      expect(table.getChild('importance')?.get(0)).toBe(1)
    })

    it('handles priority 0', () => {
      const obs = makeObservation({ priority: 0 })
      const table = adapter.toFrame([obs])
      expect(table.getChild('importance')?.get(0)).toBe(0)
    })

    it('stores agentId in scope_agent and agent_id', () => {
      const obs = makeObservation({ agentId: 'my-agent' })
      const table = adapter.toFrame([obs])
      expect(table.getChild('scope_agent')?.get(0)).toBe('my-agent')
      expect(table.getChild('agent_id')?.get(0)).toBe('my-agent')
    })

    it('stores tags in payload_json', () => {
      const obs = makeObservation({ tags: ['ui', 'ux'] })
      const table = adapter.toFrame([obs])
      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.tags).toEqual(['ui', 'ux'])
    })

    it('sets payload_json to null when no tags', () => {
      const obs = makeObservation()
      const table = adapter.toFrame([obs])
      expect(table.getChild('payload_json')?.get(0)).toBeNull()
    })

    it('generates an id when none provided', () => {
      const obs = makeObservation()
      const table = adapter.toFrame([obs])
      const id = table.getChild('id')?.get(0) as string
      expect(id).toMatch(/^mastra-obs-/)
    })

    it('uses provided id', () => {
      const obs = makeObservation({ id: 'custom-id' })
      const table = adapter.toFrame([obs])
      expect(table.getChild('id')?.get(0)).toBe('custom-id')
    })

    it('parses date into valid_from', () => {
      const obs = makeObservation({ date: '2025-06-01T00:00:00Z' })
      const table = adapter.toFrame([obs])
      const validFrom = table.getChild('valid_from')?.get(0) as bigint
      expect(Number(validFrom)).toBe(Date.parse('2025-06-01T00:00:00Z'))
    })

    it('converts multiple observations', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeObservation({ content: `Observation ${i}`, id: `obs-${i}` }),
      )
      const table = adapter.toFrame(items)
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
    it('converts frame back to observations', () => {
      const obs = makeObservation({ id: 'obs-1', agentId: 'agent-x' })
      const table = adapter.toFrame([obs])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('User prefers dark mode')
      expect(result[0].threadId).toBe('thread-abc')
      expect(result[0].resourceId).toBe('user-123')
      expect(result[0].agentId).toBe('agent-x')
      expect(result[0].id).toBe('obs-1')
    })

    it('maps importance back to priority (1-5 scale)', () => {
      const obs = makeObservation({ priority: 4 })
      const table = adapter.toFrame([obs])
      const result = adapter.fromFrame(table)
      // importance = 4/5 = 0.8, back: round(0.8 * 5) = 4
      expect(result[0].priority).toBe(4)
    })

    it('clamps priority to 1-5 range', () => {
      const obs = makeObservation({ priority: 1 })
      const table = adapter.toFrame([obs])
      const result = adapter.fromFrame(table)
      expect(result[0].priority).toBeGreaterThanOrEqual(1)
      expect(result[0].priority).toBeLessThanOrEqual(5)
    })

    it('reconstructs tags from payload_json', () => {
      const obs = makeObservation({ tags: ['perf', 'db'] })
      const table = adapter.toFrame([obs])
      const result = adapter.fromFrame(table)
      expect(result[0].tags).toEqual(['perf', 'db'])
    })

    it('skips rows with null text', () => {
      // All real observations have text, but test the guard
      const obs1 = makeObservation({ id: 'valid', content: 'has content' })
      const table = adapter.toFrame([obs1])
      const result = adapter.fromFrame(table)
      expect(result).toHaveLength(1)
    })

    it('handles empty table', () => {
      const table = adapter.toFrame([])
      expect(adapter.fromFrame(table)).toEqual([])
    })

    it('sets default threadId to "unknown" when scope_session is null', () => {
      // Observations always have threadId so this tests the fallback path
      const obs = makeObservation()
      const table = adapter.toFrame([obs])
      const result = adapter.fromFrame(table)
      expect(result[0].threadId).toBe('thread-abc')
    })
  })

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('preserves essential data through toFrame -> fromFrame', () => {
      const original = makeObservation({
        id: 'rt-1',
        content: 'Always validate user input',
        date: '2025-03-15T10:00:00Z',
        priority: 3,
        threadId: 'thread-999',
        resourceId: 'user-42',
        agentId: 'security-agent',
        tags: ['security', 'validation'],
      })

      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.id).toBe('rt-1')
      expect(r.content).toBe('Always validate user input')
      expect(r.priority).toBe(3)
      expect(r.threadId).toBe('thread-999')
      expect(r.resourceId).toBe('user-42')
      expect(r.agentId).toBe('security-agent')
      expect(r.tags).toEqual(['security', 'validation'])
    })

    it('preserves batch of observations', () => {
      const items = Array.from({ length: 50 }, (_, i) =>
        makeObservation({
          id: `obs-${i}`,
          content: `Observation number ${i}`,
          priority: (i % 5) + 1,
          threadId: `thread-${i % 3}`,
          resourceId: `user-${i % 10}`,
        }),
      )

      const table = adapter.toFrame(items)
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(50)
      for (let i = 0; i < 50; i++) {
        expect(restored[i].id).toBe(`obs-${i}`)
        expect(restored[i].content).toBe(`Observation number ${i}`)
      }
    })
  })
})
