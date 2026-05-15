import { describe, expect, it } from 'vitest'

import { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'
import type { ExecutionRecord } from '../learning/adapter-learning-loop.js'
import {
  buildPreflightValidator,
  budgetSanityValidator,
  skillToolCoverageValidator,
  skillDegradationValidator,
} from '../guardrails/preflight-validator.js'
import type { AgentInput } from '../types.js'

const baseInput: AgentInput = { prompt: 'do work' }

describe('PreflightValidator (P2)', () => {
  describe('budgetSanityValidator', () => {
    it('passes when no budget is set', async () => {
      const result = await budgetSanityValidator.validate(baseInput, { providerId: 'claude' })
      expect(result.ok).toBe(true)
    })

    it('fails when budget is zero or negative', async () => {
      const result = await budgetSanityValidator.validate(
        { ...baseInput, maxBudgetUsd: 0 },
        { providerId: 'claude' },
      )
      expect(result.ok).toBe(false)
      expect(result.issues[0]!.code).toBe('budget.exhausted')
    })

    it('passes when budget is positive', async () => {
      const result = await budgetSanityValidator.validate(
        { ...baseInput, maxBudgetUsd: 5 },
        { providerId: 'claude' },
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('skillToolCoverageValidator', () => {
    it('warns when skills are declared without required tools', async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, {
        providerId: 'claude',
        skillIds: ['sql-gen'],
        requiredTools: [],
      })
      expect(result.ok).toBe(true)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]!.severity).toBe('warning')
      expect(result.issues[0]!.code).toBe('skill.tools_missing')
    })

    it('passes when skills + tools are aligned', async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, {
        providerId: 'claude',
        skillIds: ['sql-gen'],
        requiredTools: ['execute_sql'],
      })
      expect(result.issues).toHaveLength(0)
    })

    it('passes when no skills are declared', async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, { providerId: 'claude' })
      expect(result.issues).toHaveLength(0)
    })
  })

  describe('skillDegradationValidator', () => {
    it('warns when a requested skill is degraded for the provider', async () => {
      const loop = new AdapterLearningLoop({
        minSampleSize: 1,
        skillHealthThresholds: { minSamples: 3, degradedBelow: 0.5 },
      })
      for (let i = 0; i < 4; i++) {
        loop.record({
          providerId: 'claude',
          taskType: 'general',
          tags: [],
          success: false,
          durationMs: 100,
          inputTokens: 100,
          outputTokens: 50,
          costCents: 1,
          timestamp: Date.now(),
          skillIds: ['degraded-skill'],
        } satisfies ExecutionRecord)
      }

      const validator = skillDegradationValidator(loop)
      const result = await validator.validate(baseInput, {
        providerId: 'claude',
        skillIds: ['degraded-skill'],
      })
      expect(result.ok).toBe(true)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]!.code).toBe('skill.degraded')
    })

    it('passes silently when no degradation is observed', async () => {
      const loop = new AdapterLearningLoop({ minSampleSize: 1 })
      const validator = skillDegradationValidator(loop)
      const result = await validator.validate(baseInput, {
        providerId: 'claude',
        skillIds: ['unknown-skill'],
      })
      expect(result.ok).toBe(true)
      expect(result.issues).toHaveLength(0)
    })
  })

  describe('buildPreflightValidator (composed)', () => {
    it('aggregates issues across all built-in validators', async () => {
      const validator = buildPreflightValidator()
      const result = await validator.validate(
        { ...baseInput, maxBudgetUsd: -1 },
        { providerId: 'claude', skillIds: ['x'], requiredTools: [] },
      )
      // budget error + skill-tools warning
      expect(result.ok).toBe(false)
      expect(result.issues.length).toBeGreaterThanOrEqual(2)
      expect(result.issues.some((i) => i.code === 'budget.exhausted')).toBe(true)
      expect(result.issues.some((i) => i.code === 'skill.tools_missing')).toBe(true)
    })

    it('runs the degradation validator only when a learning loop is supplied', async () => {
      const loop = new AdapterLearningLoop({
        minSampleSize: 1,
        skillHealthThresholds: { minSamples: 1, degradedBelow: 0.99 },
      })
      loop.record({
        providerId: 'claude',
        taskType: 'general',
        tags: [],
        success: false,
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        costCents: 1,
        timestamp: Date.now(),
        skillIds: ['s'],
      })

      const validator = buildPreflightValidator({ learningLoop: loop })
      const result = await validator.validate(baseInput, {
        providerId: 'claude',
        skillIds: ['s'],
        requiredTools: ['t'],
      })
      expect(result.issues.some((i) => i.code === 'skill.degraded')).toBe(true)
    })
  })
})
