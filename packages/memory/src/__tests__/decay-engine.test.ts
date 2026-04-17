import { describe, it, expect } from 'vitest'
import {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
} from '../decay-engine.js'
import type { DecayMetadata } from '../decay-engine.js'

// Helpers
function makeMeta(overrides?: Partial<DecayMetadata>): DecayMetadata {
  const now = Date.now()
  return {
    strength: 1,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    halfLifeMs: 24 * 60 * 60 * 1000,
    ...overrides,
  }
}

describe('decay-engine', () => {
  describe('calculateStrength', () => {
    it('returns 1 when elapsed is 0', () => {
      const meta = makeMeta({ lastAccessedAt: 1000 })
      expect(calculateStrength(meta, 1000)).toBeCloseTo(1, 10)
    })

    it('returns 0.5 after exactly one half-life', () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1000 })
      const strength = calculateStrength(meta, 1000)
      // e^(-1) ≈ 0.3679 (exponential decay, not geometric halving)
      expect(strength).toBeCloseTo(Math.exp(-1), 5)
    })

    it('clamps negative elapsed to 0 (future lastAccessedAt)', () => {
      const meta = makeMeta({ lastAccessedAt: 2000 })
      // now < lastAccessedAt -> elapsed < 0 -> Math.max(0, ...) = 0
      expect(calculateStrength(meta, 1000)).toBe(1)
    })

    it('uses Date.now() when now is undefined', () => {
      const meta = makeMeta({ lastAccessedAt: Date.now() })
      const strength = calculateStrength(meta)
      expect(strength).toBeGreaterThan(0.999)
      expect(strength).toBeLessThanOrEqual(1)
    })

    it('approaches 0 after many half-lives', () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1 })
      const strength = calculateStrength(meta, 1000)
      expect(strength).toBeLessThan(1e-400 < Number.MIN_VALUE ? 1e-100 : 1)
      expect(strength).toBeGreaterThanOrEqual(0)
    })

    it('handles very large halfLifeMs (long-lived memory)', () => {
      const meta = makeMeta({
        lastAccessedAt: 0,
        halfLifeMs: Number.MAX_SAFE_INTEGER,
      })
      const strength = calculateStrength(meta, 1000)
      expect(strength).toBeCloseTo(1, 10)
    })

    it('handles identical lastAccessedAt and now', () => {
      const meta = makeMeta({ lastAccessedAt: 5000 })
      expect(calculateStrength(meta, 5000)).toBe(1)
    })
  })

  describe('reinforceMemory', () => {
    it('resets strength to 1 on reinforcement', () => {
      const meta = makeMeta({ strength: 0.2, accessCount: 3 })
      const updated = reinforceMemory(meta)
      expect(updated.strength).toBe(1)
    })

    it('increments accessCount by 1', () => {
      const meta = makeMeta({ accessCount: 5 })
      const updated = reinforceMemory(meta)
      expect(updated.accessCount).toBe(6)
    })

    it('doubles halfLifeMs up to MAX_HALF_LIFE_MS', () => {
      const meta = makeMeta({ halfLifeMs: 1000 })
      const updated = reinforceMemory(meta)
      expect(updated.halfLifeMs).toBe(2000)
    })

    it('caps halfLifeMs at 30 days', () => {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
      const meta = makeMeta({ halfLifeMs: THIRTY_DAYS })
      const updated = reinforceMemory(meta)
      expect(updated.halfLifeMs).toBe(THIRTY_DAYS)
    })

    it('caps halfLifeMs at 30 days even from above-limit input', () => {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
      const meta = makeMeta({ halfLifeMs: THIRTY_DAYS * 10 })
      const updated = reinforceMemory(meta)
      expect(updated.halfLifeMs).toBe(THIRTY_DAYS)
    })

    it('updates lastAccessedAt to now', () => {
      const before = Date.now()
      const meta = makeMeta({ lastAccessedAt: 0 })
      const updated = reinforceMemory(meta)
      const after = Date.now()
      expect(updated.lastAccessedAt).toBeGreaterThanOrEqual(before)
      expect(updated.lastAccessedAt).toBeLessThanOrEqual(after)
    })

    it('preserves createdAt across reinforcement', () => {
      const meta = makeMeta({ createdAt: 42 })
      const updated = reinforceMemory(meta)
      expect(updated.createdAt).toBe(42)
    })
  })

  describe('createDecayMetadata', () => {
    it('returns full strength and zero accessCount', () => {
      const meta = createDecayMetadata()
      expect(meta.strength).toBe(1)
      expect(meta.accessCount).toBe(0)
    })

    it('sets lastAccessedAt === createdAt', () => {
      const meta = createDecayMetadata()
      expect(meta.lastAccessedAt).toBe(meta.createdAt)
    })

    it('uses DEFAULT_HALF_LIFE_MS (24 hours)', () => {
      const meta = createDecayMetadata()
      expect(meta.halfLifeMs).toBe(24 * 60 * 60 * 1000)
    })
  })

  describe('scoreWithDecay', () => {
    it('multiplies relevance by strength', () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1000 })
      const strength = Math.exp(-1)
      const score = scoreWithDecay(0.8, meta, 1000)
      expect(score).toBeCloseTo(0.8 * strength, 5)
    })

    it('returns 0 when relevance is 0', () => {
      const meta = makeMeta({ lastAccessedAt: 0 })
      expect(scoreWithDecay(0, meta, 1000)).toBe(0)
    })

    it('returns full relevance when fresh (elapsed=0)', () => {
      const meta = makeMeta({ lastAccessedAt: 100 })
      expect(scoreWithDecay(0.5, meta, 100)).toBeCloseTo(0.5, 10)
    })

    it('uses Date.now() when now is undefined', () => {
      const meta = makeMeta({ lastAccessedAt: Date.now() })
      const score = scoreWithDecay(0.9, meta)
      expect(score).toBeCloseTo(0.9, 3)
    })
  })

  describe('findWeakMemories', () => {
    it('returns empty list when no records exist', () => {
      const weak = findWeakMemories([])
      expect(weak).toEqual([])
    })

    it('returns empty list when all records are strong', () => {
      const meta = makeMeta({ lastAccessedAt: Date.now() })
      const weak = findWeakMemories([{ key: 'a', meta }])
      expect(weak).toEqual([])
    })

    it('returns records below default threshold (0.1)', () => {
      const old: DecayMetadata = {
        strength: 0.01,
        accessCount: 0,
        lastAccessedAt: 0,
        createdAt: 0,
        halfLifeMs: 100,
      }
      const weak = findWeakMemories([{ key: 'old', meta: old }])
      expect(weak).toHaveLength(1)
      expect(weak[0]!.key).toBe('old')
      expect(weak[0]!.strength).toBeLessThan(0.1)
    })

    it('sorts weakest-first (ascending)', () => {
      const now = Date.now()
      // Very old (near-zero) vs. less old
      const dead: DecayMetadata = {
        strength: 0, accessCount: 0, lastAccessedAt: 0,
        createdAt: 0, halfLifeMs: 100,
      }
      const stillWeak: DecayMetadata = {
        strength: 0, accessCount: 0,
        lastAccessedAt: now - 3 * 100, // 3 half-lives -> ~0.05
        createdAt: now - 3 * 100, halfLifeMs: 100,
      }
      const weak = findWeakMemories([
        { key: 'still-weak', meta: stillWeak },
        { key: 'dead', meta: dead },
      ])
      expect(weak[0]!.strength).toBeLessThanOrEqual(weak[1]!.strength)
    })

    it('respects custom threshold', () => {
      const now = Date.now()
      const mediumMeta: DecayMetadata = {
        strength: 0, accessCount: 0,
        lastAccessedAt: now - 1000, // ~0.37 after 1 halfLife
        createdAt: now - 1000,
        halfLifeMs: 1000,
      }
      // Strict threshold 0.1 -> not weak
      expect(findWeakMemories([{ key: 'm', meta: mediumMeta }], 0.1)).toHaveLength(0)
      // Looser threshold 0.5 -> weak
      expect(findWeakMemories([{ key: 'm', meta: mediumMeta }], 0.5)).toHaveLength(1)
    })

    it('preserves key through result', () => {
      const meta: DecayMetadata = {
        strength: 0, accessCount: 0, lastAccessedAt: 0,
        createdAt: 0, halfLifeMs: 1,
      }
      const weak = findWeakMemories([{ key: 'custom-key-42', meta }])
      expect(weak[0]!.key).toBe('custom-key-42')
    })
  })
})
