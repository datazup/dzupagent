import { describe, it, expect } from 'vitest'
import { getEscalationStrategy, DEFAULT_ESCALATION } from '../pipeline/fix-escalation.js'

describe('getEscalationStrategy', () => {
  it('returns targeted strategy for attempt 0', () => {
    const strategy = getEscalationStrategy(0)
    expect(strategy.name).toBe('targeted')
  })

  it('returns expanded strategy for attempt 1', () => {
    const strategy = getEscalationStrategy(1)
    expect(strategy.name).toBe('expanded')
    expect(strategy.includeFullVfs).toBe(true)
    expect(strategy.includePlan).toBe(true)
  })

  it('returns escalated strategy for attempt 2', () => {
    const strategy = getEscalationStrategy(2)
    expect(strategy.name).toBe('escalated')
    expect(strategy.modelTier).toBe('reasoning')
  })

  it('clamps to last strategy for attempt > strategies length', () => {
    const strategy = getEscalationStrategy(100)
    expect(strategy.name).toBe('escalated')
  })

  it('uses custom config when provided', () => {
    const custom = {
      maxAttempts: 2,
      strategies: [
        { name: 'targeted' as const },
        { name: 'expanded' as const, includeFullVfs: true },
      ],
    }
    expect(getEscalationStrategy(0, custom).name).toBe('targeted')
    expect(getEscalationStrategy(1, custom).name).toBe('expanded')
    expect(getEscalationStrategy(5, custom).name).toBe('expanded')
  })

  it('DEFAULT_ESCALATION has 3 strategies', () => {
    expect(DEFAULT_ESCALATION.strategies).toHaveLength(3)
    expect(DEFAULT_ESCALATION.maxAttempts).toBe(3)
  })
})
