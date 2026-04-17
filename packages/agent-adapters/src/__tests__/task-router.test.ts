import { describe, it, expect } from 'vitest'

import {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from '../registry/task-router.js'
import type {
  AdapterProviderId,
  TaskDescriptor,
  TaskRoutingStrategy,
  RoutingDecision,
} from '../types.js'

function makeTask(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    prompt: 'hello',
    tags: [],
    ...overrides,
  }
}

describe('TagBasedRouter', () => {
  const router = new TagBasedRouter()

  it('has expected name', () => {
    expect(router.name).toBe('tag-based')
  })

  it('respects preferredProvider when available', () => {
    const decision = router.route(
      makeTask({ preferredProvider: 'codex' }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('codex')
    expect(decision.reason).toContain('Preferred provider')
    expect(decision.fallbackProviders).toEqual(['claude'])
    expect(decision.confidence).toBe(0.95)
  })

  it('ignores preferredProvider when not in available list', () => {
    const decision = router.route(
      makeTask({ preferredProvider: 'codex' }),
      ['claude'],
    )
    // Falls through to default decision
    expect(decision.provider).toBe('claude')
  })

  it('routes reasoning tags to claude when available', () => {
    const decision = router.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('deep reasoning')
    expect(decision.confidence).toBe(0.85)
    expect(decision.fallbackProviders).toEqual(['codex'])
  })

  it('routes architecture tags to claude', () => {
    const decision = router.route(
      makeTask({ tags: ['architecture'] }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('routes review tags to claude', () => {
    const decision = router.route(
      makeTask({ tags: ['review'] }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('routes design/analysis/planning/refactor/explain tags to claude', () => {
    for (const tag of ['design', 'analysis', 'planning', 'refactor', 'explain']) {
      const decision = router.route(makeTask({ tags: [tag] }), ['claude', 'codex'])
      expect(decision.provider).toBe('claude')
    }
  })

  it('respects requiresReasoning flag even without reasoning tag', () => {
    const decision = router.route(
      makeTask({ requiresReasoning: true }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('reasoning')
  })

  it('falls through to default when reasoning is requested but claude is unavailable', () => {
    const decision = router.route(
      makeTask({ tags: ['reasoning'] }),
      ['codex', 'gemini'],
    )
    // claude not available, so fallback
    expect(decision.provider).toBe('codex')
  })

  it('routes execution tags to codex when available', () => {
    const decision = router.route(
      makeTask({ tags: ['fix-tests'] }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('codex')
    expect(decision.reason).toContain('execution-focused')
    expect(decision.confidence).toBe(0.8)
  })

  it('routes implement/execute/code/build/debug/test/migrate tags to codex', () => {
    for (const tag of ['implement', 'execute', 'code', 'build', 'debug', 'test', 'migrate']) {
      const decision = router.route(makeTask({ tags: [tag] }), ['claude', 'codex'])
      expect(decision.provider).toBe('codex')
    }
  })

  it('respects requiresExecution flag even without execution tag', () => {
    const decision = router.route(
      makeTask({ requiresExecution: true }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('codex')
  })

  it('falls through to default when execution is requested but codex is unavailable', () => {
    const decision = router.route(
      makeTask({ tags: ['implement'] }),
      ['claude', 'gemini'],
    )
    // codex not available
    expect(decision.provider).toBe('claude')
  })

  it('routes local tags to crush when available', () => {
    const decision = router.route(
      makeTask({ tags: ['local'] }),
      ['claude', 'crush', 'qwen'],
    )
    expect(decision.provider).toBe('crush')
    expect(decision.reason).toContain('local')
    expect(decision.confidence).toBe(0.75)
  })

  it('routes local tags to qwen when crush unavailable', () => {
    const decision = router.route(
      makeTask({ tags: ['offline'] }),
      ['claude', 'qwen'],
    )
    expect(decision.provider).toBe('qwen')
  })

  it('routes private/fast/simple/quick tags to local adapter', () => {
    for (const tag of ['private', 'fast', 'simple', 'quick']) {
      const decision = router.route(makeTask({ tags: [tag] }), ['qwen', 'claude'])
      expect(decision.provider).toBe('qwen')
    }
  })

  it('falls through when local is requested but neither crush nor qwen available', () => {
    const decision = router.route(
      makeTask({ tags: ['offline'] }),
      ['claude', 'codex'],
    )
    // Falls through
    expect(decision.provider).toBe('claude')
  })

  it('routes low budget to cheapest available', () => {
    const decision = router.route(
      makeTask({ budgetConstraint: 'low' }),
      ['claude', 'crush', 'gemini'],
    )
    // crush is cheapest (rank 1)
    expect(decision.provider).toBe('crush')
    expect(decision.reason).toContain('cheapest')
    expect(decision.confidence).toBe(0.7)
  })

  it('does not use cheapest path for medium/high/unlimited budget', () => {
    const decision = router.route(
      makeTask({ budgetConstraint: 'high' }),
      ['claude', 'crush'],
    )
    // Default priority routing picks claude over crush
    expect(decision.provider).toBe('claude')
  })

  it('uses default highest-priority routing when nothing else matches', () => {
    const decision = router.route(
      makeTask(),
      ['gemini', 'claude', 'crush'],
    )
    // claude has highest priority (5)
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('Default routing')
    expect(decision.confidence).toBe(0.5)
  })

  it('returns auto decision when no adapters available', () => {
    const decision = router.route(makeTask(), [])
    expect(decision.provider).toBe('auto')
    expect(decision.reason).toBe('No adapters available')
    expect(decision.fallbackProviders).toEqual([])
    expect(decision.confidence).toBe(0)
  })

  it('handles mixed-case tags via case-insensitive matching', () => {
    const decision = router.route(
      makeTask({ tags: ['REASONING'] }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('low budget with empty available list yields auto', () => {
    const decision = router.route(
      makeTask({ budgetConstraint: 'low' }),
      [],
    )
    expect(decision.provider).toBe('auto')
  })

  it('builds fallback list excluding primary', () => {
    const decision = router.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude', 'codex', 'gemini', 'qwen'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.fallbackProviders).toEqual(['codex', 'gemini', 'qwen'])
  })
})

describe('CostOptimizedRouter', () => {
  it('has expected name', () => {
    expect(new CostOptimizedRouter().name).toBe('cost-optimized')
  })

  it('routes to cheapest provider', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(makeTask(), ['claude', 'crush', 'codex'])
    expect(decision.provider).toBe('crush')
    expect(decision.confidence).toBe(0.8)
    expect(decision.reason).toContain('cheapest')
  })

  it('respects preferredProvider override', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(
      makeTask({ preferredProvider: 'claude' }),
      ['claude', 'crush'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('overrides cost')
    expect(decision.confidence).toBe(0.9)
    expect(decision.fallbackProviders).toEqual(['crush'])
  })

  it('ignores preferredProvider when unavailable', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(
      makeTask({ preferredProvider: 'codex' }),
      ['claude', 'crush'],
    )
    expect(decision.provider).toBe('crush')
  })

  it('accepts custom cost rankings via constructor', () => {
    const router = new CostOptimizedRouter({ claude: 0 })
    const decision = router.route(makeTask(), ['claude', 'crush'])
    // With override, claude now cheaper than crush
    expect(decision.provider).toBe('claude')
  })

  it('returns auto when no providers available', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(makeTask(), [])
    expect(decision.provider).toBe('auto')
    expect(decision.reason).toContain('No adapters')
    expect(decision.confidence).toBe(0)
  })

  it('sorts fallbacks by cost', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(makeTask(), ['claude', 'crush', 'codex'])
    // Sorted: crush (1), codex (5), claude (6)
    expect(decision.fallbackProviders).toEqual(['codex', 'claude'])
  })
})

describe('RoundRobinRouter', () => {
  it('has expected name', () => {
    expect(new RoundRobinRouter().name).toBe('round-robin')
  })

  it('distributes evenly across providers', () => {
    const router = new RoundRobinRouter()
    const providers: AdapterProviderId[] = ['claude', 'codex', 'gemini']
    const selections: (AdapterProviderId | 'auto')[] = []
    for (let i = 0; i < 6; i++) {
      selections.push(router.route(makeTask(), providers).provider)
    }
    expect(selections).toEqual([
      'claude', 'codex', 'gemini',
      'claude', 'codex', 'gemini',
    ])
  })

  it('respects preferredProvider override', () => {
    const router = new RoundRobinRouter()
    const decision = router.route(
      makeTask({ preferredProvider: 'claude' }),
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('overrides round-robin')
    expect(decision.confidence).toBe(0.9)
  })

  it('ignores preferredProvider when unavailable', () => {
    const router = new RoundRobinRouter()
    const decision = router.route(
      makeTask({ preferredProvider: 'codex' }),
      ['claude'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('returns auto when no providers available', () => {
    const router = new RoundRobinRouter()
    const decision = router.route(makeTask(), [])
    expect(decision.provider).toBe('auto')
    expect(decision.reason).toContain('No adapters')
    expect(decision.confidence).toBe(0)
  })

  it('reset() restores the counter', () => {
    const router = new RoundRobinRouter()
    router.route(makeTask(), ['a' as AdapterProviderId, 'b' as AdapterProviderId])
    router.route(makeTask(), ['a' as AdapterProviderId, 'b' as AdapterProviderId])
    router.reset()
    const decision = router.route(makeTask(), ['claude', 'codex'])
    expect(decision.provider).toBe('claude')
  })

  it('increments counter in reason string', () => {
    const router = new RoundRobinRouter()
    const d1 = router.route(makeTask(), ['claude'])
    expect(d1.reason).toContain('iteration 1')
    const d2 = router.route(makeTask(), ['claude'])
    expect(d2.reason).toContain('iteration 2')
  })

  it('builds fallbacks excluding selected', () => {
    const router = new RoundRobinRouter()
    const decision = router.route(makeTask(), ['claude', 'codex', 'gemini'])
    expect(decision.fallbackProviders).toHaveLength(2)
    expect(decision.fallbackProviders).not.toContain(decision.provider)
  })
})

describe('CompositeRouter', () => {
  it('has expected name', () => {
    const tagRouter = new TagBasedRouter()
    const cost = new CostOptimizedRouter()
    const composite = new CompositeRouter([
      { strategy: tagRouter, weight: 0.5 },
      { strategy: cost, weight: 0.5 },
    ])
    expect(composite.name).toBe('composite')
  })

  it('throws when no strategies provided', () => {
    expect(() => new CompositeRouter([])).toThrow('at least one strategy')
  })

  it('returns auto when no providers available', () => {
    const composite = new CompositeRouter([
      { strategy: new TagBasedRouter(), weight: 1 },
    ])
    const decision = composite.route(makeTask(), [])
    expect(decision.provider).toBe('auto')
    expect(decision.reason).toContain('No adapters')
    expect(decision.confidence).toBe(0)
  })

  it('picks highest weighted score across strategies', () => {
    const tagRouter = new TagBasedRouter()
    const costRouter = new CostOptimizedRouter()
    const composite = new CompositeRouter([
      { strategy: tagRouter, weight: 1 },
      { strategy: costRouter, weight: 0.1 },
    ])
    // Tag-based with reasoning → claude (0.85 * 1 = 0.85)
    // Cost → crush (0.8 * 0.1 = 0.08)
    const decision = composite.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude', 'crush'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('Composite routing')
    expect(decision.reason).toContain('tag-based')
    expect(decision.reason).toContain('cost-optimized')
  })

  it('normalizes confidence to [0, 1]', () => {
    const tagRouter = new TagBasedRouter()
    const composite = new CompositeRouter([
      { strategy: tagRouter, weight: 1 },
    ])
    const decision = composite.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude'],
    )
    expect(decision.confidence).toBeGreaterThan(0)
    expect(decision.confidence).toBeLessThanOrEqual(1)
  })

  it('handles zero total weight without NaN', () => {
    const noopStrategy: TaskRoutingStrategy = {
      name: 'noop',
      route: (): RoutingDecision => ({
        provider: 'claude',
        reason: 'noop',
        fallbackProviders: [],
        confidence: 0,
      }),
    }
    const composite = new CompositeRouter([
      { strategy: noopStrategy, weight: 0 },
    ])
    const decision = composite.route(makeTask(), ['claude'])
    expect(decision.confidence).toBe(0)
  })

  it('returns auto with all providers as fallback when best is auto', () => {
    const emptyStrategy: TaskRoutingStrategy = {
      name: 'auto-only',
      route: (): RoutingDecision => ({
        provider: 'auto',
        reason: 'always auto',
        fallbackProviders: [],
        confidence: 1,
      }),
    }
    const composite = new CompositeRouter([
      { strategy: emptyStrategy, weight: 1 },
    ])
    const decision = composite.route(makeTask(), ['claude', 'codex'])
    expect(decision.provider).toBe('auto')
    // When best is auto, fallbacks are all providers
    expect(decision.fallbackProviders).toEqual(['claude', 'codex'])
  })

  it('includes percentage for each strategy in reason', () => {
    const tagRouter = new TagBasedRouter()
    const composite = new CompositeRouter([
      { strategy: tagRouter, weight: 1 },
    ])
    const decision = composite.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude'],
    )
    // e.g. "tag-based: claude (85%)"
    expect(decision.reason).toMatch(/\d+%/)
  })

  it('builds fallbacks excluding the chosen provider', () => {
    const tagRouter = new TagBasedRouter()
    const composite = new CompositeRouter([
      { strategy: tagRouter, weight: 1 },
    ])
    const decision = composite.route(
      makeTask({ tags: ['reasoning'] }),
      ['claude', 'codex', 'gemini'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.fallbackProviders).not.toContain('claude')
  })

  it('aggregates votes for the same provider across strategies', () => {
    const s1: TaskRoutingStrategy = {
      name: 's1',
      route: (): RoutingDecision => ({
        provider: 'claude',
        reason: 'r1',
        fallbackProviders: [],
        confidence: 0.5,
      }),
    }
    const s2: TaskRoutingStrategy = {
      name: 's2',
      route: (): RoutingDecision => ({
        provider: 'claude',
        reason: 'r2',
        fallbackProviders: [],
        confidence: 0.5,
      }),
    }
    const composite = new CompositeRouter([
      { strategy: s1, weight: 0.5 },
      { strategy: s2, weight: 0.5 },
    ])
    const decision = composite.route(makeTask(), ['claude', 'codex'])
    expect(decision.provider).toBe('claude')
    // Confidence: (0.5*0.5 + 0.5*0.5) / (0.5+0.5) = 0.5
    expect(decision.confidence).toBe(0.5)
  })
})
