import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

import {
  AdapterLearningLoop,
  ExecutionAnalyzer,
} from '../learning/adapter-learning-loop.js'
import type { ExecutionRecord } from '../learning/adapter-learning-loop.js'
import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  providerId: AdapterProviderId,
  taskType: string,
  success: boolean,
  overrides?: Partial<ExecutionRecord>,
): ExecutionRecord {
  return {
    providerId,
    taskType,
    tags: [],
    success,
    durationMs: 100,
    inputTokens: 500,
    outputTokens: 200,
    costCents: 1,
    timestamp: Date.now(),
    ...overrides,
  }
}

/** Add N records for a provider/taskType combination. */
function addRecords(
  loop: AdapterLearningLoop,
  providerId: AdapterProviderId,
  taskType: string,
  count: number,
  successRate: number,
  overrides?: Partial<ExecutionRecord>,
): void {
  for (let i = 0; i < count; i++) {
    const success = i < Math.floor(count * successRate)
    loop.record(makeRecord(providerId, taskType, success, {
      timestamp: Date.now() - (count - i) * 1000,
      ...overrides,
    }))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterLearningLoop', () => {
  let loop: AdapterLearningLoop
  let bus: DzipEventBus

  beforeEach(() => {
    bus = createEventBus()
    loop = new AdapterLearningLoop({ eventBus: bus, minSampleSize: 5 })
  })

  describe('record', () => {
    it('stores execution records', () => {
      loop.record(makeRecord('claude', 'code-gen', true))
      loop.record(makeRecord('claude', 'code-gen', false))

      const profile = loop.getProfile('claude')
      expect(profile.totalExecutions).toBe(2)
    })
  })

  describe('getProfile', () => {
    it('computes stats correctly', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.8)

      const profile = loop.getProfile('claude')

      expect(profile.providerId).toBe('claude')
      expect(profile.totalExecutions).toBe(10)
      expect(profile.successRate).toBe(0.8)
      expect(profile.avgDurationMs).toBe(100)
      expect(profile.avgCostCents).toBe(1)
    })

    it('returns empty profile for unknown provider', () => {
      const profile = loop.getProfile('qwen')

      expect(profile.totalExecutions).toBe(0)
      expect(profile.successRate).toBe(0)
      expect(profile.specialties).toEqual([])
      expect(profile.weaknesses).toEqual([])
      expect(profile.trend).toBe('stable')
    })
  })

  describe('specialties', () => {
    it('detects specialties with >0.8 success rate and >5 samples', () => {
      // 90% success rate, 10 samples
      addRecords(loop, 'claude', 'code-gen', 10, 0.9)
      // Only 3 samples -- not enough
      addRecords(loop, 'claude', 'testing', 3, 1.0)

      const profile = loop.getProfile('claude')

      expect(profile.specialties).toContain('code-gen')
      expect(profile.specialties).not.toContain('testing') // too few samples
    })
  })

  describe('weaknesses', () => {
    it('detects weaknesses with <0.5 success rate and >5 samples', () => {
      addRecords(loop, 'codex', 'refactor', 10, 0.3)
      addRecords(loop, 'codex', 'code-gen', 10, 0.9)

      const profile = loop.getProfile('codex')

      expect(profile.weaknesses).toContain('refactor')
      expect(profile.weaknesses).not.toContain('code-gen')
    })
  })

  describe('trend detection', () => {
    it('detects improving trend', () => {
      const improveLoop = new AdapterLearningLoop({ minSampleSize: 5 })

      // First 80%: low success rate
      for (let i = 0; i < 8; i++) {
        improveLoop.record(makeRecord('claude', 'gen', false, {
          timestamp: 1000 + i,
        }))
      }
      // Last 20%: high success rate
      for (let i = 0; i < 2; i++) {
        improveLoop.record(makeRecord('claude', 'gen', true, {
          timestamp: 2000 + i,
        }))
      }

      const profile = improveLoop.getProfile('claude')
      expect(profile.trend).toBe('improving')
    })

    it('detects degrading trend', () => {
      const degradeLoop = new AdapterLearningLoop({ minSampleSize: 5 })

      // First 80%: high success rate
      for (let i = 0; i < 8; i++) {
        degradeLoop.record(makeRecord('claude', 'gen', true, {
          timestamp: 1000 + i,
        }))
      }
      // Last 20%: low success rate
      for (let i = 0; i < 2; i++) {
        degradeLoop.record(makeRecord('claude', 'gen', false, {
          timestamp: 2000 + i,
        }))
      }

      const profile = degradeLoop.getProfile('claude')
      expect(profile.trend).toBe('degrading')
    })

    it('detects stable trend', () => {
      // Interleave successes and failures evenly so early and recent rates match
      const stableLoop = new AdapterLearningLoop({ minSampleSize: 5 })
      for (let i = 0; i < 10; i++) {
        stableLoop.record(makeRecord('claude', 'gen', i % 2 === 0, {
          timestamp: 1000 + i,
        }))
      }

      const profile = stableLoop.getProfile('claude')
      expect(profile.trend).toBe('stable')
    })
  })

  describe('getBestProvider', () => {
    it('returns provider with highest success rate for task type', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.9)
      addRecords(loop, 'codex', 'code-gen', 10, 0.7)

      const best = loop.getBestProvider('code-gen', ['claude', 'codex'])
      expect(best).toBe('claude')
    })

    it('returns undefined when no provider has enough samples', () => {
      addRecords(loop, 'claude', 'code-gen', 2, 1.0) // only 2 samples, minSampleSize = 5

      const best = loop.getBestProvider('code-gen', ['claude'])
      expect(best).toBeUndefined()
    })

    it('returns undefined for unknown task type', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.9)

      const best = loop.getBestProvider('unknown-type', ['claude'])
      expect(best).toBeUndefined()
    })

    it('breaks ties by duration then cost', () => {
      addRecords(loop, 'claude', 'gen', 10, 0.8, { durationMs: 200, costCents: 5 })
      addRecords(loop, 'codex', 'gen', 10, 0.8, { durationMs: 100, costCents: 3 })

      const best = loop.getBestProvider('gen', ['claude', 'codex'])
      expect(best).toBe('codex') // same success rate but faster
    })
  })

  describe('detectFailurePatterns', () => {
    it('groups errors and returns patterns with frequency >= 3', () => {
      const now = Date.now()

      for (let i = 0; i < 5; i++) {
        loop.record(makeRecord('claude', 'gen', false, {
          errorType: 'rate_limit',
          timestamp: now - i * 100,
        }))
      }
      // Only 2 of this error type -- should not appear
      for (let i = 0; i < 2; i++) {
        loop.record(makeRecord('claude', 'gen', false, {
          errorType: 'timeout',
          timestamp: now - i * 100,
        }))
      }

      const patterns = loop.detectFailurePatterns('claude')

      expect(patterns).toHaveLength(1)
      expect(patterns[0]!.errorType).toBe('rate_limit')
      expect(patterns[0]!.frequency).toBe(5)
      expect(patterns[0]!.suggestedAction.action).toBe('switch-provider')
    })

    it('returns empty for unknown provider', () => {
      const patterns = loop.detectFailurePatterns('qwen')
      expect(patterns).toEqual([])
    })
  })

  describe('suggestRecovery', () => {
    it('returns switch-provider for rate_limit', () => {
      loop.record(makeRecord('claude', 'gen', false, { errorType: 'rate_limit' }))

      const suggestion = loop.suggestRecovery('claude', 'rate_limit')

      expect(suggestion).toBeDefined()
      expect(suggestion!.action).toBe('switch-provider')
    })

    it('returns increase-budget for timeout', () => {
      loop.record(makeRecord('claude', 'gen', false, { errorType: 'timeout' }))

      const suggestion = loop.suggestRecovery('claude', 'timeout')

      expect(suggestion).toBeDefined()
      expect(suggestion!.action).toBe('increase-budget')
    })

    it('returns switch-provider for context_too_long', () => {
      loop.record(makeRecord('claude', 'gen', false, { errorType: 'context_too_long' }))

      const suggestion = loop.suggestRecovery('claude', 'context_too_long')

      expect(suggestion).toBeDefined()
      expect(suggestion!.action).toBe('switch-provider')
      if (suggestion!.action === 'switch-provider') {
        expect(suggestion!.targetProvider).toBe('gemini')
      }
    })

    it('returns retry for unknown error type', () => {
      loop.record(makeRecord('claude', 'gen', false, { errorType: 'weird_error' }))

      const suggestion = loop.suggestRecovery('claude', 'weird_error')

      expect(suggestion).toBeDefined()
      expect(suggestion!.action).toBe('retry')
    })

    it('returns undefined for provider without matching error', () => {
      const suggestion = loop.suggestRecovery('claude', 'nonexistent')
      expect(suggestion).toBeUndefined()
    })
  })

  describe('exportData / importData', () => {
    it('round-trips data correctly', () => {
      addRecords(loop, 'claude', 'code-gen', 5, 0.8)
      addRecords(loop, 'codex', 'testing', 3, 1.0)

      const exported = loop.exportData()

      const newLoop = new AdapterLearningLoop({ minSampleSize: 5 })
      newLoop.importData(exported)

      const claudeProfile = newLoop.getProfile('claude')
      expect(claudeProfile.totalExecutions).toBe(5)

      const codexProfile = newLoop.getProfile('codex')
      expect(codexProfile.totalExecutions).toBe(3)
    })
  })

  describe('reset', () => {
    it('clears all data', () => {
      addRecords(loop, 'claude', 'gen', 10, 0.9)

      loop.reset()

      const profile = loop.getProfile('claude')
      expect(profile.totalExecutions).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// ExecutionAnalyzer tests
// ---------------------------------------------------------------------------

describe('ExecutionAnalyzer', () => {
  let loop: AdapterLearningLoop
  let analyzer: ExecutionAnalyzer

  beforeEach(() => {
    loop = new AdapterLearningLoop({ minSampleSize: 5 })
    analyzer = new ExecutionAnalyzer(loop)
  })

  describe('generateReport', () => {
    it('produces a comprehensive report', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.9)
      addRecords(loop, 'codex', 'testing', 10, 0.6)

      const report = analyzer.generateReport()

      expect(report.totalExecutions).toBe(20)
      expect(report.overallSuccessRate).toBeGreaterThan(0)
      expect(report.avgCostPerExecution).toBeGreaterThan(0)
      expect(report.providers).toHaveLength(2)
      expect(report.generatedAt).toBeInstanceOf(Date)
    })

    it('handles empty data', () => {
      const report = analyzer.generateReport()

      expect(report.totalExecutions).toBe(0)
      expect(report.overallSuccessRate).toBe(0)
      expect(report.providers).toHaveLength(0)
    })
  })

  describe('compareProviders', () => {
    it('compares two providers overall', () => {
      addRecords(loop, 'claude', 'gen', 10, 0.9, { durationMs: 200, costCents: 5 })
      addRecords(loop, 'codex', 'gen', 10, 0.7, { durationMs: 100, costCents: 2 })

      const comparison = analyzer.compareProviders('claude', 'codex')

      expect(comparison.winner).toBe('claude') // Higher success rate
      expect(comparison.reason).toContain('success rate')
    })

    it('compares for specific task type', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.5)
      addRecords(loop, 'claude', 'testing', 10, 0.9)
      addRecords(loop, 'codex', 'code-gen', 10, 0.8)
      addRecords(loop, 'codex', 'testing', 10, 0.4)

      const comparison = analyzer.compareProviders('claude', 'codex', 'code-gen')

      expect(comparison.winner).toBe('codex') // Better at code-gen specifically
    })

    it('returns tie when providers are equal', () => {
      addRecords(loop, 'claude', 'gen', 10, 0.8, { durationMs: 100, costCents: 1 })
      addRecords(loop, 'codex', 'gen', 10, 0.8, { durationMs: 100, costCents: 1 })

      const comparison = analyzer.compareProviders('claude', 'codex')

      expect(comparison.winner).toBe('tie')
    })
  })

  describe('getOptimalAllocation', () => {
    it('maps task types to best providers', () => {
      addRecords(loop, 'claude', 'code-gen', 10, 0.9)
      addRecords(loop, 'claude', 'testing', 10, 0.5)
      addRecords(loop, 'codex', 'code-gen', 10, 0.7)
      addRecords(loop, 'codex', 'testing', 10, 0.9)

      const allocation = analyzer.getOptimalAllocation()

      expect(allocation.get('code-gen')).toBe('claude')
      expect(allocation.get('testing')).toBe('codex')
    })

    it('returns empty map with no data', () => {
      const allocation = analyzer.getOptimalAllocation()
      expect(allocation.size).toBe(0)
    })
  })
})
