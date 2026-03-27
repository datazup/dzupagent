import { describe, it, expect, beforeEach } from 'vitest'
import { AdaptiveIterationController } from '../self-correction/iteration-controller.js'

describe('AdaptiveIterationController', () => {
  let controller: AdaptiveIterationController

  beforeEach(() => {
    controller = new AdaptiveIterationController({
      targetScore: 0.8,
      maxIterations: 5,
      costBudgetCents: 100,
      minImprovement: 0.02,
      plateauPatience: 2,
    })
  })

  // --- Target met ---

  it('stops when target score is met', () => {
    const decision = controller.decide(0.85, 10)
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('target_met')
    expect(decision.estimatedCostToTarget).toBe(0)
  })

  it('stops when target score is exactly met', () => {
    const decision = controller.decide(0.8, 10)
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('target_met')
  })

  // --- Max iterations ---

  it('stops when max iterations reached', () => {
    controller.decide(0.3, 5) // 1
    controller.decide(0.4, 5) // 2
    controller.decide(0.5, 5) // 3
    controller.decide(0.6, 5) // 4
    const decision = controller.decide(0.7, 5) // 5 = max
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('budget_exhausted')
  })

  // --- Budget exhaustion ---

  it('stops when cost budget is 95% exhausted', () => {
    controller.decide(0.3, 50) // 50 total
    const decision = controller.decide(0.5, 46) // 96 total >= 95
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('budget_exhausted')
  })

  it('continues when cost budget is below 95%', () => {
    const decision = controller.decide(0.3, 90) // 90 total < 95
    expect(decision.shouldContinue).toBe(true)
    expect(decision.reason).toBe('continue')
  })

  // --- No improvement (plateau) ---

  it('detects plateau when scores do not improve over patience window', () => {
    controller.decide(0.5, 10) // baseline
    controller.decide(0.5, 10) // no improvement (1 of 2)
    const decision = controller.decide(0.51, 10) // delta 0.01 < minImprovement 0.02 (2 of 2)
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('no_improvement')
  })

  it('does not flag plateau when improvement exceeds minimum', () => {
    const c = new AdaptiveIterationController({
      targetScore: 0.8,
      maxIterations: 10,
      costBudgetCents: 1000,
      minImprovement: 0.02,
      plateauPatience: 2,
    })
    c.decide(0.5, 1) // baseline
    c.decide(0.5, 1) // no improvement
    const decision = c.decide(0.53, 1) // delta 0.03 >= minImprovement 0.02
    expect(decision.shouldContinue).toBe(true)
  })

  // --- Diminishing returns ---

  it('detects diminishing returns when improvement rate drops sharply', () => {
    controller.decide(0.3, 10)  // iter 1
    controller.decide(0.5, 10)  // iter 2, delta = 0.20
    const decision = controller.decide(0.51, 10) // iter 3, delta = 0.01 < 0.20 * 0.5 = 0.10 AND < minImprovement
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('diminishing_returns')
  })

  it('does not flag diminishing returns when rate stays strong', () => {
    controller.decide(0.3, 10)  // iter 1
    controller.decide(0.5, 10)  // iter 2, delta = 0.20
    const decision = controller.decide(0.65, 10) // iter 3, delta = 0.15 > 0.10
    expect(decision.shouldContinue).toBe(true)
  })

  // --- Cost-prohibitive ---

  it('stops when estimated cost to target exceeds remaining budget', () => {
    // With costBudget=100, small improvements, expensive iterations
    controller = new AdaptiveIterationController({
      targetScore: 0.9,
      maxIterations: 20,
      costBudgetCents: 100,
      minImprovement: 0.001, // low so plateau doesn't trigger first
      plateauPatience: 10,   // high so plateau doesn't trigger first
    })
    controller.decide(0.1, 40) // iter 1
    // delta = 0.02, avgCost = 40, gap = 0.78, estimated = 0.78/0.02 * 40 = 1560 >> remaining 20
    const decision = controller.decide(0.12, 40) // iter 2, total cost 80
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('cost_prohibitive')
  })

  // --- First iteration always continues ---

  it('continues on first iteration when score is below target', () => {
    const decision = controller.decide(0.3, 5)
    expect(decision.shouldContinue).toBe(true)
    expect(decision.reason).toBe('continue')
  })

  // --- Zero improvement ---

  it('handles zero improvement across all iterations', () => {
    controller.decide(0.5, 10) // baseline
    controller.decide(0.5, 10) // no improvement
    const decision = controller.decide(0.5, 10) // still no improvement
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('no_improvement')
  })

  // --- Score and cost history tracking ---

  it('tracks score history', () => {
    controller.decide(0.3, 5)
    controller.decide(0.5, 10)
    controller.decide(0.6, 8)
    expect(controller.scoreHistory).toEqual([0.3, 0.5, 0.6])
  })

  it('tracks cumulative cost', () => {
    controller.decide(0.3, 5)
    controller.decide(0.5, 10)
    controller.decide(0.6, 8)
    expect(controller.totalCostCents).toBe(23)
  })

  it('tracks best score', () => {
    controller.decide(0.3, 5)
    controller.decide(0.6, 5)
    controller.decide(0.5, 5) // regressed
    expect(controller.bestScore).toBe(0.6)
  })

  it('tracks current iteration count', () => {
    expect(controller.currentIteration).toBe(0)
    controller.decide(0.3, 5)
    expect(controller.currentIteration).toBe(1)
    controller.decide(0.5, 5)
    expect(controller.currentIteration).toBe(2)
  })

  // --- Reset ---

  it('reset clears all state', () => {
    controller.decide(0.3, 5)
    controller.decide(0.5, 10)
    controller.reset()

    expect(controller.currentIteration).toBe(0)
    expect(controller.scoreHistory).toEqual([])
    expect(controller.totalCostCents).toBe(0)
    expect(controller.bestScore).toBe(0)
  })

  // --- Improvement probability ---

  it('returns 0.5 improvement probability on first iteration (no data)', () => {
    const decision = controller.decide(0.3, 5)
    expect(decision.improvementProbability).toBe(0.5)
  })

  it('returns high improvement probability when consistently improving', () => {
    controller.decide(0.3, 5)
    const decision = controller.decide(0.5, 5)
    expect(decision.improvementProbability).toBeGreaterThan(0.5)
  })

  it('returns low improvement probability when scores stagnate', () => {
    controller.decide(0.5, 5)
    controller.decide(0.5, 5)
    const decision = controller.decide(0.5, 5)
    expect(decision.improvementProbability).toBeLessThan(0.5)
  })

  // --- Estimated cost to target ---

  it('returns finite cost estimate when there is measurable improvement', () => {
    controller.decide(0.4, 10)
    const decision = controller.decide(0.5, 10)
    // gap = 0.3, avgImprovement = 0.1, avgCost = 10, estimated = 3 * 10 = 30
    expect(decision.estimatedCostToTarget).toBeCloseTo(30, 5)
  })

  it('returns Infinity when there is no improvement', () => {
    controller.decide(0.5, 10)
    const decision = controller.decide(0.5, 10)
    expect(decision.estimatedCostToTarget).toBe(Infinity)
  })

  // --- Default config ---

  it('uses default config values when no config provided', () => {
    const defaultController = new AdaptiveIterationController()
    // Should use targetScore: 0.8
    const decision = defaultController.decide(0.85, 5)
    expect(decision.shouldContinue).toBe(false)
    expect(decision.reason).toBe('target_met')
  })
})
