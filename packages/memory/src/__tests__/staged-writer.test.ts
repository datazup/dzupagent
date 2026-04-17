import { describe, it, expect } from 'vitest'
import { StagedWriter } from '../staged-writer.js'
import type { StagedRecord } from '../staged-writer.js'

type CaptureInput = Omit<StagedRecord, 'stage' | 'createdAt'>

function baseRecord(overrides?: Partial<CaptureInput>): CaptureInput {
  return {
    key: 'rec-1',
    namespace: 'observations',
    scope: { tenantId: 't1' },
    value: { text: 'observation' },
    confidence: 0.5,
    ...overrides,
  }
}

describe('StagedWriter', () => {
  describe('capture', () => {
    it('captures a new record and stores it in captured stage', () => {
      const w = new StagedWriter()
      const r = w.capture(baseRecord({ confidence: 0.2 }))
      expect(r.stage).toBe('captured')
      expect(r.createdAt).toBeGreaterThan(0)
    })

    it('auto-promotes when confidence >= autoPromoteThreshold', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0.5 })
      const r = w.capture(baseRecord({ confidence: 0.6 }))
      expect(r.stage).toBe('candidate')
      expect(r.promotedAt).toBeDefined()
    })

    it('does NOT auto-promote when confidence < threshold', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0.7 })
      const r = w.capture(baseRecord({ confidence: 0.6 }))
      expect(r.stage).toBe('captured')
      expect(r.promotedAt).toBeUndefined()
    })

    it('auto-confirms when confidence >= autoConfirmThreshold', () => {
      const w = new StagedWriter({
        autoPromoteThreshold: 0.5,
        autoConfirmThreshold: 0.9,
      })
      const r = w.capture(baseRecord({ confidence: 0.95 }))
      expect(r.stage).toBe('confirmed')
      expect(r.confirmedAt).toBeDefined()
    })

    it('promotes to candidate but does not confirm for mid-confidence', () => {
      const w = new StagedWriter({
        autoPromoteThreshold: 0.5,
        autoConfirmThreshold: 0.9,
      })
      const r = w.capture(baseRecord({ confidence: 0.75 }))
      expect(r.stage).toBe('candidate')
      expect(r.confirmedAt).toBeUndefined()
    })
  })

  describe('promote', () => {
    it('returns null when key missing', () => {
      const w = new StagedWriter()
      expect(w.promote('missing')).toBeNull()
    })

    it('returns null when record not in captured stage', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0.5, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.6 }))
      // Already candidate -> promote again should return null
      expect(w.promote('k1')).toBeNull()
    })

    it('transitions captured -> candidate', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.2 }))
      const r = w.promote('k1')
      expect(r?.stage).toBe('candidate')
      expect(r?.promotedAt).toBeDefined()
    })

    it('auto-confirms after promote when confidence >= autoConfirmThreshold', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 0.9 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.95 }))
      const r = w.promote('k1')
      expect(r?.stage).toBe('confirmed')
    })
  })

  describe('confirm', () => {
    it('returns null when key missing', () => {
      const w = new StagedWriter()
      expect(w.confirm('nope')).toBeNull()
    })

    it('returns null when record not in candidate stage', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.2 }))
      // still captured
      expect(w.confirm('k1')).toBeNull()
    })

    it('transitions candidate -> confirmed', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.2 }))
      w.promote('k1')
      const r = w.confirm('k1')
      expect(r?.stage).toBe('confirmed')
      expect(r?.confirmedAt).toBeDefined()
    })
  })

  describe('reject', () => {
    it('returns null for missing key', () => {
      const w = new StagedWriter()
      expect(w.reject('ghost')).toBeNull()
    })

    it('can reject captured records', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.2 }))
      const r = w.reject('k1')
      expect(r?.stage).toBe('rejected')
    })

    it('can reject candidate records', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.1 }))
      const r = w.reject('k1')
      expect(r?.stage).toBe('rejected')
    })

    it('can reject confirmed records', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0, autoConfirmThreshold: 0 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.95 }))
      const r = w.reject('k1')
      expect(r?.stage).toBe('rejected')
    })
  })

  describe('getByStage / getPending', () => {
    it('filters records by stage correctly', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'a', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'b', confidence: 0.1 }))
      w.promote('b')

      expect(w.getByStage('captured')).toHaveLength(1)
      expect(w.getByStage('candidate')).toHaveLength(1)
      expect(w.getByStage('confirmed')).toHaveLength(0)
      expect(w.getByStage('rejected')).toHaveLength(0)
    })

    it('getPending returns captured + candidate, not confirmed/rejected', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'a', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'b', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'c', confidence: 0.1 }))
      w.promote('b')
      w.promote('c')
      w.confirm('c')
      w.reject('a')

      const pending = w.getPending()
      expect(pending.map((r) => r.key).sort()).toEqual(['b'])
    })
  })

  describe('flushConfirmed', () => {
    it('returns empty when no confirmed records', () => {
      const w = new StagedWriter()
      expect(w.flushConfirmed()).toEqual([])
    })

    it('returns confirmed records and removes them from pending map', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 0, autoConfirmThreshold: 0 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.99 }))
      w.capture(baseRecord({ key: 'k2', confidence: 0.99 }))

      const flushed = w.flushConfirmed()
      expect(flushed.map((r) => r.key).sort()).toEqual(['k1', 'k2'])

      // After flush, get() should return undefined
      expect(w.get('k1')).toBeUndefined()
      expect(w.get('k2')).toBeUndefined()
    })

    it('does NOT flush captured/candidate records', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2, autoConfirmThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.1 }))
      const flushed = w.flushConfirmed()
      expect(flushed).toEqual([])
      expect(w.get('k1')?.stage).toBe('captured')
    })
  })

  describe('get', () => {
    it('returns undefined for missing key', () => {
      const w = new StagedWriter()
      expect(w.get('nope')).toBeUndefined()
    })

    it('returns the record for a known key', () => {
      const w = new StagedWriter({ autoPromoteThreshold: 2 })
      w.capture(baseRecord({ key: 'k1', confidence: 0.1 }))
      expect(w.get('k1')?.stage).toBe('captured')
    })
  })

  describe('pruneIfNeeded (capacity enforcement)', () => {
    it('does not prune when capacity not reached', () => {
      const w = new StagedWriter({ maxPending: 100, autoPromoteThreshold: 2 })
      for (let i = 0; i < 10; i++) {
        w.capture(baseRecord({ key: `k${i}`, confidence: 0.1 }))
      }
      expect(w.getPending().length).toBe(10)
    })

    it('removes rejected records first when at capacity', () => {
      const w = new StagedWriter({ maxPending: 3, autoPromoteThreshold: 2 })
      w.capture(baseRecord({ key: 'a', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'b', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'c', confidence: 0.1 }))
      // Rejected record 'a' exists but does NOT count toward active
      w.reject('a')
      w.capture(baseRecord({ key: 'd', confidence: 0.1 }))
      w.capture(baseRecord({ key: 'e', confidence: 0.1 }))

      // At this point b, c, d, e are active (4) — next capture triggers prune
      w.capture(baseRecord({ key: 'f', confidence: 0.1 }))

      // 'a' (rejected) must have been removed first by the prune step
      expect(w.get('a')).toBeUndefined()
    })

    it('removes oldest captured records when still over capacity', async () => {
      const w = new StagedWriter({ maxPending: 3, autoPromoteThreshold: 2 })

      w.capture(baseRecord({ key: 'oldest', confidence: 0.1 }))
      await new Promise((r) => setTimeout(r, 2))
      w.capture(baseRecord({ key: 'middle', confidence: 0.1 }))
      await new Promise((r) => setTimeout(r, 2))
      w.capture(baseRecord({ key: 'newest', confidence: 0.1 }))

      // Capture one more -> should evict oldest first
      await new Promise((r) => setTimeout(r, 2))
      w.capture(baseRecord({ key: 'fourth', confidence: 0.1 }))

      expect(w.get('oldest')).toBeUndefined()
      expect(w.get('fourth')).toBeDefined()
    })
  })
})
