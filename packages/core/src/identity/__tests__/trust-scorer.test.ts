import { describe, it, expect, vi } from 'vitest'
import {
  createTrustScorer,
  InMemoryTrustScoreStore,
} from '../trust-scorer.js'
import type { TrustSignals } from '../trust-scorer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignals(overrides?: Partial<TrustSignals>): TrustSignals {
  return {
    totalOutcomes: 10,
    successfulOutcomes: 10,
    avgResponseTimeMs: 100,
    targetResponseTimeMs: 100,
    costAccuracyRatio: 1.0,
    constraintViolations: 0,
    totalDelegations: 5,
    lastOutcomeAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// calculate()
// ---------------------------------------------------------------------------

describe('TrustScorer.calculate', () => {
  it('returns ~1.0 for perfect signals', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(makeSignals())

    expect(breakdown.reliability).toBeCloseTo(1.0, 2)
    expect(breakdown.performance).toBeCloseTo(1.0, 2)
    expect(breakdown.costPredictability).toBeCloseTo(1.0, 2)
    expect(breakdown.delegationCompliance).toBeCloseTo(1.0, 2)
    expect(breakdown.recency).toBeCloseTo(1.0, 1)
    expect(breakdown.total).toBeCloseTo(1.0, 1)
  })

  it('returns low reliability for all failures', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ successfulOutcomes: 0 }),
    )

    expect(breakdown.reliability).toBe(0)
    expect(breakdown.total).toBeLessThan(0.7)
  })

  it('returns 0.5 default when below minSampleSize', () => {
    const scorer = createTrustScorer({ minSampleSize: 5 })
    const breakdown = scorer.calculate(makeSignals({ totalOutcomes: 3 }))

    expect(breakdown.reliability).toBe(0.5)
    expect(breakdown.performance).toBe(0.5)
    expect(breakdown.costPredictability).toBe(0.5)
    expect(breakdown.delegationCompliance).toBe(0.5)
    expect(breakdown.recency).toBe(0.5)
    expect(breakdown.total).toBe(0.5)
  })

  it('performance: faster than target scores 1.0', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ avgResponseTimeMs: 50, targetResponseTimeMs: 100 }),
    )

    // min(1.0, 100/50) = min(1.0, 2.0) = 1.0
    expect(breakdown.performance).toBe(1.0)
  })

  it('performance: 2x slower than target scores 0.5', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ avgResponseTimeMs: 200, targetResponseTimeMs: 100 }),
    )

    // min(1.0, 100/200) = 0.5
    expect(breakdown.performance).toBeCloseTo(0.5, 5)
  })

  it('cost predictability: exact match scores 1.0', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ costAccuracyRatio: 1.0 }),
    )

    expect(breakdown.costPredictability).toBe(1.0)
  })

  it('cost predictability: 2x cost scores 0.0', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ costAccuracyRatio: 2.0 }),
    )

    // 1.0 - min(1.0, |2.0 - 1.0|) = 1.0 - 1.0 = 0.0
    expect(breakdown.costPredictability).toBe(0.0)
  })

  it('delegation compliance: no violations scores 1.0', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({ constraintViolations: 0, totalDelegations: 10 }),
    )

    expect(breakdown.delegationCompliance).toBe(1.0)
  })

  it('recency: recent outcome scores high', () => {
    const scorer = createTrustScorer({
      minSampleSize: 1,
      recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
    })
    const breakdown = scorer.calculate(
      makeSignals({ lastOutcomeAt: new Date() }),
    )

    // Just happened, recency should be very close to 1.0
    expect(breakdown.recency).toBeGreaterThan(0.99)
  })

  it('recency: old outcome scores low (half-life decay)', () => {
    const halfLife = 7 * 24 * 60 * 60 * 1000 // 7 days
    const scorer = createTrustScorer({
      minSampleSize: 1,
      recencyHalfLifeMs: halfLife,
    })

    // 14 days ago = 2 half-lives => 2^(-2) = 0.25
    const twoHalfLivesAgo = new Date(Date.now() - 2 * halfLife)
    const breakdown = scorer.calculate(
      makeSignals({ lastOutcomeAt: twoHalfLivesAgo }),
    )

    expect(breakdown.recency).toBeCloseTo(0.25, 1)
  })

  it('weight sum equals total', () => {
    const scorer = createTrustScorer({ minSampleSize: 1 })
    const breakdown = scorer.calculate(
      makeSignals({
        successfulOutcomes: 8,
        avgResponseTimeMs: 150,
        targetResponseTimeMs: 100,
        costAccuracyRatio: 1.2,
        constraintViolations: 1,
        totalDelegations: 10,
      }),
    )

    const expectedTotal =
      breakdown.reliability * 0.35 +
      breakdown.performance * 0.2 +
      breakdown.costPredictability * 0.15 +
      breakdown.delegationCompliance * 0.15 +
      breakdown.recency * 0.15

    expect(breakdown.total).toBeCloseTo(expectedTotal, 10)
  })
})

// ---------------------------------------------------------------------------
// recordOutcome()
// ---------------------------------------------------------------------------

describe('TrustScorer.recordOutcome', () => {
  it('updates signals and recalculates', async () => {
    const store = new InMemoryTrustScoreStore()
    const scorer = createTrustScorer({ store, minSampleSize: 1 })

    const breakdown = await scorer.recordOutcome('agent-1', {
      success: true,
      responseTimeMs: 100,
    })

    expect(breakdown.total).toBeGreaterThan(0)

    const signals = await store.getSignals('agent-1')
    expect(signals).toBeDefined()
    expect(signals!.totalOutcomes).toBe(1)
    expect(signals!.successfulOutcomes).toBe(1)
  })

  it('accumulates multiple outcomes', async () => {
    const store = new InMemoryTrustScoreStore()
    const scorer = createTrustScorer({ store, minSampleSize: 1 })

    await scorer.recordOutcome('agent-1', { success: true, responseTimeMs: 100 })
    await scorer.recordOutcome('agent-1', { success: false, responseTimeMs: 200 })

    const signals = await store.getSignals('agent-1')
    expect(signals!.totalOutcomes).toBe(2)
    expect(signals!.successfulOutcomes).toBe(1)
    expect(signals!.avgResponseTimeMs).toBe(150) // (100+200)/2
  })

  it('calls onScoreChanged on significant change', async () => {
    const onChange = vi.fn()
    const store = new InMemoryTrustScoreStore()
    const scorer = createTrustScorer({
      store,
      minSampleSize: 1,
      significanceThreshold: 0.01,
      onScoreChanged: onChange,
    })

    // First outcome — score changes from default 0.5
    await scorer.recordOutcome('agent-1', {
      success: true,
      responseTimeMs: 50,
    })

    expect(onChange).toHaveBeenCalled()
    const [agentId, prev, next] = onChange.mock.calls[0] as [string, number, number]
    expect(agentId).toBe('agent-1')
    expect(typeof prev).toBe('number')
    expect(typeof next).toBe('number')
    expect(prev).not.toBe(next)
  })

  it('does NOT call onScoreChanged when change is below threshold', async () => {
    const onChange = vi.fn()
    const store = new InMemoryTrustScoreStore()

    // Seed with a score that will be very close to the next computation
    await store.saveScore('agent-stable', 0.5)

    const scorer = createTrustScorer({
      store,
      minSampleSize: 10, // below sample size => 0.5 default => no change
      significanceThreshold: 0.05,
      onScoreChanged: onChange,
    })

    await scorer.recordOutcome('agent-stable', {
      success: true,
      responseTimeMs: 100,
    })

    // totalOutcomes=1 < minSampleSize=10, so score stays 0.5
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getScore()
// ---------------------------------------------------------------------------

describe('TrustScorer.getScore', () => {
  it('returns stored score', async () => {
    const store = new InMemoryTrustScoreStore()
    await store.saveScore('agent-x', 0.85)

    const scorer = createTrustScorer({ store })
    const score = await scorer.getScore('agent-x')
    expect(score).toBe(0.85)
  })

  it('returns 0.5 default for unknown agent', async () => {
    const scorer = createTrustScorer()
    const score = await scorer.getScore('unknown')
    expect(score).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// getChainTrust()
// ---------------------------------------------------------------------------

describe('TrustScorer.getChainTrust', () => {
  it('returns minimum score across chain', async () => {
    const store = new InMemoryTrustScoreStore()
    await store.saveScore('agent-a', 0.9)
    await store.saveScore('agent-b', 0.6)
    await store.saveScore('agent-c', 0.8)

    const scorer = createTrustScorer({ store })
    const trust = await scorer.getChainTrust({
      tokens: [
        { delegatee: 'agent-a' },
        { delegatee: 'agent-b' },
        { delegatee: 'agent-c' },
      ],
    })

    expect(trust).toBe(0.6)
  })

  it('returns 0.5 for empty chain', async () => {
    const scorer = createTrustScorer()
    const trust = await scorer.getChainTrust({ tokens: [] })
    expect(trust).toBe(0.5)
  })

  it('uses default score for unknown agents in chain', async () => {
    const store = new InMemoryTrustScoreStore()
    await store.saveScore('agent-known', 0.9)

    const scorer = createTrustScorer({ store })
    const trust = await scorer.getChainTrust({
      tokens: [
        { delegatee: 'agent-known' },
        { delegatee: 'agent-unknown' },
      ],
    })

    // unknown defaults to 0.5, which is lower than 0.9
    expect(trust).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// InMemoryTrustScoreStore
// ---------------------------------------------------------------------------

describe('InMemoryTrustScoreStore', () => {
  it('CRUD signals', async () => {
    const store = new InMemoryTrustScoreStore()

    expect(await store.getSignals('a')).toBeUndefined()

    const signals = makeSignals()
    await store.saveSignals('a', signals)
    expect(await store.getSignals('a')).toEqual(signals)

    const updated = makeSignals({ totalOutcomes: 20 })
    await store.saveSignals('a', updated)
    expect((await store.getSignals('a'))!.totalOutcomes).toBe(20)
  })

  it('CRUD scores', async () => {
    const store = new InMemoryTrustScoreStore()

    expect(await store.getScore('a')).toBeUndefined()

    await store.saveScore('a', 0.75)
    expect(await store.getScore('a')).toBe(0.75)

    await store.saveScore('a', 0.9)
    expect(await store.getScore('a')).toBe(0.9)
  })
})
