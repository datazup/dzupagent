import { describe, it, expect, beforeEach } from 'vitest'
import { StrategyRanker } from '../recovery/strategy-ranker.js'
import type { RecoveryStrategy } from '../recovery/recovery-types.js'

function makeStrategy(overrides: Partial<RecoveryStrategy> = {}): RecoveryStrategy {
  return {
    name: 'test_strategy',
    description: 'A test strategy',
    confidence: 0.7,
    risk: 'low',
    estimatedSteps: 2,
    actions: [],
    ...overrides,
  }
}

describe('StrategyRanker', () => {
  let ranker: StrategyRanker

  beforeEach(() => {
    ranker = new StrategyRanker()
  })

  // -------------------------------------------------------------------------
  // rank
  // -------------------------------------------------------------------------

  describe('rank', () => {
    it('ranks higher-confidence strategies first', () => {
      const strategies = [
        makeStrategy({ name: 'low', confidence: 0.3 }),
        makeStrategy({ name: 'high', confidence: 0.9 }),
        makeStrategy({ name: 'mid', confidence: 0.6 }),
      ]

      const ranked = ranker.rank(strategies)
      expect(ranked[0]!.name).toBe('high')
      expect(ranked[1]!.name).toBe('mid')
      expect(ranked[2]!.name).toBe('low')
    })

    it('considers risk in ranking', () => {
      const strategies = [
        makeStrategy({ name: 'high_risk', confidence: 0.8, risk: 'high' }),
        makeStrategy({ name: 'low_risk', confidence: 0.7, risk: 'low' }),
      ]

      const ranked = ranker.rank(strategies)
      // low_risk should win because risk penalty on high is significant
      expect(ranked[0]!.name).toBe('low_risk')
    })

    it('considers estimated steps in ranking', () => {
      const strategies = [
        makeStrategy({ name: 'complex', confidence: 0.7, estimatedSteps: 8 }),
        makeStrategy({ name: 'simple', confidence: 0.7, estimatedSteps: 1 }),
      ]

      const ranked = ranker.rank(strategies)
      expect(ranked[0]!.name).toBe('simple')
    })

    it('penalizes already-attempted strategies', () => {
      const strategies = [
        makeStrategy({ name: 'attempted', confidence: 0.9 }),
        makeStrategy({ name: 'fresh', confidence: 0.5 }),
      ]

      ranker.markAttempted('attempted')
      const ranked = ranker.rank(strategies)
      expect(ranked[0]!.name).toBe('fresh')
    })
  })

  // -------------------------------------------------------------------------
  // computeScore
  // -------------------------------------------------------------------------

  describe('computeScore', () => {
    it('returns a positive number', () => {
      const strategy = makeStrategy()
      const score = ranker.computeScore(strategy)
      expect(score).toBeGreaterThan(0)
    })

    it('high confidence + low risk + few steps = highest score', () => {
      const best = makeStrategy({ confidence: 1.0, risk: 'low', estimatedSteps: 1 })
      const worst = makeStrategy({ confidence: 0.1, risk: 'high', estimatedSteps: 10 })

      expect(ranker.computeScore(best)).toBeGreaterThan(ranker.computeScore(worst))
    })

    it('caps estimated steps at 10 for scoring', () => {
      const s10 = makeStrategy({ estimatedSteps: 10 })
      const s20 = makeStrategy({ estimatedSteps: 20 })

      // Both should score the same on the cost dimension (capped at 10)
      expect(ranker.computeScore(s10)).toBe(ranker.computeScore(s20))
    })
  })

  // -------------------------------------------------------------------------
  // selectBest
  // -------------------------------------------------------------------------

  describe('selectBest', () => {
    it('selects the highest-ranked strategy', () => {
      const strategies = [
        makeStrategy({ name: 'a', confidence: 0.3 }),
        makeStrategy({ name: 'b', confidence: 0.9 }),
      ]

      const best = ranker.selectBest(strategies)
      expect(best?.name).toBe('b')
    })

    it('respects minConfidence threshold', () => {
      const strategies = [
        makeStrategy({ name: 'a', confidence: 0.3 }),
        makeStrategy({ name: 'b', confidence: 0.4 }),
      ]

      const best = ranker.selectBest(strategies, 0.5)
      // Both are below threshold, but selectBest falls back to first unattempted
      expect(best).not.toBeNull()
    })

    it('skips attempted strategies when a fresh one meets threshold', () => {
      const strategies = [
        makeStrategy({ name: 'attempted', confidence: 0.9 }),
        makeStrategy({ name: 'fresh', confidence: 0.7 }),
      ]

      ranker.markAttempted('attempted')
      const best = ranker.selectBest(strategies, 0.5)
      expect(best?.name).toBe('fresh')
    })

    it('returns null when all strategies have been attempted', () => {
      const strategies = [
        makeStrategy({ name: 'a' }),
        makeStrategy({ name: 'b' }),
      ]

      ranker.markAttempted('a')
      ranker.markAttempted('b')
      const best = ranker.selectBest(strategies)
      expect(best).toBeNull()
    })

    it('returns null for empty strategy list', () => {
      const best = ranker.selectBest([])
      expect(best).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // markAttempted / wasAttempted / reset
  // -------------------------------------------------------------------------

  describe('attempt tracking', () => {
    it('marks strategies as attempted', () => {
      ranker.markAttempted('retry')
      expect(ranker.wasAttempted('retry')).toBe(true)
      expect(ranker.wasAttempted('rollback')).toBe(false)
    })

    it('reset clears attempt history', () => {
      ranker.markAttempted('retry')
      ranker.reset()
      expect(ranker.wasAttempted('retry')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Custom weights
  // -------------------------------------------------------------------------

  describe('custom weights', () => {
    it('allows overriding ranking weights', () => {
      // Risk-only ranking
      const riskRanker = new StrategyRanker({ confidence: 0, risk: 1.0, cost: 0 })

      const strategies = [
        makeStrategy({ name: 'low_conf_low_risk', confidence: 0.1, risk: 'low' }),
        makeStrategy({ name: 'high_conf_high_risk', confidence: 0.9, risk: 'high' }),
      ]

      const ranked = riskRanker.rank(strategies)
      expect(ranked[0]!.name).toBe('low_conf_low_risk')
    })
  })
})
