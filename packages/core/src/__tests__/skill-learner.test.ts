import { describe, it, expect, beforeEach } from 'vitest'
import { SkillLearner } from '../skills/skill-learner.js'
import type { SkillExecutionResult, SkillLearnerConfig } from '../skills/skill-learner.js'

describe('SkillLearner', () => {
  let learner: SkillLearner

  beforeEach(() => {
    learner = new SkillLearner()
  })

  // ---------------------------------------------------------------------------
  // recordExecution
  // ---------------------------------------------------------------------------

  describe('recordExecution', () => {
    it('creates metrics for a new skill', () => {
      learner.recordExecution('code-review', { success: true, tokens: 500, latencyMs: 200 })

      const metrics = learner.getMetrics('code-review')
      expect(metrics).toBeDefined()
      expect(metrics!.name).toBe('code-review')
      expect(metrics!.executionCount).toBe(1)
      expect(metrics!.successCount).toBe(1)
      expect(metrics!.failureCount).toBe(0)
      expect(metrics!.avgTokens).toBe(500)
      expect(metrics!.avgLatencyMs).toBe(200)
      expect(metrics!.successRate).toBe(1)
    })

    it('records failed execution', () => {
      learner.recordExecution('buggy-skill', { success: false, tokens: 100, latencyMs: 50 })

      const metrics = learner.getMetrics('buggy-skill')
      expect(metrics!.executionCount).toBe(1)
      expect(metrics!.successCount).toBe(0)
      expect(metrics!.failureCount).toBe(1)
      expect(metrics!.successRate).toBe(0)
    })

    it('updates running averages incrementally', () => {
      learner.recordExecution('skill-a', { success: true, tokens: 100, latencyMs: 100 })
      learner.recordExecution('skill-a', { success: true, tokens: 300, latencyMs: 300 })

      const metrics = learner.getMetrics('skill-a')!
      expect(metrics.executionCount).toBe(2)
      expect(metrics.avgTokens).toBe(200)
      expect(metrics.avgLatencyMs).toBe(200)
      expect(metrics.successRate).toBe(1)
    })

    it('computes correct success rate with mixed results', () => {
      learner.recordExecution('mixed', { success: true, tokens: 100, latencyMs: 50 })
      learner.recordExecution('mixed', { success: false, tokens: 100, latencyMs: 50 })
      learner.recordExecution('mixed', { success: true, tokens: 100, latencyMs: 50 })
      learner.recordExecution('mixed', { success: false, tokens: 100, latencyMs: 50 })

      const metrics = learner.getMetrics('mixed')!
      expect(metrics.successRate).toBe(0.5)
      expect(metrics.successCount).toBe(2)
      expect(metrics.failureCount).toBe(2)
    })

    it('sets lastExecutedAt timestamp', () => {
      const before = Date.now()
      learner.recordExecution('skill-x', { success: true, tokens: 10, latencyMs: 5 })
      const after = Date.now()

      const metrics = learner.getMetrics('skill-x')!
      expect(metrics.lastExecutedAt).toBeGreaterThanOrEqual(before)
      expect(metrics.lastExecutedAt).toBeLessThanOrEqual(after)
    })
  })

  // ---------------------------------------------------------------------------
  // getAllMetrics
  // ---------------------------------------------------------------------------

  describe('getAllMetrics', () => {
    it('returns empty array when no metrics recorded', () => {
      expect(learner.getAllMetrics()).toEqual([])
    })

    it('returns all tracked skills', () => {
      learner.recordExecution('a', { success: true, tokens: 10, latencyMs: 5 })
      learner.recordExecution('b', { success: true, tokens: 20, latencyMs: 10 })
      learner.recordExecution('c', { success: false, tokens: 30, latencyMs: 15 })

      const all = learner.getAllMetrics()
      expect(all).toHaveLength(3)
      const names = all.map((m) => m.name)
      expect(names).toContain('a')
      expect(names).toContain('b')
      expect(names).toContain('c')
    })
  })

  // ---------------------------------------------------------------------------
  // getSkillsNeedingReview
  // ---------------------------------------------------------------------------

  describe('getSkillsNeedingReview', () => {
    it('returns skills below review threshold with enough executions', () => {
      // Default: minExecutionsForOptimization=5, reviewThreshold=0.5
      for (let i = 0; i < 5; i++) {
        learner.recordExecution('bad-skill', { success: false, tokens: 10, latencyMs: 5 })
      }

      const needsReview = learner.getSkillsNeedingReview()
      expect(needsReview).toHaveLength(1)
      expect(needsReview[0]!.name).toBe('bad-skill')
    })

    it('excludes skills with too few executions', () => {
      learner.recordExecution('new-skill', { success: false, tokens: 10, latencyMs: 5 })
      learner.recordExecution('new-skill', { success: false, tokens: 10, latencyMs: 5 })

      expect(learner.getSkillsNeedingReview()).toHaveLength(0)
    })

    it('excludes skills above the review threshold', () => {
      for (let i = 0; i < 5; i++) {
        learner.recordExecution('ok-skill', { success: true, tokens: 10, latencyMs: 5 })
      }

      expect(learner.getSkillsNeedingReview()).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // getOptimizableSkills
  // ---------------------------------------------------------------------------

  describe('getOptimizableSkills', () => {
    it('returns skills at or above optimization threshold with enough data', () => {
      // Default: minExecutionsForOptimization=5, optimizationThreshold=0.8
      for (let i = 0; i < 5; i++) {
        learner.recordExecution('great-skill', { success: true, tokens: 500, latencyMs: 200 })
      }

      const optimizable = learner.getOptimizableSkills()
      expect(optimizable).toHaveLength(1)
      expect(optimizable[0]!.name).toBe('great-skill')
    })

    it('excludes skills below optimization threshold', () => {
      for (let i = 0; i < 3; i++) {
        learner.recordExecution('mediocre', { success: true, tokens: 10, latencyMs: 5 })
      }
      for (let i = 0; i < 3; i++) {
        learner.recordExecution('mediocre', { success: false, tokens: 10, latencyMs: 5 })
      }

      expect(learner.getOptimizableSkills()).toHaveLength(0)
    })

    it('excludes skills with too few executions', () => {
      learner.recordExecution('fresh', { success: true, tokens: 10, latencyMs: 5 })

      expect(learner.getOptimizableSkills()).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Custom config
  // ---------------------------------------------------------------------------

  describe('custom configuration', () => {
    it('respects custom thresholds', () => {
      const custom = new SkillLearner({
        minExecutionsForOptimization: 2,
        reviewThreshold: 0.3,
        optimizationThreshold: 0.9,
      })

      // 2 failures out of 2 = 0% success (below 0.3 review threshold)
      custom.recordExecution('bad', { success: false, tokens: 10, latencyMs: 5 })
      custom.recordExecution('bad', { success: false, tokens: 10, latencyMs: 5 })

      expect(custom.getSkillsNeedingReview()).toHaveLength(1)

      // 2 successes out of 2 = 100% (above 0.9 optimization threshold)
      custom.recordExecution('good', { success: true, tokens: 10, latencyMs: 5 })
      custom.recordExecution('good', { success: true, tokens: 10, latencyMs: 5 })

      expect(custom.getOptimizableSkills()).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // buildOptimizationPrompt
  // ---------------------------------------------------------------------------

  describe('buildOptimizationPrompt', () => {
    it('includes metrics when available', () => {
      for (let i = 0; i < 5; i++) {
        learner.recordExecution('optimized-skill', { success: true, tokens: 400, latencyMs: 150 })
      }

      const prompt = learner.buildOptimizationPrompt('optimized-skill', 'Do thing X')
      expect(prompt).toContain('Executions: 5')
      expect(prompt).toContain('Success rate: 100.0%')
      expect(prompt).toContain('Avg tokens: 400')
      expect(prompt).toContain('Do thing X')
      expect(prompt).toContain('reduce token usage')
    })

    it('includes fallback text when no metrics exist', () => {
      const prompt = learner.buildOptimizationPrompt('unknown-skill', 'Instructions here')
      expect(prompt).toContain('No metrics available')
      expect(prompt).toContain('Instructions here')
    })
  })

  // ---------------------------------------------------------------------------
  // resetMetrics
  // ---------------------------------------------------------------------------

  describe('resetMetrics', () => {
    it('removes metrics for a skill', () => {
      learner.recordExecution('temp', { success: true, tokens: 10, latencyMs: 5 })
      expect(learner.getMetrics('temp')).toBeDefined()

      learner.resetMetrics('temp')
      expect(learner.getMetrics('temp')).toBeUndefined()
    })

    it('does not throw when resetting non-existent skill', () => {
      expect(() => learner.resetMetrics('nonexistent')).not.toThrow()
    })
  })
})
