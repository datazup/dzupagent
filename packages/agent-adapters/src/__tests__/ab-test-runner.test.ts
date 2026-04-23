import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  ABTestRunner,
  LengthScorer,
  ExactMatchScorer,
  ContainsKeywordsScorer,
} from '../testing/ab-test-runner.js'
import type {
  ABTestCase,
  ABTestPlan,
  ABTestVariant,
  ABTestScorer,
} from '../testing/ab-test-runner.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of events) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function completedEvents(providerId: AdapterProviderId, result: string): AgentEvent[] {
  return [
    {
      type: 'adapter:completed' as const,
      providerId,
      sessionId: 'sess-1',
      result,
      durationMs: 50,
      timestamp: Date.now(),
    },
  ]
}

function failingAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute() {
      throw new Error(`${providerId} failed`)
    },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function makeTestCase(id: string, prompt: string, expectedOutput?: string): ABTestCase {
  return {
    id,
    input: { prompt },
    expectedOutput,
  }
}

function makeVariant(name: string, providerId: AdapterProviderId): ABTestVariant {
  return { name, providerId }
}

// ---------------------------------------------------------------------------
// Scorer tests
// ---------------------------------------------------------------------------

describe('LengthScorer', () => {
  const scorer = new LengthScorer()

  it('returns 0.5 for non-empty result without expected output', async () => {
    const score = await scorer.score('some text', makeTestCase('t1', 'prompt'))
    expect(score).toBe(0.5)
  })

  it('returns 0 for empty result without expected output', async () => {
    const score = await scorer.score('', makeTestCase('t1', 'prompt'))
    expect(score).toBe(0)
  })

  it('returns 1 for exact length match with expected output', async () => {
    const score = await scorer.score('hello', makeTestCase('t1', 'prompt', 'hello'))
    expect(score).toBeCloseTo(1, 5)
  })

  it('returns score between 0 and 1 for different lengths', async () => {
    const score = await scorer.score(
      'short',
      makeTestCase('t1', 'prompt', 'this is a much longer expected output'),
    )
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it('returns 0 when result is empty and expected is empty string (falsy)', async () => {
    // Empty string is falsy, so !testCase.expectedOutput branch returns 0
    const score = await scorer.score('', makeTestCase('t1', 'prompt', ''))
    expect(score).toBe(0)
  })

  it('returns 0.5 when result is non-empty but expected is empty string (falsy)', async () => {
    // Empty string is falsy, so !testCase.expectedOutput branch returns 0.5
    const score = await scorer.score('something', makeTestCase('t1', 'prompt', ''))
    expect(score).toBe(0.5)
  })
})

describe('ExactMatchScorer', () => {
  const scorer = new ExactMatchScorer()

  it('returns 1 for exact match', async () => {
    const score = await scorer.score('hello', makeTestCase('t1', 'prompt', 'hello'))
    expect(score).toBe(1)
  })

  it('returns 0 for non-match', async () => {
    const score = await scorer.score('Hello', makeTestCase('t1', 'prompt', 'hello'))
    expect(score).toBe(0)
  })

  it('returns 0 when no expected output', async () => {
    const score = await scorer.score('hello', makeTestCase('t1', 'prompt'))
    expect(score).toBe(0)
  })
})

describe('ContainsKeywordsScorer', () => {
  const scorer = new ContainsKeywordsScorer()

  it('scores by keyword fraction found', async () => {
    const score = await scorer.score(
      'The quick brown fox',
      makeTestCase('t1', 'prompt', 'quick brown slow'),
    )
    // "quick" and "brown" found, "slow" not found => 2/3
    expect(score).toBeCloseTo(2 / 3, 5)
  })

  it('returns 1 when all keywords found', async () => {
    const score = await scorer.score(
      'hello world',
      makeTestCase('t1', 'prompt', 'hello world'),
    )
    expect(score).toBe(1)
  })

  it('returns 0 when no keywords found', async () => {
    const score = await scorer.score(
      'xyz',
      makeTestCase('t1', 'prompt', 'hello world'),
    )
    expect(score).toBe(0)
  })

  it('returns 0 when no expected output', async () => {
    const score = await scorer.score('hello', makeTestCase('t1', 'prompt'))
    expect(score).toBe(0)
  })

  it('is case-insensitive', async () => {
    const score = await scorer.score(
      'HELLO WORLD',
      makeTestCase('t1', 'prompt', 'hello world'),
    )
    expect(score).toBe(1)
  })

  it('returns 0 for empty expected output', async () => {
    const score = await scorer.score('hello', makeTestCase('t1', 'prompt', ''))
    expect(score).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ABTestRunner tests
// ---------------------------------------------------------------------------

describe('ABTestRunner', () => {
  let bus: DzupEventBus
  let registry: ProviderAdapterRegistry

  beforeEach(() => {
    bus = createEventBus()
    registry = new ProviderAdapterRegistry()
  })

  describe('runSingle', () => {
    it('returns scored result', async () => {
      const adapter = createMockAdapter('claude', completedEvents('claude', 'hello world'))
      registry.register(adapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })
      const result = await runner.runSingle(
        makeTestCase('t1', 'prompt', 'hello world'),
        makeVariant('control', 'claude'),
        [new ExactMatchScorer()],
      )

      expect(result.success).toBe(true)
      expect(result.result).toBe('hello world')
      expect(result.scores['exact-match']).toBe(1)
      expect(result.variantName).toBe('control')
      expect(result.providerId).toBe('claude')
    })

    it('handles missing adapter', async () => {
      const runner = new ABTestRunner({ registry, eventBus: bus })
      const result = await runner.runSingle(
        makeTestCase('t1', 'prompt'),
        makeVariant('control', 'claude'),
        [new LengthScorer()],
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('not registered')
    })

    it('handles adapter failure', async () => {
      registry.register(failingAdapter('claude'))

      const runner = new ABTestRunner({ registry, eventBus: bus })
      const result = await runner.runSingle(
        makeTestCase('t1', 'prompt'),
        makeVariant('control', 'claude'),
        [new LengthScorer()],
      )

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.scores['length']).toBe(0)
    })
  })

  describe('run', () => {
    it('compares variants and produces report', async () => {
      const claudeAdapter = createMockAdapter(
        'claude',
        completedEvents('claude', 'Claude response here'),
      )
      const codexAdapter = createMockAdapter(
        'codex',
        completedEvents('codex', 'Codex response'),
      )
      registry.register(claudeAdapter)
      registry.register(codexAdapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'test-plan',
        variants: [
          makeVariant('control', 'claude'),
          makeVariant('treatment', 'codex'),
        ],
        testCases: [
          makeTestCase('t1', 'prompt', 'Claude response here'),
        ],
        scorers: [new ExactMatchScorer(), new LengthScorer()],
        maxConcurrency: 2,
      }

      const report = await runner.run(plan)

      expect(report.planName).toBe('test-plan')
      expect(report.variants).toHaveLength(2)
      expect(report.rawResults).toHaveLength(2) // 2 variants x 1 test case
      expect(report.comparison.length).toBeGreaterThan(0)
      expect(report.startedAt).toBeInstanceOf(Date)
      expect(report.completedAt).toBeInstanceOf(Date)
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('includes comparison with p-values', async () => {
      // Need at least 2 samples per variant for t-test, use repetitions
      const claudeAdapter = createMockAdapter(
        'claude',
        completedEvents('claude', 'hello'),
      )
      const codexAdapter = createMockAdapter(
        'codex',
        completedEvents('codex', 'hello'),
      )
      registry.register(claudeAdapter)
      registry.register(codexAdapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'stat-test',
        variants: [
          makeVariant('A', 'claude'),
          makeVariant('B', 'codex'),
        ],
        testCases: [
          makeTestCase('t1', 'prompt', 'hello'),
          makeTestCase('t2', 'prompt2', 'hello'),
          makeTestCase('t3', 'prompt3', 'hello'),
        ],
        scorers: [new ExactMatchScorer()],
        maxConcurrency: 4,
      }

      const report = await runner.run(plan)

      expect(report.comparison).toHaveLength(1) // 1 pair x 1 scorer
      const comp = report.comparison[0]!
      expect(comp.variantA).toBe('A')
      expect(comp.variantB).toBe('B')
      expect(comp.scorerName).toBe('exact-match')
      expect(typeof comp.pValue).toBe('number')
      expect(typeof comp.meanDiff).toBe('number')
      expect(typeof comp.significant).toBe('boolean')
    })

    it('determines winner correctly', async () => {
      // Claude returns exact match, codex returns wrong answer
      const claudeAdapter = createMockAdapter(
        'claude',
        completedEvents('claude', 'correct'),
      )
      const codexAdapter = createMockAdapter(
        'codex',
        completedEvents('codex', 'wrong'),
      )
      registry.register(claudeAdapter)
      registry.register(codexAdapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'winner-test',
        variants: [
          makeVariant('claude-variant', 'claude'),
          makeVariant('codex-variant', 'codex'),
        ],
        testCases: [
          makeTestCase('t1', 'prompt', 'correct'),
        ],
        scorers: [new ExactMatchScorer()],
      }

      const report = await runner.run(plan)

      expect(report.winner).toBeDefined()
      expect(report.winner!.variantName).toBe('claude-variant')
      expect(report.winner!.avgScores['exact-match']).toBe(1)
    })

    it('handles provider failures', async () => {
      registry.register(failingAdapter('claude'))
      const codexAdapter = createMockAdapter(
        'codex',
        completedEvents('codex', 'works'),
      )
      registry.register(codexAdapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'failure-test',
        variants: [
          makeVariant('failing', 'claude'),
          makeVariant('working', 'codex'),
        ],
        testCases: [makeTestCase('t1', 'prompt')],
        scorers: [new LengthScorer()],
      }

      const report = await runner.run(plan)

      const failingResult = report.rawResults.find((r) => r.variantName === 'failing')
      const workingResult = report.rawResults.find((r) => r.variantName === 'working')
      expect(failingResult!.success).toBe(false)
      expect(workingResult!.success).toBe(true)
    })

    it('respects maxConcurrency', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const slowAdapter: AgentCLIAdapter = {
        providerId: 'claude',
        async *execute() {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise((r) => setTimeout(r, 20))
          yield {
            type: 'adapter:completed' as const,
            providerId: 'claude' as AdapterProviderId,
            sessionId: 's',
            result: 'done',
            durationMs: 20,
            timestamp: Date.now(),
          }
          concurrent--
        },
        async *resumeSession() { /* noop */ },
        interrupt() {},
        async healthCheck() {
          return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
        },
        configure() {},
      }

      registry.register(slowAdapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'concurrency-test',
        variants: [makeVariant('v1', 'claude')],
        testCases: [
          makeTestCase('t1', 'p1'),
          makeTestCase('t2', 'p2'),
          makeTestCase('t3', 'p3'),
          makeTestCase('t4', 'p4'),
        ],
        scorers: [new LengthScorer()],
        maxConcurrency: 2,
      }

      await runner.run(plan)
      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })

    it.each([
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['NaN', Number.NaN],
      ['zero', 0],
      ['negative', -1],
      ['non-integer', 1.5],
    ])('rejects %s as maxConcurrency', async (_, maxConcurrency) => {
      const adapter = createMockAdapter(
        'claude',
        completedEvents('claude', 'hello'),
      )
      registry.register(adapter)

      const runner = new ABTestRunner({ registry, eventBus: bus })

      const plan: ABTestPlan = {
        name: 'invalid-concurrency',
        variants: [makeVariant('control', 'claude')],
        testCases: [makeTestCase('t1', 'prompt')],
        scorers: [new LengthScorer()],
        maxConcurrency,
      }

      await expect(runner.run(plan)).rejects.toThrow(
        `ABTestRunner maxConcurrency must be a finite positive integer; received ${String(maxConcurrency)}`,
      )
    })
  })
})
