import { describe, expect, it } from 'vitest'

import { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'
import type { ExecutionRecord } from '../learning/adapter-learning-loop.js'
import { LearningRouter } from '../registry/learning-router.js'
import type { AdapterProviderId, TaskDescriptor } from '../types.js'

function rec(
  providerId: AdapterProviderId,
  success: boolean,
  skillIds: string[] = [],
  overrides?: Partial<ExecutionRecord>,
): ExecutionRecord {
  return {
    providerId,
    taskType: 'general',
    tags: [],
    success,
    durationMs: 100,
    inputTokens: 100,
    outputTokens: 50,
    costCents: 1,
    timestamp: Date.now(),
    skillIds,
    ...overrides,
  }
}

describe('skill-level health tracking (P1)', () => {
  it('aggregates skill metrics from records that carry skillIds', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 1 })
    for (let i = 0; i < 4; i++) loop.record(rec('claude', true, ['sql-gen']))
    loop.record(rec('claude', false, ['sql-gen']))
    loop.record(rec('claude', false, ['ui-design']))

    const profile = loop.getProfile('claude')
    const sqlMetric = profile.skillMetrics.find((m) => m.skillId === 'sql-gen')
    const uiMetric = profile.skillMetrics.find((m) => m.skillId === 'ui-design')

    expect(sqlMetric).toBeDefined()
    expect(sqlMetric!.invocationCount).toBe(5)
    expect(sqlMetric!.successRate).toBeCloseTo(0.8)
    expect(uiMetric!.invocationCount).toBe(1)
    expect(uiMetric!.successRate).toBe(0)
  })

  it('marks a skill degraded when success rate drops below threshold over enough samples', () => {
    const loop = new AdapterLearningLoop({
      minSampleSize: 1,
      skillHealthThresholds: { minSamples: 5, degradedBelow: 0.5 },
    })
    for (let i = 0; i < 4; i++) loop.record(rec('codex', false, ['risky-skill']))
    loop.record(rec('codex', true, ['risky-skill']))

    const metrics = loop.getSkillHealth('codex', 'risky-skill')
    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.degraded).toBe(true)
    expect(metrics[0]!.successRate).toBeCloseTo(0.2)
  })

  it('does not flag degradation when sample size is below threshold', () => {
    const loop = new AdapterLearningLoop({
      minSampleSize: 1,
      skillHealthThresholds: { minSamples: 10, degradedBelow: 0.5 },
    })
    for (let i = 0; i < 3; i++) loop.record(rec('claude', false, ['fresh-skill']))

    const metrics = loop.getSkillHealth('claude', 'fresh-skill')
    expect(metrics[0]!.degraded).toBe(false)
  })

  it('returns an empty array for a skill that has no recorded executions', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 1 })
    loop.record(rec('claude', true, ['observed']))
    expect(loop.getSkillHealth('claude', 'unobserved')).toEqual([])
  })

  it('LearningRouter biases toward providers with healthier skill history', () => {
    const loop = new AdapterLearningLoop({
      minSampleSize: 1,
      skillHealthThresholds: { minSamples: 3, degradedBelow: 0.5 },
    })
    // claude is great at the requested skill
    for (let i = 0; i < 5; i++) loop.record(rec('claude', true, ['target-skill']))
    // codex is terrible at the requested skill
    for (let i = 0; i < 5; i++) loop.record(rec('codex', false, ['target-skill']))

    const router = new LearningRouter(loop, { minSamples: 1, skillHealthWeight: 0.4 })
    const task: TaskDescriptor = { prompt: 'use target', tags: [], skillIds: ['target-skill'] }
    const decision = router.route(task, ['claude', 'codex'])
    expect(decision.provider).toBe('claude')
  })
})
