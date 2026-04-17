/**
 * Branch-coverage tests for orchestration/contract-net/bid-strategies.ts.
 * Targets: maxCost=0 / maxDuration=0 edge cases, zero weights (fallback to 1/3),
 * single/empty input, and mutation-safety.
 */
import { describe, it, expect } from 'vitest'
import {
  createWeightedStrategy,
  lowestCostStrategy,
  fastestStrategy,
  highestQualityStrategy,
} from '../orchestration/contract-net/bid-strategies.js'
import type { ContractBid } from '../orchestration/contract-net/contract-net-types.js'

function bid(overrides: Partial<ContractBid>): ContractBid {
  return {
    agentId: overrides.agentId ?? 'a',
    cfpId: 'cfp1',
    estimatedCostCents: overrides.estimatedCostCents ?? 100,
    estimatedDurationMs: overrides.estimatedDurationMs ?? 1000,
    qualityEstimate: overrides.qualityEstimate ?? 0.5,
    confidence: overrides.confidence ?? 0.9,
    approach: 'std',
  }
}

describe('bid-strategies — branch coverage', () => {
  it('createWeightedStrategy with all zero weights falls back to equal 1/3 each', () => {
    const strat = createWeightedStrategy({ cost: 0, speed: 0, quality: 0 })
    // With all zero weights, total === 0 → falls into 1/3 branch
    const ranked = strat.evaluate([
      bid({ agentId: 'hi', qualityEstimate: 0.9, estimatedCostCents: 100, estimatedDurationMs: 1000 }),
      bid({ agentId: 'lo', qualityEstimate: 0.1, estimatedCostCents: 100, estimatedDurationMs: 1000 }),
    ])
    expect(ranked[0]?.agentId).toBe('hi')
  })

  it('createWeightedStrategy returns empty array on empty bids', () => {
    expect(createWeightedStrategy({}).evaluate([])).toEqual([])
  })

  it('createWeightedStrategy short-circuits for single bid', () => {
    const single = bid({ agentId: 'solo' })
    const result = createWeightedStrategy({}).evaluate([single])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(single)
  })

  it('createWeightedStrategy handles maxCost === 0 by using 1.0 normalized cost', () => {
    const strat = createWeightedStrategy({ cost: 1, speed: 0, quality: 0 })
    const ranked = strat.evaluate([
      bid({ agentId: 'a', estimatedCostCents: 0, estimatedDurationMs: 100 }),
      bid({ agentId: 'b', estimatedCostCents: 0, estimatedDurationMs: 100 }),
    ])
    expect(ranked).toHaveLength(2)
    // Both are tied so order is stable (or at least both returned)
    expect(ranked.map(r => r.agentId).sort()).toEqual(['a', 'b'])
  })

  it('createWeightedStrategy handles maxDuration === 0 by using 1.0 normalized speed', () => {
    const strat = createWeightedStrategy({ cost: 0, speed: 1, quality: 0 })
    const ranked = strat.evaluate([
      bid({ agentId: 'a', estimatedCostCents: 100, estimatedDurationMs: 0 }),
      bid({ agentId: 'b', estimatedCostCents: 200, estimatedDurationMs: 0 }),
    ])
    expect(ranked).toHaveLength(2)
  })

  it('createWeightedStrategy prefers higher quality when quality is sole weight', () => {
    const strat = createWeightedStrategy({ cost: 0, speed: 0, quality: 1 })
    const ranked = strat.evaluate([
      bid({ agentId: 'low', qualityEstimate: 0.2 }),
      bid({ agentId: 'hi', qualityEstimate: 0.95 }),
      bid({ agentId: 'mid', qualityEstimate: 0.5 }),
    ])
    expect(ranked.map(r => r.agentId)).toEqual(['hi', 'mid', 'low'])
  })

  it('createWeightedStrategy prefers lower cost when cost is sole weight', () => {
    const strat = createWeightedStrategy({ cost: 1, speed: 0, quality: 0 })
    const ranked = strat.evaluate([
      bid({ agentId: 'expensive', estimatedCostCents: 500 }),
      bid({ agentId: 'cheap', estimatedCostCents: 50 }),
      bid({ agentId: 'mid', estimatedCostCents: 200 }),
    ])
    expect(ranked[0]?.agentId).toBe('cheap')
    expect(ranked[2]?.agentId).toBe('expensive')
  })

  it('createWeightedStrategy prefers faster duration when speed is sole weight', () => {
    const strat = createWeightedStrategy({ cost: 0, speed: 1, quality: 0 })
    const ranked = strat.evaluate([
      bid({ agentId: 'slow', estimatedDurationMs: 5000 }),
      bid({ agentId: 'fast', estimatedDurationMs: 100 }),
      bid({ agentId: 'mid', estimatedDurationMs: 1000 }),
    ])
    expect(ranked[0]?.agentId).toBe('fast')
    expect(ranked[2]?.agentId).toBe('slow')
  })

  it('lowestCostStrategy does not mutate input', () => {
    const original: ContractBid[] = [
      bid({ agentId: 'a', estimatedCostCents: 100 }),
      bid({ agentId: 'b', estimatedCostCents: 50 }),
    ]
    const snapshot = [...original]
    lowestCostStrategy.evaluate(original)
    expect(original).toEqual(snapshot)
  })

  it('fastestStrategy returns empty for empty bids', () => {
    expect(fastestStrategy.evaluate([])).toEqual([])
  })

  it('highestQualityStrategy handles single element', () => {
    const b = bid({ agentId: 'only' })
    expect(highestQualityStrategy.evaluate([b])).toEqual([b])
  })
})
