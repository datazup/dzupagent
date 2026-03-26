import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { PipelineNode } from '@forgeagent/core'

import {
  createSelfCorrectingExecutor,
  type SelfCorrectingConfig,
  type SelfCorrectingResult,
} from '../self-correction/self-correcting-node.js'
import type {
  NodeExecutor,
  NodeResult,
  NodeExecutionContext,
} from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock BaseChatModel that returns responses in order. */
function createMockModel(responses: string[]): BaseChatModel {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      const content = responses[callIndex] ?? 'fallback response'
      if (callIndex < responses.length) callIndex++
      return new AIMessage({ content })
    }),
  } as unknown as BaseChatModel
}

/** Create a minimal PipelineNode for testing. */
function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return {
    id: 'test-node',
    type: 'task',
    description: 'Generate a summary of the input data',
    ...overrides,
  } as PipelineNode
}

/** Create a minimal NodeExecutionContext. */
function makeContext(): NodeExecutionContext {
  return {
    state: {},
    previousResults: new Map(),
  }
}

/** Create a simple NodeExecutor that returns the given output. */
function makeExecutor(output: unknown, error?: string): NodeExecutor {
  return vi.fn(async (nodeId: string): Promise<NodeResult> => ({
    nodeId,
    output,
    durationMs: 10,
    ...(error ? { error } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSelfCorrectingExecutor', () => {
  it('wraps executor and returns enhanced result with refinement metadata', async () => {
    const drafter = createMockModel(['Revised output v1'])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Excellent output.',
    ])
    const original = makeExecutor('Initial output')

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 3,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('test-node', makeNode(), makeContext()) as SelfCorrectingResult

    expect(result.nodeId).toBe('test-node')
    expect(result.refinementIterations).toBeGreaterThanOrEqual(1)
    expect(result.scoreHistory).toBeDefined()
    expect(result.scoreHistory.length).toBeGreaterThan(0)
    expect(result.exitReason).toBeDefined()
    expect(typeof result.refinementCostCents).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('passes through errors without refinement', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const original = makeExecutor(null, 'Something went wrong')

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.8,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('err-node', makeNode({ id: 'err-node' }), makeContext()) as SelfCorrectingResult

    expect(result.error).toBe('Something went wrong')
    expect(result.refinementIterations).toBe(0)
    expect(result.scoreHistory).toEqual([])
    expect(result.exitReason).toBe('error_passthrough')
    expect(result.refinementCostCents).toBe(0)

    // Drafter and critic should not have been called
    expect((drafter.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((critic.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('uses ReflectionLoop for iterative improvement until quality_met', async () => {
    // Drafter produces revisions; critic scores improve over iterations
    const drafter = createMockModel([
      'Improved output v1',
      'Improved output v2',
    ])
    const critic = createMockModel([
      'SCORE: 4\nFEEDBACK: Needs more detail and structure.',
      'SCORE: 6\nFEEDBACK: Better but still missing examples.',
      'SCORE: 9\nFEEDBACK: Excellent, well structured with examples.',
    ])
    const original = makeExecutor('Initial rough draft')

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 5,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('ref-node', makeNode({ id: 'ref-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('quality_met')
    expect(result.refinementIterations).toBe(3)
    expect(result.scoreHistory).toHaveLength(3)
    // Scores should be approximately 0.4, 0.6, 0.9
    expect(result.scoreHistory[0]).toBeCloseTo(0.4, 1)
    expect(result.scoreHistory[2]).toBeCloseTo(0.9, 1)
  })

  it('adds refinement metadata to result', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Perfect.',
    ])
    const original = makeExecutor('Good output already')

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 3,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('meta-node', makeNode({ id: 'meta-node' }), makeContext()) as SelfCorrectingResult

    // Should exit after 1 iteration since first score meets threshold
    expect(result.exitReason).toBe('quality_met')
    expect(result.refinementIterations).toBe(1)
    expect(result.scoreHistory).toHaveLength(1)
    expect(result.scoreHistory[0]).toBeCloseTo(0.9, 1)
    expect(result.refinementCostCents).toBeGreaterThanOrEqual(0)
    expect(result.output).toBe('Good output already')
  })

  it('respects cost budget', async () => {
    // With a very low budget, refinement should be limited
    const drafter = createMockModel([
      'x'.repeat(100_000),
      'x'.repeat(100_000),
    ])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: Needs work.',
      'SCORE: 4\nFEEDBACK: Slightly better.',
      'SCORE: 5\nFEEDBACK: Improving.',
    ])
    const original = makeExecutor('Initial ' + 'y'.repeat(50_000))

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.95,
      maxIterations: 10,
      costBudgetCents: 0, // Essentially zero budget
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('budget-node', makeNode({ id: 'budget-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('budget_exhausted')
    // Should not have completed all 10 iterations
    expect(result.refinementIterations).toBeLessThan(10)
  })

  it('uses custom scoreFn when provided', async () => {
    const drafter = createMockModel(['Revised output'])
    const critic = createMockModel([]) // Should not be called
    const original = makeExecutor('Initial output')

    let scoreFnCallCount = 0
    const customScoreFn = async (output: string, _task: string): Promise<{ score: number; feedback: string }> => {
      scoreFnCallCount++
      // First call scores low, second call scores high
      if (scoreFnCallCount === 1) {
        return { score: 0.4, feedback: `Output "${output.slice(0, 20)}" needs improvement` }
      }
      return { score: 0.95, feedback: 'Great improvement' }
    }

    const config: SelfCorrectingConfig = {
      critic,
      qualityThreshold: 0.8,
      maxIterations: 5,
      scoreFn: customScoreFn,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('score-node', makeNode({ id: 'score-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('quality_met')
    expect(scoreFnCallCount).toBe(2)
    // Critic LLM should NOT have been called since we have a custom scoreFn
    expect((critic.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('works with default config values', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Looks good.',
    ])
    const original = makeExecutor('Decent output')

    // Minimal config: only critic is required
    const config: SelfCorrectingConfig = {
      critic,
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('default-node', makeNode({ id: 'default-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('quality_met')
    expect(result.refinementIterations).toBe(1)
    expect(result.nodeId).toBe('default-node')
  })

  it('calls the original executor with correct arguments', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel(['SCORE: 10\nFEEDBACK: Perfect.'])
    const original = makeExecutor('output')

    const config: SelfCorrectingConfig = { critic }
    const wrapped = createSelfCorrectingExecutor(original, drafter, config)

    const node = makeNode({ id: 'call-test' })
    const ctx = makeContext()
    await wrapped('call-test', node, ctx)

    expect(original).toHaveBeenCalledWith('call-test', node, ctx)
  })

  it('handles object output by converting to JSON string for refinement', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Good structure.',
    ])
    const original = makeExecutor({ key: 'value', nested: { a: 1 } })

    const config: SelfCorrectingConfig = { critic }
    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('obj-node', makeNode({ id: 'obj-node' }), makeContext()) as SelfCorrectingResult

    // The final output should be the original JSON since score met threshold on first pass
    expect(result.output).toBe('{"key":"value","nested":{"a":1}}')
    expect(result.exitReason).toBe('quality_met')
  })

  it('handles empty output without attempting refinement', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([])
    const original = makeExecutor('')

    const config: SelfCorrectingConfig = { critic }
    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('empty-node', makeNode({ id: 'empty-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('empty_output')
    expect(result.refinementIterations).toBe(0)
    expect(result.refinementCostCents).toBe(0)
  })

  it('uses node description as task description for the critic', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([
      'SCORE: 8\nFEEDBACK: Meets requirements.',
    ])
    const original = makeExecutor('Some output')

    const config: SelfCorrectingConfig = { critic, qualityThreshold: 0.8 }
    const wrapped = createSelfCorrectingExecutor(original, drafter, config)

    const node = makeNode({ id: 'desc-node', description: 'Summarize the quarterly report data' })
    const result = await wrapped('desc-node', node, makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('quality_met')
  })

  it('uses evaluationCriteria over node description when provided', async () => {
    const drafter = createMockModel([])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Meets all criteria.',
    ])
    const original = makeExecutor('Output text')

    const config: SelfCorrectingConfig = {
      critic,
      evaluationCriteria: 'Must contain at least 3 bullet points and a conclusion',
    }

    const wrapped = createSelfCorrectingExecutor(original, drafter, config)
    const result = await wrapped('crit-node', makeNode({ id: 'crit-node' }), makeContext()) as SelfCorrectingResult

    expect(result.exitReason).toBe('quality_met')
  })
})
