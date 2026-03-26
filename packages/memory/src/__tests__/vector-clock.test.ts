import { describe, it, expect } from 'vitest'
import { VectorClock } from '../vector-clock.js'

describe('VectorClock', () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('creates an empty clock by default', () => {
      const clock = new VectorClock()
      expect(clock.get('any-agent')).toBe(0)
      expect(clock.size).toBe(0)
    })

    it('creates from a plain object', () => {
      const clock = new VectorClock({ 'agent-a': 3, 'agent-b': 5 })
      expect(clock.get('agent-a')).toBe(3)
      expect(clock.get('agent-b')).toBe(5)
      expect(clock.size).toBe(2)
    })

    it('creates from a Map', () => {
      const map = new Map([['agent-x', 7]])
      const clock = new VectorClock(map)
      expect(clock.get('agent-x')).toBe(7)
    })
  })

  // -------------------------------------------------------------------------
  // Increment
  // -------------------------------------------------------------------------

  describe('increment', () => {
    it('returns a new instance (immutable)', () => {
      const clock = new VectorClock()
      const incremented = clock.increment('agent-a')
      expect(incremented).not.toBe(clock)
      expect(clock.get('agent-a')).toBe(0) // original unchanged
      expect(incremented.get('agent-a')).toBe(1)
    })

    it('increments existing counter', () => {
      const clock = new VectorClock({ 'agent-a': 5 })
      const next = clock.increment('agent-a')
      expect(next.get('agent-a')).toBe(6)
    })

    it('adds a new agent counter starting at 1', () => {
      const clock = new VectorClock({ 'agent-a': 3 })
      const next = clock.increment('agent-b')
      expect(next.get('agent-a')).toBe(3)
      expect(next.get('agent-b')).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    it('takes element-wise max', () => {
      const a = new VectorClock({ x: 3, y: 1 })
      const b = new VectorClock({ x: 1, y: 5, z: 2 })
      const merged = a.merge(b)

      expect(merged.get('x')).toBe(3)
      expect(merged.get('y')).toBe(5)
      expect(merged.get('z')).toBe(2)
    })

    it('returns a new instance', () => {
      const a = new VectorClock({ x: 1 })
      const b = new VectorClock({ y: 1 })
      const merged = a.merge(b)
      expect(merged).not.toBe(a)
      expect(merged).not.toBe(b)
    })

    it('merging with empty clock returns equivalent clock', () => {
      const a = new VectorClock({ x: 3, y: 7 })
      const merged = a.merge(new VectorClock())
      expect(merged.toJSON()).toEqual({ x: 3, y: 7 })
    })

    it('merging two empty clocks returns empty clock', () => {
      const merged = new VectorClock().merge(new VectorClock())
      expect(merged.size).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Compare
  // -------------------------------------------------------------------------

  describe('compare', () => {
    it('equal: identical counters', () => {
      const a = new VectorClock({ x: 2, y: 3 })
      const b = new VectorClock({ x: 2, y: 3 })
      expect(a.compare(b)).toBe('equal')
    })

    it('equal: both empty', () => {
      expect(new VectorClock().compare(new VectorClock())).toBe('equal')
    })

    it('before: all counters <= other, at least one <', () => {
      const a = new VectorClock({ x: 1, y: 2 })
      const b = new VectorClock({ x: 2, y: 3 })
      expect(a.compare(b)).toBe('before')
    })

    it('before: missing agent counts as 0', () => {
      const a = new VectorClock({ x: 1 })
      const b = new VectorClock({ x: 1, y: 1 })
      expect(a.compare(b)).toBe('before')
    })

    it('after: all counters >= other, at least one >', () => {
      const a = new VectorClock({ x: 3, y: 5 })
      const b = new VectorClock({ x: 2, y: 3 })
      expect(a.compare(b)).toBe('after')
    })

    it('after: other missing agent counts as 0', () => {
      const a = new VectorClock({ x: 1, y: 1 })
      const b = new VectorClock({ x: 1 })
      expect(a.compare(b)).toBe('after')
    })

    it('concurrent: some greater some less', () => {
      const a = new VectorClock({ x: 3, y: 1 })
      const b = new VectorClock({ x: 1, y: 3 })
      expect(a.compare(b)).toBe('concurrent')
    })

    it('concurrent: disjoint agents', () => {
      const a = new VectorClock({ x: 1 })
      const b = new VectorClock({ y: 1 })
      expect(a.compare(b)).toBe('concurrent')
    })

    it('empty clock is before any non-empty clock', () => {
      const empty = new VectorClock()
      const nonEmpty = new VectorClock({ x: 1 })
      expect(empty.compare(nonEmpty)).toBe('before')
      expect(nonEmpty.compare(empty)).toBe('after')
    })
  })

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  describe('toJSON / fromJSON', () => {
    it('roundtrips correctly', () => {
      const original = new VectorClock({ 'agent-a': 5, 'agent-b': 12 })
      const json = original.toJSON()
      const restored = VectorClock.fromJSON(json)

      expect(restored.get('agent-a')).toBe(5)
      expect(restored.get('agent-b')).toBe(12)
      expect(restored.compare(original)).toBe('equal')
    })

    it('toJSON returns plain object', () => {
      const clock = new VectorClock({ a: 1, b: 2 })
      const json = clock.toJSON()
      expect(json).toEqual({ a: 1, b: 2 })
      expect(json.constructor).toBe(Object)
    })

    it('handles empty clock', () => {
      const clock = new VectorClock()
      const json = clock.toJSON()
      expect(json).toEqual({})
      const restored = VectorClock.fromJSON(json)
      expect(restored.size).toBe(0)
    })
  })
})
