import { describe, expect, it } from 'vitest'
import {
  applyCost,
  createBudgetTrackerState,
} from '../pipeline/pipeline-runtime/iteration-budget-tracker.js'

describe('iteration-budget-tracker', () => {
  it('starts with zero cost and no warnings emitted', () => {
    const state = createBudgetTrackerState()
    expect(state.cumulativeCostCents).toBe(0)
    expect(state.warnings.warn70).toBe(false)
    expect(state.warnings.warn90).toBe(false)
  })

  it('ignores zero or negative cost contributions without advancing the budget', () => {
    const state = createBudgetTrackerState()
    expect(applyCost(state, 0, 100)).toEqual({ cumulativeCostCents: 0, warning: undefined })
    expect(applyCost(state, -25, 100)).toEqual({ cumulativeCostCents: 0, warning: undefined })
    expect(state.warnings).toEqual({ warn70: false, warn90: false })
  })

  it('emits warn_70 the first time cumulative cost reaches >=70%', () => {
    const state = createBudgetTrackerState()

    // 60% — below 70 threshold
    expect(applyCost(state, 60, 100).warning).toBeUndefined()

    // jumps to 75% — fires warn_70 once
    const decision = applyCost(state, 15, 100)
    expect(decision.warning).toBe('warn_70')
    expect(decision.cumulativeCostCents).toBe(75)
    expect(state.warnings.warn70).toBe(true)
  })

  it('emits warn_70 only once even on subsequent sub-threshold steps', () => {
    const state = createBudgetTrackerState()
    expect(applyCost(state, 70, 100).warning).toBe('warn_70')
    // Adding more cost in the 70-89% band must not re-fire warn_70.
    expect(applyCost(state, 5, 100).warning).toBeUndefined()
    expect(applyCost(state, 5, 100).warning).toBeUndefined()
  })

  it('emits warn_90 separately after warn_70 has fired', () => {
    const state = createBudgetTrackerState()
    expect(applyCost(state, 75, 100).warning).toBe('warn_70')
    const decision = applyCost(state, 20, 100)
    expect(decision.warning).toBe('warn_90')
    expect(decision.cumulativeCostCents).toBe(95)
    expect(state.warnings.warn90).toBe(true)
  })

  it('emits warn_90 ahead of warn_70 when a single step jumps straight past 90%', () => {
    // Mirrors the runtime's original `if/else if` semantics: in a single
    // call, 90% wins over 70%. The 70% flag stays unset, so a later
    // sub-90% step would still fire warn_70 — that's the existing
    // runtime behaviour we are preserving.
    const state = createBudgetTrackerState()
    const decision = applyCost(state, 95, 100)
    expect(decision.warning).toBe('warn_90')
    expect(state.warnings.warn90).toBe(true)
    expect(state.warnings.warn70).toBe(false)
  })

  it('does not re-fire warn_90 once it has already fired', () => {
    const state = createBudgetTrackerState()
    expect(applyCost(state, 75, 100).warning).toBe('warn_70')
    expect(applyCost(state, 20, 100).warning).toBe('warn_90')
    // Subsequent contributions while warn_90 is set must not re-fire it.
    expect(applyCost(state, 10, 100).warning).toBeUndefined()
    expect(applyCost(state, 100, 100).warning).toBeUndefined()
  })

  it('never emits a warning when budget is non-positive', () => {
    const state = createBudgetTrackerState()
    const decision = applyCost(state, 50, 0)
    expect(decision.warning).toBeUndefined()
    // Non-positive budget still accumulates cost but gates warnings off.
    expect(state.cumulativeCostCents).toBe(50)
    expect(state.warnings).toEqual({ warn70: false, warn90: false })
  })

  it('returns the running cumulative cost on every call', () => {
    const state = createBudgetTrackerState()
    expect(applyCost(state, 10, 100).cumulativeCostCents).toBe(10)
    expect(applyCost(state, 25, 100).cumulativeCostCents).toBe(35)
    expect(applyCost(state, 40, 100).cumulativeCostCents).toBe(75)
  })

  it('fires each warning at most once across many small contributions', () => {
    const state = createBudgetTrackerState()
    const warnings: string[] = []
    for (let i = 0; i < 20; i++) {
      const d = applyCost(state, 5, 100) // 5, 10, ..., 100
      if (d.warning) warnings.push(d.warning)
    }
    expect(warnings).toEqual(['warn_70', 'warn_90'])
  })
})
