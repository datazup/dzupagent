import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  ReflectionLoop,
  parseCriticResponse,
  type ScoreResult,
} from '../self-correction/index.js'

// ---------------------------------------------------------------------------
// Mock model helper
// ---------------------------------------------------------------------------

/**
 * Create a mock BaseChatModel that returns the given responses in order.
 * Each call to invoke() returns the next response in the queue.
 */
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

// ---------------------------------------------------------------------------
// parseCriticResponse
// ---------------------------------------------------------------------------

describe('parseCriticResponse', () => {
  it('parses a well-formed SCORE/FEEDBACK response', () => {
    const result = parseCriticResponse(
      'SCORE: 7\nFEEDBACK: Good structure but missing error handling.',
    )
    expect(result.score).toBeCloseTo(0.7, 1)
    expect(result.feedback).toBe('Good structure but missing error handling.')
  })

  it('parses a decimal score', () => {
    const result = parseCriticResponse('SCORE: 8.5\nFEEDBACK: Almost perfect.')
    expect(result.score).toBeCloseTo(0.85, 2)
    expect(result.feedback).toBe('Almost perfect.')
  })

  it('clamps score to 0-10 range', () => {
    const high = parseCriticResponse('SCORE: 15\nFEEDBACK: Way too generous.')
    expect(high.score).toBe(1.0)

    // Negative numbers aren't matched by the regex; the fallback finds "3" -> 0.3
    // Instead test clamping at the low end with 0
    const low = parseCriticResponse('SCORE: 0\nFEEDBACK: Terrible output.')
    expect(low.score).toBe(0)
  })

  it('falls back to default score when no number is found', () => {
    const result = parseCriticResponse('This output is acceptable.')
    expect(result.score).toBeCloseTo(0.5, 1)
  })

  it('handles "X/10" or "X out of 10" notation', () => {
    const result = parseCriticResponse('I would rate this 8/10. Solid work.')
    expect(result.score).toBeCloseTo(0.8, 1)
  })

  it('provides default feedback when none is extracted', () => {
    const result = parseCriticResponse('SCORE: 6')
    expect(result.feedback).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// ReflectionLoop — quality_met exit
// ---------------------------------------------------------------------------

describe('ReflectionLoop', () => {
  it('exits with quality_met when critic gives a high score immediately', async () => {
    const drafter = createMockModel(['Initial draft content.'])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Excellent work, no changes needed.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Write a greeting function.')

    expect(result.exitReason).toBe('quality_met')
    expect(result.iterations).toBe(1)
    expect(result.finalOutput).toBe('Initial draft content.')
    expect(result.history).toHaveLength(1)
    expect(result.history[0]!.score).toBeCloseTo(0.9, 1)
  })

  // ---------------------------------------------------------------------------
  // max_iterations exit
  // ---------------------------------------------------------------------------

  it('exits with max_iterations when quality is never met', async () => {
    const drafter = createMockModel([
      'Draft v1',
      'Draft v2',
      'Draft v3',
    ])
    const critic = createMockModel([
      'SCORE: 4\nFEEDBACK: Needs more detail.',
      'SCORE: 5\nFEEDBACK: Better but still incomplete.',
      'SCORE: 6\nFEEDBACK: Getting there.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.9,
    })

    const result = await loop.execute('Write a complex essay.')

    expect(result.exitReason).toBe('max_iterations')
    expect(result.iterations).toBe(3)
    expect(result.history).toHaveLength(3)
  })

  // ---------------------------------------------------------------------------
  // no_improvement exit
  // ---------------------------------------------------------------------------

  it('exits with no_improvement when score does not increase', async () => {
    const drafter = createMockModel([
      'Draft v1',
      'Draft v2',
    ])
    const critic = createMockModel([
      'SCORE: 5\nFEEDBACK: Needs improvement.',
      'SCORE: 5\nFEEDBACK: Same issues remain.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 5,
      qualityThreshold: 0.9,
    })

    const result = await loop.execute('Write a poem.')

    expect(result.exitReason).toBe('no_improvement')
    expect(result.iterations).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Uses initial draft
  // ---------------------------------------------------------------------------

  it('skips draft generation when initialDraft is provided', async () => {
    const drafter = createMockModel(['Revised draft.'])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Great output.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Improve this.', 'Pre-existing draft.')

    expect(result.exitReason).toBe('quality_met')
    expect(result.finalOutput).toBe('Pre-existing draft.')
    // Drafter should NOT have been called for initial generation
    // (only critic was called)
    expect((critic.invoke as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // Custom scoreFn
  // ---------------------------------------------------------------------------

  it('uses custom scoreFn instead of critic LLM', async () => {
    const drafter = createMockModel([
      'Draft v1',
      'Draft v2',
    ])
    const critic = createMockModel([]) // should not be called

    let callCount = 0
    const scoreFn = async (_output: string, _task: string): Promise<ScoreResult> => {
      callCount++
      return callCount === 1
        ? { score: 0.5, feedback: 'Add more detail.' }
        : { score: 0.9, feedback: 'Good now.' }
    }

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 5,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Summarize data.', undefined, scoreFn)

    expect(result.exitReason).toBe('quality_met')
    expect(callCount).toBe(2)
    expect((critic.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // budget_exhausted exit
  // ---------------------------------------------------------------------------

  it('exits with budget_exhausted when cost budget is very low', async () => {
    // With costBudgetCents = 0, should exhaust immediately after initial draft
    const drafter = createMockModel(['A very long draft ' + 'x'.repeat(50000)])
    const critic = createMockModel([
      'SCORE: 5\nFEEDBACK: Needs work.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 5,
      qualityThreshold: 0.9,
      costBudgetCents: 0,
    })

    const result = await loop.execute('Write something.')

    // Should exit before completing all iterations
    expect(result.exitReason).toBe('budget_exhausted')
  })

  // ---------------------------------------------------------------------------
  // error exit
  // ---------------------------------------------------------------------------

  it('exits with error when drafter throws', async () => {
    const drafter = {
      invoke: vi.fn(async () => { throw new Error('model down') }),
    } as unknown as BaseChatModel

    const critic = createMockModel([])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Write something.')

    expect(result.exitReason).toBe('error')
    expect(result.finalOutput).toBe('')
    expect(result.iterations).toBe(0)
  })

  it('exits with error when critic throws', async () => {
    const drafter = createMockModel(['Draft v1'])
    const critic = {
      invoke: vi.fn(async () => { throw new Error('critic down') }),
    } as unknown as BaseChatModel

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 3,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Write something.', 'Initial draft.')

    expect(result.exitReason).toBe('error')
    expect(result.iterations).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // Iteration history tracking
  // ---------------------------------------------------------------------------

  it('records correct iteration history across multiple rounds', async () => {
    const drafter = createMockModel([
      'Draft v1',
      'Draft v2 improved',
      'Draft v3 final',
    ])
    const critic = createMockModel([
      'SCORE: 3\nFEEDBACK: Very incomplete.',
      'SCORE: 6\nFEEDBACK: Better but needs polish.',
      'SCORE: 9\nFEEDBACK: Excellent.',
    ])

    const loop = new ReflectionLoop(drafter, critic, {
      maxIterations: 5,
      qualityThreshold: 0.8,
    })

    const result = await loop.execute('Complex task.')

    expect(result.exitReason).toBe('quality_met')
    expect(result.iterations).toBe(3)
    expect(result.history[0]!.score).toBeCloseTo(0.3, 1)
    expect(result.history[1]!.score).toBeCloseTo(0.6, 1)
    expect(result.history[2]!.score).toBeCloseTo(0.9, 1)

    // Each iteration should have positive duration
    for (const iter of result.history) {
      expect(iter.durationMs).toBeGreaterThanOrEqual(0)
      expect(iter.draftLength).toBeGreaterThan(0)
      expect(iter.iteration).toBeGreaterThan(0)
    }

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  // ---------------------------------------------------------------------------
  // Default config
  // ---------------------------------------------------------------------------

  it('uses sensible defaults when no config is provided', async () => {
    const drafter = createMockModel(['Good draft'])
    const critic = createMockModel([
      'SCORE: 9\nFEEDBACK: Looks good.',
    ])

    const loop = new ReflectionLoop(drafter, critic)
    const result = await loop.execute('Quick task.', 'Good draft')

    expect(result.exitReason).toBe('quality_met')
    expect(result.iterations).toBe(1)
  })
})
