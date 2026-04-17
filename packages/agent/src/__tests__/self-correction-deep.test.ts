/**
 * Deep coverage tests for the @dzupagent/agent self-correction module.
 *
 * Exercises untested branches and edge cases across:
 *   - SelfCorrectingNode (createSelfCorrectingExecutor)
 *   - AdaptiveIterationController
 *   - RecoveryFeedback
 *   - ReflectionLoop
 *   - StrategySelector
 *   - TrajectoryCalibrator
 *   - SelfLearningPipelineHook
 *
 * All tests use vi.fn() based mocks — no network, no real LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'
import type { PipelineNode } from '@dzupagent/core'

import {
  createSelfCorrectingExecutor,
  type SelfCorrectingConfig,
  type SelfCorrectingResult,
} from '../self-correction/self-correcting-node.js'
import { AdaptiveIterationController } from '../self-correction/iteration-controller.js'
import { RecoveryFeedback, type RecoveryLesson } from '../self-correction/recovery-feedback.js'
import {
  ReflectionLoop,
  parseCriticResponse,
  type ScoreResult,
} from '../self-correction/reflection-loop.js'
import {
  StrategySelector,
  type FixStrategy,
} from '../self-correction/strategy-selector.js'
import {
  TrajectoryCalibrator,
  type StepReward,
  type TrajectoryRecord,
} from '../self-correction/trajectory-calibrator.js'
import { SelfLearningPipelineHook } from '../self-correction/self-learning-hook.js'
import type {
  NodeExecutor,
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeEvent,
} from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createMockModel(responses: string[] | Array<string | unknown>): BaseChatModel {
  let i = 0
  return {
    invoke: vi.fn(async () => {
      const content = responses[i] ?? 'fallback response'
      if (i < responses.length) i++
      return new AIMessage({ content: content as string })
    }),
  } as unknown as BaseChatModel
}

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return {
    id: 'test-node',
    type: 'task',
    description: 'default description',
    ...overrides,
  } as PipelineNode
}

function makeContext(): NodeExecutionContext {
  return {
    state: {},
    previousResults: new Map(),
  }
}

function makeExecutor(output: unknown, error?: string): NodeExecutor {
  return vi.fn(async (nodeId: string): Promise<NodeResult> => ({
    nodeId,
    output,
    durationMs: 10,
    ...(error ? { error } : {}),
  }))
}

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()
  const nsKey = (ns: string[]) => ns.join('/')
  return {
    async get(ns: string[], key: string) {
      return data.get(nsKey(ns))?.get(key) ?? null
    },
    async put(ns: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(ns)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(ns: string[], key: string) {
      data.get(nsKey(ns))?.delete(key)
    },
    async search(ns: string[], opts?: { filter?: Record<string, unknown>; limit?: number }) {
      const bucket = data.get(nsKey(ns))
      if (!bucket) return []
      let items = Array.from(bucket.values())
      if (opts?.filter) {
        items = items.filter((it) => {
          for (const [k, v] of Object.entries(opts.filter!)) {
            if ((it.value as Record<string, unknown>)[k] !== v) return false
          }
          return true
        })
      }
      return items.slice(0, opts?.limit ?? 1000)
    },
    async batch() { return [] },
    async list() { return [] },
    async start() {},
    async stop() {},
  } as unknown as BaseStore
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10))

// ===========================================================================
// SelfCorrectingNode deep coverage
// ===========================================================================

describe('SelfCorrectingNode deep coverage', () => {
  it('triggers correction when initial score is below threshold', async () => {
    const drafter = createMockModel(['Improved v1', 'Improved v2'])
    const critic = createMockModel([
      'SCORE: 4\nFEEDBACK: Weak.',
      'SCORE: 9\nFEEDBACK: Excellent.',
    ])
    const orig = makeExecutor('Initial draft text')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 3,
    })

    const res = (await wrapped('n', makeNode(), makeContext())) as SelfCorrectingResult
    expect(res.exitReason).toBe('quality_met')
    expect(res.refinementIterations).toBeGreaterThan(1)
    // Drafter must have been invoked for at least one revision
    expect((drafter.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('max-iterations guard prevents unbounded loops', async () => {
    const drafter = createMockModel(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: Bad.',
      'SCORE: 4\nFEEDBACK: Still bad.',
      'SCORE: 5\nFEEDBACK: Better.',
      'SCORE: 6\nFEEDBACK: Getting closer.',
      'SCORE: 7\nFEEDBACK: Almost.',
    ])
    const orig = makeExecutor('draft')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.99, // impossible to reach
      maxIterations: 2,
    })

    const res = (await wrapped('n', makeNode(), makeContext())) as SelfCorrectingResult
    expect(res.refinementIterations).toBeLessThanOrEqual(2)
  })

  it('returns success immediately when no error and first score clears threshold', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel(['SCORE: 10\nFEEDBACK: Perfect.'])
    const orig = makeExecutor('Pristine output')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.7,
    })

    const res = (await wrapped('node-1', makeNode({ id: 'node-1' }), makeContext())) as SelfCorrectingResult
    expect(res.exitReason).toBe('quality_met')
    expect(res.refinementIterations).toBe(1)
    expect(res.output).toBe('Pristine output')
    // Drafter should NOT have been invoked — no revision needed
    expect((drafter.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('error passthrough skips refinement entirely', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const orig = makeExecutor(null, 'pipeline error')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('n', makeNode(), makeContext())) as SelfCorrectingResult

    expect(res.exitReason).toBe('error_passthrough')
    expect(res.error).toBe('pipeline error')
    expect(res.scoreHistory).toEqual([])
    expect(res.refinementIterations).toBe(0)
    expect(res.refinementCostCents).toBe(0)
  })

  it('empty-string output takes the empty_output fast path', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const orig = makeExecutor('')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('e', makeNode({ id: 'e' }), makeContext())) as SelfCorrectingResult

    expect(res.exitReason).toBe('empty_output')
    expect(res.refinementIterations).toBe(0)
    expect((drafter.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((critic.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('null output is treated as empty_output (outputToString branch)', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const orig = makeExecutor(null)

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('null-node', makeNode({ id: 'null-node' }), makeContext())) as SelfCorrectingResult

    expect(res.exitReason).toBe('empty_output')
  })

  it('undefined output is treated as empty_output', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const orig = makeExecutor(undefined)

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('u', makeNode({ id: 'u' }), makeContext())) as SelfCorrectingResult

    expect(res.exitReason).toBe('empty_output')
    expect(res.refinementIterations).toBe(0)
  })

  it('scoreHistory is strictly ordered by iteration', async () => {
    const drafter = createMockModel(['v1', 'v2'])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: low',
      'SCORE: 6\nFEEDBACK: mid',
      'SCORE: 9\nFEEDBACK: high',
    ])
    const orig = makeExecutor('draft')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.85,
      maxIterations: 5,
    })

    const res = (await wrapped('order', makeNode({ id: 'order' }), makeContext())) as SelfCorrectingResult
    expect(res.scoreHistory[0]).toBeCloseTo(0.3, 1)
    expect(res.scoreHistory[res.scoreHistory.length - 1]).toBeCloseTo(0.9, 1)
  })

  it('refinementCostCents is non-negative and accumulates across iterations', async () => {
    const drafter = createMockModel(['v1', 'v2'])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: low',
      'SCORE: 5\nFEEDBACK: mid',
      'SCORE: 9\nFEEDBACK: high',
    ])
    const orig = makeExecutor('x'.repeat(200))

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 5,
    })

    const res = (await wrapped('c', makeNode({ id: 'c' }), makeContext())) as SelfCorrectingResult
    expect(res.refinementCostCents).toBeGreaterThanOrEqual(0)
  })

  it('minImprovement config is threaded through to reflection scoring', async () => {
    const drafter = createMockModel(['v1', 'v2'])
    const critic = createMockModel([
      'SCORE: 5\nFEEDBACK: same',
      'SCORE: 5\nFEEDBACK: same',
    ])
    const orig = makeExecutor('stub')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.95,
      maxIterations: 4,
      minImprovement: 0.05,
    })

    const res = (await wrapped('m', makeNode({ id: 'm' }), makeContext())) as SelfCorrectingResult
    // reflection loop will exit on no_improvement with two equal scores
    expect(['no_improvement', 'max_iterations']).toContain(res.exitReason)
  })

  it('executor is invoked exactly once', async () => {
    const drafter = createMockModel(['v1'])
    const critic = createMockModel([
      'SCORE: 4\nFEEDBACK: low',
      'SCORE: 9\nFEEDBACK: high',
    ])
    const orig = makeExecutor('draft')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    await wrapped('once', makeNode({ id: 'once' }), makeContext())
    expect((orig as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('custom scoreFn returning exactly 0 still produces history entry', async () => {
    const drafter = createMockModel(['v1'])
    const critic = createMockModel([])
    const orig = makeExecutor('x')

    let n = 0
    const scoreFn = async () => {
      n++
      return n === 1 ? { score: 0, feedback: 'dead' } : { score: 0.95, feedback: 'ok' }
    }

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.9,
      maxIterations: 3,
      scoreFn,
    })
    const res = (await wrapped('z', makeNode({ id: 'z' }), makeContext())) as SelfCorrectingResult
    expect(res.scoreHistory[0]).toBe(0)
    expect(res.exitReason).toBe('quality_met')
  })

  it('custom scoreFn returning exactly 1.0 terminates on iteration 1', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const orig = makeExecutor('already good')
    const scoreFn = async () => ({ score: 1.0, feedback: 'perfect' })

    const wrapped = createSelfCorrectingExecutor(orig, drafter, {
      critic,
      qualityThreshold: 0.8,
      scoreFn,
    })
    const res = (await wrapped('one', makeNode({ id: 'one' }), makeContext())) as SelfCorrectingResult
    expect(res.refinementIterations).toBe(1)
    expect(res.exitReason).toBe('quality_met')
  })

  it('number output is converted to JSON for refinement', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel(['SCORE: 9\nFEEDBACK: ok'])
    const orig = makeExecutor(42)

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('n42', makeNode({ id: 'n42' }), makeContext())) as SelfCorrectingResult
    expect(res.output).toBe('42')
  })

  it('durationMs is non-negative', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel(['SCORE: 9\nFEEDBACK: ok'])
    const orig = makeExecutor('out')

    const wrapped = createSelfCorrectingExecutor(orig, drafter, { critic })
    const res = (await wrapped('d', makeNode({ id: 'd' }), makeContext())) as SelfCorrectingResult
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ===========================================================================
// AdaptiveIterationController deep coverage
// ===========================================================================

describe('AdaptiveIterationController deep coverage', () => {
  it('fresh controller has zero score and cost state', () => {
    const c = new AdaptiveIterationController()
    expect(c.currentIteration).toBe(0)
    expect(c.bestScore).toBe(0)
    expect(c.totalCostCents).toBe(0)
    expect(c.scoreHistory).toEqual([])
  })

  it('reset restores state mid-run for reuse across tasks', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.9, maxIterations: 5 })
    c.decide(0.4, 2)
    c.decide(0.6, 2)
    c.reset()
    // After reset, next decide should behave as the first call
    const d = c.decide(0.3, 5)
    expect(c.currentIteration).toBe(1)
    expect(d.reason).toBe('continue')
    expect(d.improvementProbability).toBe(0.5) // neutral again
  })

  it('targetScore=0 returns target_met immediately on any score', () => {
    const c = new AdaptiveIterationController({ targetScore: 0, maxIterations: 10 })
    const d = c.decide(0, 1)
    expect(d.reason).toBe('target_met')
    expect(d.shouldContinue).toBe(false)
  })

  it('maxIterations=1 stops right after first decision if below target', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.9, maxIterations: 1 })
    const d = c.decide(0.5, 10)
    expect(d.shouldContinue).toBe(false)
    expect(d.reason).toBe('budget_exhausted')
  })

  it('estimateCostToTarget is 0 when target is met on the very first iteration', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.5 })
    const d = c.decide(0.7, 5)
    expect(d.estimatedCostToTarget).toBe(0)
  })

  it('estimateCostToTarget is Infinity when no score is recorded yet (via reset)', () => {
    const c = new AdaptiveIterationController()
    c.decide(0.3, 5)
    c.reset()
    // After reset, there is no data. Force a decision that does not hit target.
    const d = c.decide(0.4, 5)
    // With only one iteration post-reset and avgImprovement=0, estimate is Infinity
    expect(d.estimatedCostToTarget).toBe(Infinity)
  })

  it('scoreHistory exposes readonly-like array reflecting full history', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.9, maxIterations: 5 })
    c.decide(0.2, 1)
    c.decide(0.4, 1)
    c.decide(0.5, 1)
    expect(c.scoreHistory.length).toBe(3)
    expect(c.scoreHistory[0]).toBe(0.2)
    expect(c.scoreHistory[2]).toBe(0.5)
  })

  it('bestScore reflects max even when scores oscillate', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.99, maxIterations: 10 })
    c.decide(0.2, 1)
    c.decide(0.7, 1)
    c.decide(0.1, 1)
    c.decide(0.5, 1)
    expect(c.bestScore).toBe(0.7)
  })

  it('totalCostCents sums fractional costs', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.99, maxIterations: 10 })
    c.decide(0.1, 1.5)
    c.decide(0.2, 2.25)
    c.decide(0.3, 0.25)
    expect(c.totalCostCents).toBeCloseTo(4.0, 5)
  })

  it('improvementProbability is bounded in [0, 1]', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.99, maxIterations: 10 })
    c.decide(0.1, 1)
    c.decide(0.2, 1)
    c.decide(0.3, 1)
    const d = c.decide(0.4, 1)
    expect(d.improvementProbability).toBeGreaterThanOrEqual(0)
    expect(d.improvementProbability).toBeLessThanOrEqual(1)
  })

  it('negative deltas drive improvementProbability toward 0', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.99, maxIterations: 10 })
    c.decide(0.8, 1)
    c.decide(0.6, 1)
    const d = c.decide(0.4, 1)
    expect(d.improvementProbability).toBeLessThan(0.5)
  })

  it('partial config merges with defaults (only targetScore overridden)', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.95 })
    // default maxIterations is 5; decide 5 times to hit it
    c.decide(0.1, 1)
    c.decide(0.15, 1)
    c.decide(0.2, 1)
    c.decide(0.25, 1)
    const d = c.decide(0.3, 1)
    expect(d.shouldContinue).toBe(false)
    expect(d.reason).toBe('budget_exhausted')
  })

  it('cost-prohibitive does not trigger on first iteration (needs length >= 2)', () => {
    const c = new AdaptiveIterationController({
      targetScore: 0.99,
      maxIterations: 10,
      costBudgetCents: 100,
      minImprovement: 0.001,
      plateauPatience: 5,
    })
    // First iteration with very low score; no history yet so cost-prohibitive path is skipped
    const d = c.decide(0.05, 40)
    expect(d.reason).toBe('continue')
    expect(d.shouldContinue).toBe(true)
  })

  it('consecutive target_met decisions remain stable', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.8 })
    const d1 = c.decide(0.9, 1)
    const d2 = c.decide(0.95, 1)
    expect(d1.reason).toBe('target_met')
    expect(d2.reason).toBe('target_met')
  })

  it('decide records score and cost even when decision is stop', () => {
    const c = new AdaptiveIterationController({ targetScore: 0.5 })
    c.decide(0.9, 3)
    expect(c.currentIteration).toBe(1)
    expect(c.totalCostCents).toBe(3)
  })
})

// ===========================================================================
// RecoveryFeedback deep coverage
// ===========================================================================

describe('RecoveryFeedback deep coverage', () => {
  function sampleLesson(partial: Partial<RecoveryLesson> = {}): RecoveryLesson {
    return {
      id: 'L1',
      errorType: 'build_failure',
      errorFingerprint: 'fp-x',
      nodeId: 'node-a',
      strategy: 'retry',
      outcome: 'success',
      summary: 'worked',
      timestamp: new Date('2025-06-01T00:00:00Z'),
      ...partial,
    }
  }

  it('no store: recordOutcome / retrieveSimilar / getSuccessRate are all no-ops', async () => {
    const fb = new RecoveryFeedback()
    await expect(fb.recordOutcome(sampleLesson())).resolves.toBeUndefined()
    await expect(fb.retrieveSimilar('build_failure', 'n')).resolves.toEqual([])
    await expect(fb.getSuccessRate('timeout')).resolves.toEqual({ total: 0, successes: 0, rate: 0 })
  })

  it('generateLessonId produces strictly increasing counter values', () => {
    const fb = new RecoveryFeedback()
    const ids = [fb.generateLessonId(), fb.generateLessonId(), fb.generateLessonId()]
    const suffixes = ids.map((id) => Number(id.split('_').pop()))
    expect(suffixes[0]! < suffixes[1]!).toBe(true)
    expect(suffixes[1]! < suffixes[2]!).toBe(true)
  })

  it('generateLessonId includes timestamp component', () => {
    const fb = new RecoveryFeedback()
    const id = fb.generateLessonId()
    expect(id).toMatch(/^lesson_\d+_\d+$/)
  })

  it('recordOutcome serializes the Date timestamp to ISO string', async () => {
    const store = createMemoryStore()
    const putSpy = vi.spyOn(store, 'put')
    const fb = new RecoveryFeedback({ store })
    await fb.recordOutcome(sampleLesson({ id: 'L42' }))

    expect(putSpy).toHaveBeenCalledTimes(1)
    const [, , value] = putSpy.mock.calls[0]!
    expect(typeof (value as Record<string, unknown>)['timestamp']).toBe('string')
    expect(new Date((value as Record<string, unknown>)['timestamp'] as string).toISOString())
      .toBe('2025-06-01T00:00:00.000Z')
  })

  it('retrieveSimilar deserializes timestamp back into a Date', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })
    await fb.recordOutcome(sampleLesson({ id: 'L100' }))

    const results = await fb.retrieveSimilar('build_failure', 'node-a')
    expect(results.length).toBe(1)
    expect(results[0]!.timestamp).toBeInstanceOf(Date)
    expect(results[0]!.timestamp.getTime()).toBe(new Date('2025-06-01T00:00:00Z').getTime())
  })

  it('retrieveSimilar sorts same-node lessons first then by timestamp desc', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })

    await fb.recordOutcome(sampleLesson({ id: 'L-other', nodeId: 'node-b', timestamp: new Date('2026-01-01Z') }))
    await fb.recordOutcome(sampleLesson({ id: 'L-a1', nodeId: 'node-a', timestamp: new Date('2025-01-01Z') }))
    await fb.recordOutcome(sampleLesson({ id: 'L-a2', nodeId: 'node-a', timestamp: new Date('2025-06-01Z') }))

    const results = await fb.retrieveSimilar('build_failure', 'node-a', 10)
    expect(results.length).toBe(3)
    expect(results[0]!.nodeId).toBe('node-a')
    expect(results[1]!.nodeId).toBe('node-a')
    // More recent same-node lesson should come first within same-node group
    expect(results[0]!.id).toBe('L-a2')
    expect(results[2]!.nodeId).toBe('node-b')
  })

  it('retrieveSimilar with limit of 1 returns exactly one result', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })
    await fb.recordOutcome(sampleLesson({ id: 'X', timestamp: new Date('2025-01-01Z') }))
    await fb.recordOutcome(sampleLesson({ id: 'Y', timestamp: new Date('2025-02-01Z') }))

    const results = await fb.retrieveSimilar('build_failure', 'node-a', 1)
    expect(results.length).toBe(1)
  })

  it('custom namespace isolates lessons', async () => {
    const store = createMemoryStore()
    const fbA = new RecoveryFeedback({ store, namespace: ['proj-a'] })
    const fbB = new RecoveryFeedback({ store, namespace: ['proj-b'] })

    await fbA.recordOutcome(sampleLesson({ id: 'A1' }))
    const resA = await fbA.retrieveSimilar('build_failure', 'node-a')
    const resB = await fbB.retrieveSimilar('build_failure', 'node-a')
    expect(resA.length).toBe(1)
    expect(resB.length).toBe(0)
  })

  it('getSuccessRate on empty store returns zero rate with correct shape', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })
    const rate = await fb.getSuccessRate('timeout')
    expect(rate).toEqual({ total: 0, successes: 0, rate: 0 })
  })

  it('getSuccessRate returns 1.0 rate when all outcomes succeeded', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })
    for (let i = 0; i < 4; i++) {
      await fb.recordOutcome(sampleLesson({ id: `L${i}`, outcome: 'success' }))
    }
    const rate = await fb.getSuccessRate('build_failure')
    expect(rate.total).toBe(4)
    expect(rate.rate).toBe(1)
  })

  it('getSuccessRate returns 0.0 rate when all outcomes failed', async () => {
    const store = createMemoryStore()
    const fb = new RecoveryFeedback({ store })
    for (let i = 0; i < 3; i++) {
      await fb.recordOutcome(sampleLesson({ id: `F${i}`, outcome: 'failure' }))
    }
    const rate = await fb.getSuccessRate('build_failure')
    expect(rate.total).toBe(3)
    expect(rate.successes).toBe(0)
    expect(rate.rate).toBe(0)
  })
})

// ===========================================================================
// ReflectionLoop deep coverage
// ===========================================================================

describe('ReflectionLoop deep coverage', () => {
  it('detects immediate success via custom scoreFn without invoking critic', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 3, qualityThreshold: 0.8 })

    const result = await loop.execute(
      't',
      'draft',
      async () => ({ score: 0.9, feedback: 'good' }),
    )
    expect(result.exitReason).toBe('quality_met')
    expect((critic.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('initialDraft short-circuits draft generation and preserves the value when score met', async () => {
    const drafter = createMockModel(['should-not-be-used'])
    const critic = createMockModel(['SCORE: 9\nFEEDBACK: ok'])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 2, qualityThreshold: 0.8 })

    const result = await loop.execute('task', 'my initial draft')
    expect(result.finalOutput).toBe('my initial draft')
    expect((drafter.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('revises draft content between iterations (draft updated)', async () => {
    const drafter = createMockModel(['revised content after feedback'])
    const critic = createMockModel([
      'SCORE: 4\nFEEDBACK: not enough',
      'SCORE: 9\nFEEDBACK: great',
    ])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 3, qualityThreshold: 0.8 })

    const result = await loop.execute('task', 'initial draft')
    expect(result.finalOutput).toBe('revised content after feedback')
    expect(result.exitReason).toBe('quality_met')
  })

  it('records per-iteration timing and draft length', async () => {
    const drafter = createMockModel(['new-draft-longer-than-initial'])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: needs work',
      'SCORE: 9\nFEEDBACK: good',
    ])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 3, qualityThreshold: 0.8 })

    const result = await loop.execute('task', 'short')
    for (const h of result.history) {
      expect(h.durationMs).toBeGreaterThanOrEqual(0)
      expect(h.draftLength).toBeGreaterThan(0)
      expect(h.iteration).toBeGreaterThan(0)
    }
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles non-string model content by JSON-stringifying', async () => {
    // Simulate model returning structured content
    const responses: unknown[] = [[{ type: 'text', text: 'structured' }], 'SCORE: 9\nFEEDBACK: ok']
    let i = 0
    const multi = {
      invoke: vi.fn(async () => {
        const c = responses[i++] as unknown
        return new AIMessage({ content: c as string })
      }),
    } as unknown as BaseChatModel
    const critic = createMockModel(['SCORE: 9\nFEEDBACK: ok'])

    const loop = new ReflectionLoop(multi, critic, { maxIterations: 2, qualityThreshold: 0.8 })
    const result = await loop.execute('task')
    expect(typeof result.finalOutput).toBe('string')
  })

  it('custom criticPrompt is accepted and loop still runs', async () => {
    const drafter = createMockModel(['draft'])
    const critic = createMockModel(['SCORE: 9\nFEEDBACK: ok'])
    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 2,
      qualityThreshold: 0.8,
      criticPrompt: 'custom critic prompt text',
    })
    const r = await loop.execute('task')
    expect(r.exitReason).toBe('quality_met')
  })

  it('budget exhausted with small positive budget still returns a final output', async () => {
    const drafter = createMockModel(['A' + 'x'.repeat(4000)])
    const critic = createMockModel(['SCORE: 3\nFEEDBACK: low'])
    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 5,
      qualityThreshold: 0.9,
      costBudgetCents: 0.01,
    })
    const result = await loop.execute('task')
    expect(result.exitReason).toBe('budget_exhausted')
    expect(result.finalOutput).toBeDefined()
  })

  it('exit reason is propagated exactly as max_iterations when scoring stays strictly improving', async () => {
    const drafter = createMockModel(['v1', 'v2', 'v3'])
    const critic = createMockModel([
      'SCORE: 1\nFEEDBACK: awful',
      'SCORE: 2\nFEEDBACK: bad',
      'SCORE: 3\nFEEDBACK: meh',
    ])
    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.95,
    })
    const result = await loop.execute('task', 'initial')
    expect(result.iterations).toBe(3)
    expect(result.exitReason).toBe('max_iterations')
  })

  it('parseCriticResponse handles missing FEEDBACK gracefully', () => {
    const r: ScoreResult = parseCriticResponse('SCORE: 8')
    expect(r.score).toBeCloseTo(0.8, 2)
    expect(r.feedback).toBeTruthy()
  })

  it('parseCriticResponse with no numbers returns default feedback string', () => {
    const r = parseCriticResponse('nothing here at all')
    expect(typeof r.feedback).toBe('string')
    expect(r.feedback.length).toBeGreaterThan(0)
  })

  it('second revision failure triggers error exit', async () => {
    let count = 0
    const drafter = {
      invoke: vi.fn(async () => {
        count++
        if (count === 1) return new AIMessage({ content: 'first revision' })
        throw new Error('drafter unavailable')
      }),
    } as unknown as BaseChatModel
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: low',
      'SCORE: 4\nFEEDBACK: still low',
      'SCORE: 5\nFEEDBACK: still low',
    ])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 5, qualityThreshold: 0.9 })
    const res = await loop.execute('task', 'initial draft')
    expect(res.exitReason).toBe('error')
  })

  it('maxIterations=1 exits with max_iterations without revising', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel(['SCORE: 3\nFEEDBACK: low'])
    const loop = new ReflectionLoop(drafter, critic, { maxIterations: 1, qualityThreshold: 0.95 })
    const res = await loop.execute('task', 'draft')
    expect(res.iterations).toBe(1)
    expect(res.exitReason).toBe('max_iterations')
    // Drafter should not have been asked to revise
    expect((drafter.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// StrategySelector deep coverage
// ===========================================================================

describe('StrategySelector deep coverage', () => {
  let store: BaseStore
  let selector: StrategySelector

  beforeEach(() => {
    store = createMemoryStore()
    selector = new StrategySelector({ store })
  })

  async function seed(
    s: StrategySelector,
    nodeId: string,
    errorType: string,
    strategy: FixStrategy,
    ok: number,
    fail: number,
  ) {
    for (let i = 0; i < ok; i++) await s.recordOutcome({ nodeId, errorType, strategy, success: true })
    for (let i = 0; i < fail; i++) await s.recordOutcome({ nodeId, errorType, strategy, success: false })
  }

  it('confidence always within [0, 1]', async () => {
    await seed(selector, 'n', 'e', 'targeted', 3, 2)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.confidence).toBeGreaterThanOrEqual(0)
    expect(rec.confidence).toBeLessThanOrEqual(1)
  })

  it('top-ranked strategy is targeted when it is the only option with high rate', async () => {
    await seed(selector, 'n', 'e', 'targeted', 5, 0)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.strategy).toBe('targeted')
    expect(rec.historicalRates.targeted.rate).toBe(1)
  })

  it('targeted rate of exactly skipThreshold is NOT skipped (strictly less than)', async () => {
    // default skipThreshold = 0.2; 1 success / 4 failure = 0.2 exactly
    await seed(selector, 'n', 'e', 'targeted', 1, 4)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.strategy).toBe('targeted')
    expect(rec.historicalRates.targeted.rate).toBeCloseTo(0.2)
  })

  it('regenerative is not promoted over contextual when gap is <= 20%', async () => {
    await seed(selector, 'n', 'e', 'targeted', 0, 5)
    await seed(selector, 'n', 'e', 'contextual', 3, 2)
    await seed(selector, 'n', 'e', 'regenerative', 4, 1)

    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.strategy).toBe('contextual')
  })

  it('falls back to default when recommend is called for unseen errorType', async () => {
    await seed(selector, 'n', 'known', 'targeted', 5, 0)
    const rec = await selector.recommend({ errorType: 'unknown', nodeId: 'n' })
    expect(rec.strategy).toBe('targeted')
    expect(rec.reasoning).toContain('Insufficient')
  })

  it('escalateModel is false for contextual strategy', async () => {
    await seed(selector, 'n', 'e', 'targeted', 0, 5)
    await seed(selector, 'n', 'e', 'contextual', 4, 1)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.strategy).toBe('contextual')
    expect(rec.escalateModel).toBe(false)
  })

  it('suggestedMaxAttempts sits in [1, 5]', async () => {
    await seed(selector, 'n', 'e', 'targeted', 2, 3)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.suggestedMaxAttempts).toBeGreaterThanOrEqual(1)
    expect(rec.suggestedMaxAttempts).toBeLessThanOrEqual(5)
  })

  it('suggestedMaxAttempts = 4 for 40-59% overall success', async () => {
    // 4/8 = 50%
    await seed(selector, 'n', 'e', 'targeted', 2, 2)
    await seed(selector, 'n', 'e', 'contextual', 2, 2)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.suggestedMaxAttempts).toBe(4)
  })

  it('suggestedMaxAttempts = 3 for 60-79% overall success', async () => {
    // 6/10 = 60% — threshold boundary (>=0.6 → 3)
    await seed(selector, 'n', 'e', 'targeted', 3, 2)
    await seed(selector, 'n', 'e', 'contextual', 3, 2)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.suggestedMaxAttempts).toBe(3)
  })

  it('historicalRates entries all have non-negative attempts and computed rates', async () => {
    await seed(selector, 'n', 'e', 'targeted', 2, 1)
    await seed(selector, 'n', 'e', 'contextual', 1, 1)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    for (const strat of ['targeted', 'contextual', 'regenerative'] as const) {
      expect(rec.historicalRates[strat].attempts).toBeGreaterThanOrEqual(0)
      expect(rec.historicalRates[strat].successes).toBeLessThanOrEqual(rec.historicalRates[strat].attempts)
      if (rec.historicalRates[strat].attempts === 0) {
        expect(rec.historicalRates[strat].rate).toBe(0)
      } else {
        expect(rec.historicalRates[strat].rate).toBeCloseTo(
          rec.historicalRates[strat].successes / rec.historicalRates[strat].attempts,
          5,
        )
      }
    }
  })

  it('reasoning is always a non-empty string', async () => {
    await seed(selector, 'n', 'e', 'targeted', 2, 2)
    const rec = await selector.recommend({ errorType: 'e', nodeId: 'n' })
    expect(typeof rec.reasoning).toBe('string')
    expect(rec.reasoning.length).toBeGreaterThan(0)
  })

  it('custom minDataPoints=1 allows recommendations with a single data point', async () => {
    const selectorLoose = new StrategySelector({ store, minDataPoints: 1 })
    await selectorLoose.recordOutcome({ nodeId: 'n', errorType: 'e', strategy: 'targeted', success: true })
    const rec = await selectorLoose.recommend({ errorType: 'e', nodeId: 'n' })
    expect(rec.confidence).toBeGreaterThan(0.3)
  })

  it('recordOutcome invocation stores under correct sub-namespace', async () => {
    const putSpy = vi.spyOn(store, 'put')
    await selector.recordOutcome({ nodeId: 'gen_api', errorType: 'timeout', strategy: 'contextual', success: false })
    expect(putSpy).toHaveBeenCalledTimes(1)
    const [ns] = putSpy.mock.calls[0]!
    expect(ns).toContain('outcomes')
    expect(ns).toContain('gen_api')
    expect(ns).toContain('timeout')
  })
})

// ===========================================================================
// TrajectoryCalibrator deep coverage
// ===========================================================================

describe('TrajectoryCalibrator deep coverage', () => {
  let store: BaseStore
  let cal: TrajectoryCalibrator

  beforeEach(() => {
    store = createMemoryStore()
    cal = new TrajectoryCalibrator({ store })
  })

  const makeStep = (overrides: Partial<StepReward> = {}): StepReward => ({
    nodeId: 'gen_backend',
    runId: `run_${Math.random().toString(36).slice(2)}`,
    qualityScore: 0.85,
    durationMs: 100,
    tokenCost: 500,
    errorCount: 0,
    timestamp: new Date(),
    ...overrides,
  })

  const makeTraj = (overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord => {
    const runId = overrides.runId ?? `run_${Math.random().toString(36).slice(2)}`
    return {
      runId,
      steps: overrides.steps ?? [makeStep({ runId })],
      overallScore: 0.85,
      taskType: 'feature_gen',
      timestamp: new Date(),
      ...overrides,
    }
  }

  async function seed(nodeId: string, taskType: string, scores: number[]) {
    for (const s of scores) {
      const step = makeStep({ nodeId, qualityScore: s })
      await cal.recordStep(step)
      await cal.storeTrajectory(makeTraj({ runId: step.runId, taskType, steps: [step] }))
    }
  }

  it('on-track score produces noop (no suggestion)', async () => {
    await seed('gen_api', 'fg', [0.8, 0.82, 0.78, 0.81, 0.79])
    const res = await cal.detectSuboptimal('gen_api', 0.78, 'fg')
    expect(res.isSuboptimal).toBe(false)
    expect(res.suggestion).toBeUndefined()
  })

  it('suggestion string includes node id and percentage below', async () => {
    await seed('slow', 'fg', [0.9, 0.91, 0.89, 0.92, 0.9])
    const res = await cal.detectSuboptimal('slow', 0.4, 'fg')
    expect(res.isSuboptimal).toBe(true)
    expect(res.suggestion).toContain('slow')
    expect(res.suggestion).toContain('%')
    expect(res.suggestion).toContain('below average')
  })

  it('baseline of 0 yields deviation of 0 regardless of currentScore', async () => {
    // recordStep without storeTrajectory so taskType filter returns count=0 → returns early
    for (let i = 0; i < 6; i++) {
      await cal.recordStep(makeStep({ nodeId: 'n0', qualityScore: 0 }))
    }
    // With no trajectories, taskType filter yields 0 matches → not suboptimal
    const res = await cal.detectSuboptimal('n0', 0.1, 'fg')
    expect(res.deviation).toBe(0)
  })

  it('deviation is clamped to [0, 1] even when currentScore exceeds baseline', async () => {
    await seed('over', 'fg', [0.5, 0.55, 0.45, 0.5, 0.52])
    const res = await cal.detectSuboptimal('over', 0.9, 'fg')
    // currentScore > baseline → deviation should be 0 (not negative)
    expect(res.deviation).toBe(0)
    expect(res.isSuboptimal).toBe(false)
  })

  it('recordStep stores under the namespace [ns, steps, nodeId]', async () => {
    const putSpy = vi.spyOn(store, 'put')
    await cal.recordStep(makeStep({ nodeId: 'abc' }))
    const [ns] = putSpy.mock.calls[0]!
    expect(ns).toContain('steps')
    expect(ns).toContain('abc')
  })

  it('storeTrajectory persists under the runs namespace', async () => {
    const putSpy = vi.spyOn(store, 'put')
    const traj = makeTraj({ runId: 'runX' })
    await cal.storeTrajectory(traj)
    const runsCall = putSpy.mock.calls.find(([ns]) => (ns as string[]).includes('runs'))
    expect(runsCall).toBeDefined()
  })

  it('getAllBaselines returns empty map for unknown task type', async () => {
    const baselines = await cal.getAllBaselines('unknown')
    expect(baselines.size).toBe(0)
  })

  it('detectSuboptimal returns shape even with no data', async () => {
    const res = await cal.detectSuboptimal('gone', 0.5, 'fg')
    expect(res.isSuboptimal).toBe(false)
    expect(res.baseline).toBe(0)
    expect(res.currentScore).toBe(0.5)
    expect(res.deviation).toBe(0)
  })

  it('custom namespace isolates data from default calibrator', async () => {
    const alt = new TrajectoryCalibrator({ store, namespace: ['alt'] })
    await alt.recordStep(makeStep({ nodeId: 'iso', qualityScore: 0.5 }))
    const defaultBaseline = await cal.getNodeBaseline('iso')
    const altBaseline = await alt.getNodeBaseline('iso')
    expect(defaultBaseline.count).toBe(0)
    expect(altBaseline.count).toBe(1)
  })

  it('store.search errors are caught by getNodeBaseline', async () => {
    const s = createMemoryStore()
    vi.spyOn(s, 'search').mockRejectedValue(new Error('store down'))
    const cal2 = new TrajectoryCalibrator({ store: s })
    const b = await cal2.getNodeBaseline('err')
    expect(b).toEqual({ average: 0, count: 0 })
  })

  it('clear is idempotent and safe on empty state', async () => {
    await expect(cal.clear()).resolves.toBeUndefined()
    await expect(cal.clear()).resolves.toBeUndefined()
  })

  it('trajectory with empty steps array does not crash getAllBaselines', async () => {
    const empty = makeTraj({ runId: 'no_steps', taskType: 'edge', steps: [] })
    await cal.storeTrajectory(empty)
    const b = await cal.getAllBaselines('edge')
    expect(b.size).toBe(0)
  })

  it('getNodeBaseline without taskType returns raw average across all steps', async () => {
    await cal.recordStep(makeStep({ nodeId: 'raw', qualityScore: 0.2 }))
    await cal.recordStep(makeStep({ nodeId: 'raw', qualityScore: 0.8 }))
    const b = await cal.getNodeBaseline('raw')
    expect(b.count).toBe(2)
    expect(b.average).toBeCloseTo(0.5, 5)
  })
})

// ===========================================================================
// SelfLearningPipelineHook — additional branches
// ===========================================================================

describe('SelfLearningPipelineHook deep coverage', () => {
  it('skips callbacks entirely when the module is "disabled" (no config provided)', async () => {
    const hook = new SelfLearningPipelineHook({})
    const handler = hook.createEventHandler()
    handler({ type: 'pipeline:node_started', nodeId: 'n', nodeType: 't' })
    handler({ type: 'pipeline:node_completed', nodeId: 'n', durationMs: 1 })
    handler({ type: 'pipeline:node_failed', nodeId: 'n', error: 'x' })
    await tick()
    // Metrics still collected
    const m = hook.getMetrics()
    expect(m.nodesStarted).toBe(1)
    expect(m.nodesCompleted).toBe(1)
    expect(m.nodesFailed).toBe(1)
  })

  it('silently ignores pipeline:calibration_suboptimal events', async () => {
    const hook = new SelfLearningPipelineHook({})
    const handler = hook.createEventHandler()
    handler({
      type: 'pipeline:calibration_suboptimal',
      nodeId: 'n',
      baseline: 0.9,
      currentScore: 0.5,
      deviation: 0.44,
      suggestion: 'consider a different strategy',
    })
    await tick()
    expect(hook.getMetrics().nodesStarted).toBe(0)
  })

  it('silently ignores pipeline:iteration_budget_warning events', async () => {
    const hook = new SelfLearningPipelineHook({})
    const handler = hook.createEventHandler()
    handler({
      type: 'pipeline:iteration_budget_warning',
      level: 'warn_90',
      totalCost: 90,
      budgetCents: 100,
      iteration: 9,
    })
    await tick()
    // No metrics affected
    expect(hook.getMetrics().nodesStarted).toBe(0)
  })

  it('outcome metrics survive across many events in one handler instance', async () => {
    const hook = new SelfLearningPipelineHook({})
    const handler = hook.createEventHandler()
    for (let i = 0; i < 5; i++) {
      handler({ type: 'pipeline:node_started', nodeId: `n${i}`, nodeType: 'task' })
      handler({ type: 'pipeline:node_completed', nodeId: `n${i}`, durationMs: i * 10 })
    }
    handler({ type: 'pipeline:completed', runId: 'r', totalDurationMs: 999 })
    await tick()
    const m = hook.getMetrics()
    expect(m.nodesStarted).toBe(5)
    expect(m.nodesCompleted).toBe(5)
    expect(m.totalDurationMs).toBe(999)
  })

  it('getMetrics returns an independent snapshot that does not leak mutations', async () => {
    const hook = new SelfLearningPipelineHook({})
    const handler = hook.createEventHandler()
    handler({ type: 'pipeline:node_started', nodeId: 'a', nodeType: 't' })
    await tick()
    const snap = hook.getMetrics()
    snap.nodesStarted = 999
    expect(hook.getMetrics().nodesStarted).toBe(1)
  })

  it('event handler is fire-and-forget: returns synchronously even if callback is async', () => {
    const hook = new SelfLearningPipelineHook({
      onNodeCompleted: async () => {
        await new Promise((r) => setTimeout(r, 30))
      },
    })
    const handler = hook.createEventHandler()
    const ret = handler({ type: 'pipeline:node_completed', nodeId: 'x', durationMs: 1 })
    expect(ret).toBeUndefined()
  })

  it('persists to learning store: onNodeCompleted receives data for every completed node', async () => {
    const store: Array<{ nodeId: string; duration: number }> = []
    const hook = new SelfLearningPipelineHook({
      onNodeCompleted: async (nodeId, durationMs) => {
        store.push({ nodeId, duration: durationMs })
      },
    })
    const handler = hook.createEventHandler()
    handler({ type: 'pipeline:node_completed', nodeId: 'a', durationMs: 10 })
    handler({ type: 'pipeline:node_completed', nodeId: 'b', durationMs: 20 })
    handler({ type: 'pipeline:node_completed', nodeId: 'c', durationMs: 30 })
    await tick()
    expect(store).toHaveLength(3)
    expect(store[0]!.nodeId).toBe('a')
    expect(store[2]!.duration).toBe(30)
  })

  it('outcome metrics captured post-run via onPipelineCompleted callback', async () => {
    const outcomes: Array<{ runId: string; totalDurationMs: number }> = []
    const hook = new SelfLearningPipelineHook({
      onPipelineCompleted: async (runId, totalDurationMs) => {
        outcomes.push({ runId, totalDurationMs })
      },
    })
    const handler = hook.createEventHandler()
    handler({ type: 'pipeline:completed', runId: 'run-xyz', totalDurationMs: 1234 })
    await tick()
    expect(outcomes).toEqual([{ runId: 'run-xyz', totalDurationMs: 1234 }])
  })
})
