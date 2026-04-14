import { describe, it, expect, vi } from 'vitest'

import { LearningRouter } from '../registry/learning-router.js'
import type { LearningRouterConfig } from '../registry/learning-router.js'
import type { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'
import type { ProviderProfile } from '../learning/adapter-learning-loop.js'
import type { AdapterProviderId, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ProviderProfile> & { providerId: AdapterProviderId }): ProviderProfile {
  return {
    totalExecutions: 10,
    successRate: 0.8,
    avgDurationMs: 2000,
    avgCostCents: 5,
    avgQualityScore: 0.7,
    specialties: [],
    weaknesses: [],
    trend: 'stable' as const,
    ...overrides,
  }
}

function makeLearningLoop(profiles: Map<AdapterProviderId, ProviderProfile>): AdapterLearningLoop {
  return {
    getProfile: vi.fn((id: AdapterProviderId) => profiles.get(id) ?? makeProfile({ providerId: id, totalExecutions: 0 })),
  } as unknown as AdapterLearningLoop
}

function makeTask(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    prompt: 'Test task',
    tags: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LearningRouter', () => {
  it('routes to provider with best success rate', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', successRate: 0.9, totalExecutions: 10 })],
      ['codex', makeProfile({ providerId: 'codex', successRate: 0.6, totalExecutions: 10 })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask(), ['claude', 'codex'])

    expect(decision.provider).toBe('claude')
    expect(decision.confidence).toBeGreaterThan(0)
    expect(decision.fallbackProviders).toContain('codex')
  })

  it('applies specialty bonus for matching tags', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', successRate: 0.7, totalExecutions: 10, specialties: ['reasoning'] })],
      ['codex', makeProfile({ providerId: 'codex', successRate: 0.75, totalExecutions: 10, specialties: [] })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask({ tags: ['reasoning'] }), ['claude', 'codex'])

    // Claude has lower base success rate but gets specialty bonus
    expect(decision.provider).toBe('claude')
  })

  it('applies weakness penalty', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', successRate: 0.85, totalExecutions: 10, weaknesses: ['math'] })],
      ['codex', makeProfile({ providerId: 'codex', successRate: 0.8, totalExecutions: 10, weaknesses: [] })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask({ tags: ['math'] }), ['claude', 'codex'])

    // Claude has higher base rate but gets weakness penalty on 'math'
    expect(decision.provider).toBe('codex')
  })

  it('falls back to round-robin with insufficient data', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', totalExecutions: 2 })],
      ['codex', makeProfile({ providerId: 'codex', totalExecutions: 1 })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop, { minSamples: 5 })

    const decision = router.route(makeTask(), ['claude', 'codex'])

    expect(decision.reason).toContain('round-robin')
    expect(decision.confidence).toBe(0.3)
  })

  it('considers trend in scoring', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', successRate: 0.8, totalExecutions: 10, trend: 'degrading' })],
      ['codex', makeProfile({ providerId: 'codex', successRate: 0.8, totalExecutions: 10, trend: 'improving' })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask(), ['claude', 'codex'])

    // Same base scores, but improving trend beats degrading
    expect(decision.provider).toBe('codex')
  })

  it('handles empty providers list', () => {
    const loop = makeLearningLoop(new Map())
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask(), [])

    expect(decision.provider).toBe('auto')
    expect(decision.confidence).toBe(0)
    expect(decision.fallbackProviders).toEqual([])
  })

  it('respects budget constraint', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>([
      ['claude', makeProfile({ providerId: 'claude', successRate: 0.85, totalExecutions: 10, avgCostCents: 50 })],
      ['codex', makeProfile({ providerId: 'codex', successRate: 0.8, totalExecutions: 10, avgCostCents: 2 })],
    ])
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const decision = router.route(makeTask({ budgetConstraint: 'low' }), ['claude', 'codex'])

    // Claude has a higher success rate but the heavy cost penalty under 'low' budget should favour codex
    expect(decision.provider).toBe('codex')
  })

  it('round-robin cycles through providers', () => {
    const profiles = new Map<AdapterProviderId, ProviderProfile>()
    const loop = makeLearningLoop(profiles)
    const router = new LearningRouter(loop)

    const providers: AdapterProviderId[] = ['claude', 'codex', 'gemini']
    const first = router.route(makeTask(), providers)
    const second = router.route(makeTask(), providers)
    const third = router.route(makeTask(), providers)

    const selected = [first.provider, second.provider, third.provider]
    // Should cycle through all three providers
    expect(new Set(selected).size).toBe(3)
  })
})
