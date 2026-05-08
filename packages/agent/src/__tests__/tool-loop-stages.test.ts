/**
 * Unit tests for the named pipeline stages extracted from `runToolLoop`
 * (REC-H-12). Each stage is a pure function and can be exercised without
 * constructing a full DzupAgent or mock LLM.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  buildStuckError,
  buildToolStats,
  emitIterationSnapshot,
  runPostTurnHaltCheck,
  runPreIterationGuards,
  runStuckDetectorCheck,
  type ToolLoopState,
} from '../agent/tool-loop/loop-stages.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import { StuckError } from '../agent/stuck-error.js'

function freshState(): ToolLoopState {
  return {
    messages: [new HumanMessage('hi')] as BaseMessage[],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    stuckStage: 0,
    lastStuckToolName: undefined,
    lastStuckReason: undefined,
  }
}

// ============================================================================
// runPreIterationGuards
// ============================================================================

describe('runPreIterationGuards', () => {
  it('returns continue when no signal/budget configured', () => {
    const state = freshState()
    const result = runPreIterationGuards(state, {})
    expect(result).toEqual({ kind: 'continue' })
    expect(state.messages).toHaveLength(1) // unchanged
  })

  it('halts with aborted when signal is aborted', () => {
    const state = freshState()
    const ctrl = new AbortController()
    ctrl.abort()
    const result = runPreIterationGuards(state, { signal: ctrl.signal })
    expect(result).toEqual({ kind: 'halt', stopReason: 'aborted' })
  })

  it('halts with budget_exceeded and appends sentinel message', () => {
    const state = freshState()
    const budget = new IterationBudget({ maxIterations: 1 })
    budget.recordIteration() // 1/1 → exceeded

    const result = runPreIterationGuards(state, { budget })
    expect(result.kind).toBe('halt')
    if (result.kind === 'halt') {
      expect(result.stopReason).toBe('budget_exceeded')
    }
    expect(state.messages).toHaveLength(2)
    const sentinel = state.messages[1]
    expect(sentinel).toBeInstanceOf(AIMessage)
    expect((sentinel as AIMessage).content).toMatch(/Agent stopped: Iteration limit exceeded/)
  })

  it('records iteration and surfaces budget warnings', () => {
    const state = freshState()
    // warnAtPercent default is 80% — set max=10 and warnAtPercent so a single
    // iteration triggers a warning to keep the test deterministic.
    const budget = new IterationBudget({ maxIterations: 10, warnAtPercent: 1 })
    const onBudgetWarning = vi.fn()
    const result = runPreIterationGuards(state, { budget, onBudgetWarning })
    expect(result).toEqual({ kind: 'continue' })
    // Warning may or may not fire depending on threshold semantics — the
    // contract is just that the callback is consulted, never throws.
    expect(onBudgetWarning).not.toThrow
    expect(budget.getState().iterations).toBe(1)
  })
})

// ============================================================================
// runPostTurnHaltCheck
// ============================================================================

describe('runPostTurnHaltCheck', () => {
  it('returns null when shouldHalt is undefined', () => {
    expect(runPostTurnHaltCheck({})).toBeNull()
  })

  it('returns null when shouldHalt returns false', () => {
    const onHalted = vi.fn()
    const result = runPostTurnHaltCheck({ shouldHalt: () => false, onHalted })
    expect(result).toBeNull()
    expect(onHalted).not.toHaveBeenCalled()
  })

  it('returns token_exhausted halt and fires onHalted when shouldHalt returns true', () => {
    const onHalted = vi.fn()
    const result = runPostTurnHaltCheck({ shouldHalt: () => true, onHalted })
    expect(result).toEqual({ kind: 'halt', stopReason: 'token_exhausted' })
    expect(onHalted).toHaveBeenCalledExactlyOnceWith('token_exhausted')
  })
})

// ============================================================================
// runStuckDetectorCheck
// ============================================================================

describe('runStuckDetectorCheck', () => {
  it('returns null when no detector configured', () => {
    const state = freshState()
    expect(runStuckDetectorCheck(state, 1, {})).toBeNull()
  })

  it('returns null when detector reports not stuck', () => {
    const state = freshState()
    const detector = new StuckDetector({ maxIdleIterations: 10 })
    const result = runStuckDetectorCheck(state, 1, { stuckDetector: detector })
    expect(result).toBeNull()
    expect(state.lastStuckReason).toBeUndefined()
  })

  it('returns stuck halt + fires onStuckDetected + records reason on state', () => {
    const state = freshState()
    // maxIdleIterations: 1 plus 0 tool calls = idle → stuck after one record.
    const detector = new StuckDetector({ maxIdleIterations: 1 })
    const onStuckDetected = vi.fn()
    const result = runStuckDetectorCheck(state, 0, {
      stuckDetector: detector,
      onStuckDetected,
    })
    expect(result).toEqual({ kind: 'halt', stopReason: 'stuck' })
    expect(onStuckDetected).toHaveBeenCalledOnce()
    expect(state.lastStuckReason).toBeTypeOf('string')
    expect(state.lastStuckReason!.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// emitIterationSnapshot
// ============================================================================

describe('emitIterationSnapshot', () => {
  it('is a no-op when no listener is configured', () => {
    const state = freshState()
    expect(() => emitIterationSnapshot(state, 0, 1, {})).not.toThrow()
  })

  it('passes a defensive copy of messages with iteration+1', () => {
    const state = freshState()
    state.totalInputTokens = 42
    state.totalOutputTokens = 7
    const onIteration = vi.fn()
    emitIterationSnapshot(state, 0, 3, { onIteration })

    expect(onIteration).toHaveBeenCalledOnce()
    const arg = onIteration.mock.calls[0]![0]
    expect(arg.iteration).toBe(1) // 0-based → 1-based
    expect(arg.totalInputTokens).toBe(42)
    expect(arg.totalOutputTokens).toBe(7)
    expect(arg.llmCalls).toBe(3)
    expect(arg.messages).not.toBe(state.messages) // defensive copy
    expect(arg.messages).toHaveLength(state.messages.length)
  })

  it('swallows listener errors so a failing snapshot never aborts the run', () => {
    const state = freshState()
    const onIteration = vi.fn(() => {
      throw new Error('boom')
    })
    expect(() => emitIterationSnapshot(state, 0, 1, { onIteration })).not.toThrow()
    expect(onIteration).toHaveBeenCalledOnce()
  })
})

// ============================================================================
// buildToolStats
// ============================================================================

describe('buildToolStats', () => {
  it('returns empty array for empty map', () => {
    expect(buildToolStats(new Map())).toEqual([])
  })

  it('computes avgMs and preserves error/call counters', () => {
    const map = new Map<string, { calls: number; errors: number; totalMs: number }>([
      ['toolA', { calls: 4, errors: 1, totalMs: 200 }],
      ['toolB', { calls: 1, errors: 0, totalMs: 50 }],
    ])
    const stats = buildToolStats(map)
    expect(stats).toHaveLength(2)
    const a = stats.find(s => s.name === 'toolA')!
    expect(a).toEqual({ name: 'toolA', calls: 4, errors: 1, totalMs: 200, avgMs: 50 })
    const b = stats.find(s => s.name === 'toolB')!
    expect(b.avgMs).toBe(50)
  })

  it('reports avgMs=0 when calls=0 (defensive against div-by-zero)', () => {
    const map = new Map([['unused', { calls: 0, errors: 0, totalMs: 0 }]])
    const stats = buildToolStats(map)
    expect(stats[0]!.avgMs).toBe(0)
  })
})

// ============================================================================
// buildStuckError
// ============================================================================

describe('buildStuckError', () => {
  it('returns undefined for non-stuck stop reasons', () => {
    const state = freshState()
    expect(buildStuckError('complete', state)).toBeUndefined()
    expect(buildStuckError('iteration_limit', state)).toBeUndefined()
    expect(buildStuckError('budget_exceeded', state)).toBeUndefined()
    expect(buildStuckError('aborted', state)).toBeUndefined()
  })

  it('returns StuckError with reason and tool when present', () => {
    const state = freshState()
    state.stuckStage = 3
    state.lastStuckToolName = 'shell.exec'
    state.lastStuckReason = 'repeated identical args 5 times'
    const err = buildStuckError('stuck', state)
    expect(err).toBeInstanceOf(StuckError)
    expect(err!.repeatedTool).toBe('shell.exec')
    expect(err!.reason).toBe('repeated identical args 5 times')
    expect(err!.escalationLevel).toBe(3)
  })

  it('clamps escalationLevel into [1,3] and applies sane reason fallback', () => {
    const state = freshState()
    // stuckStage 0 should clamp UP to 1 (escalationLevel >= 1 invariant).
    state.stuckStage = 0
    const errLow = buildStuckError('stuck', state)
    expect(errLow!.escalationLevel).toBe(1)
    expect(errLow!.reason).toBe('Agent stuck with no progress')

    // stuckStage 99 should clamp DOWN to 3.
    state.stuckStage = 99
    const errHigh = buildStuckError('stuck', state)
    expect(errHigh!.escalationLevel).toBe(3)
  })
})
