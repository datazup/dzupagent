/**
 * Branch coverage tests for pipeline/loop-executor.ts.
 * Focuses on uncovered branches: cancellation paths, body error, max
 * iterations fail, and predicate helpers with unusual inputs.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  executeLoop,
  stateFieldTruthy,
  qualityBelow,
  hasErrors,
} from '../pipeline/loop-executor.js'
import type { LoopNode, PipelineNode } from '@dzupagent/core'
import type {
  NodeExecutor,
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeEvent,
} from '../pipeline/pipeline-runtime-types.js'

function makeLoopNode(overrides: Partial<LoopNode> = {}): LoopNode {
  return {
    id: 'L',
    type: 'loop',
    bodyNodeIds: ['body1'],
    maxIterations: 3,
    continuePredicateName: 'keepGoing',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    state: {},
    previousResults: new Map(),
    ...overrides,
  }
}

function makeBody(id: string): PipelineNode {
  return { id, type: 'agent', agentId: 'a1', timeoutMs: 1000 }
}

describe('loop-executor — branch coverage', () => {
  it('throws if named predicate is missing from registry', async () => {
    const node = makeLoopNode({ continuePredicateName: 'unknown' })
    const exec: NodeExecutor = async (id) => ({ nodeId: id, output: null, durationMs: 1 })
    await expect(
      executeLoop(node, [makeBody('body1')], exec, makeCtx(), {}),
    ).rejects.toThrow(/predicate "unknown" not found/)
  })

  it('stops immediately when signal is aborted before loop starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const node = makeLoopNode()
    const exec = vi.fn<NodeExecutor>(async (id) => ({
      nodeId: id, output: null, durationMs: 1,
    }))
    const { result, metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx({ signal: controller.signal }),
      { keepGoing: () => true },
    )
    expect(metrics.iterationCount).toBe(0)
    expect(metrics.terminationReason).toBe('cancelled')
    expect(metrics.converged).toBe(false)
    expect(result.error).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it('stops during body execution when signal aborts mid-iteration', async () => {
    const controller = new AbortController()
    const node = makeLoopNode({ bodyNodeIds: ['b1', 'b2'] })
    const exec: NodeExecutor = async (id) => {
      if (id === 'b1') {
        controller.abort()
      }
      return { nodeId: id, output: null, durationMs: 1 }
    }
    const { metrics } = await executeLoop(
      node,
      [makeBody('b1'), makeBody('b2')],
      exec,
      makeCtx({ signal: controller.signal }),
      { keepGoing: () => true },
    )
    expect(metrics.terminationReason).toBe('cancelled')
    expect(metrics.iterationCount).toBe(1)
  })

  it('returns body error and does not continue looping', async () => {
    const node = makeLoopNode({ maxIterations: 5 })
    const exec: NodeExecutor = async (id) => ({
      nodeId: id,
      output: 'partial',
      durationMs: 1,
      error: 'boom',
    })
    const onEvent = vi.fn()
    const { result, metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => true },
      onEvent,
    )
    expect(result.error).toContain('Loop body node "body1" failed: boom')
    expect(result.output).toBe('partial')
    expect(metrics.converged).toBe(false)
    expect(metrics.terminationReason).toBe('condition_met')
    expect(metrics.iterationCount).toBe(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pipeline:loop_iteration', iteration: 1 }),
    )
  })

  it('fails with max_iterations error when failOnMaxIterations is set', async () => {
    const node = makeLoopNode({ maxIterations: 2, failOnMaxIterations: true })
    const exec: NodeExecutor = async (id) => ({
      nodeId: id,
      output: `out-${id}`,
      durationMs: 1,
    })
    const { result, metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => true },
    )
    expect(result.error).toContain('reached maxIterations (2)')
    expect(metrics.iterationCount).toBe(2)
    expect(metrics.terminationReason).toBe('max_iterations')
    expect(metrics.converged).toBe(false)
  })

  it('reaches maxIterations cleanly when failOnMaxIterations is false', async () => {
    const node = makeLoopNode({ maxIterations: 2 })
    const exec: NodeExecutor = async (id) => ({
      nodeId: id,
      output: `out-${id}`,
      durationMs: 1,
    })
    const { result, metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => true },
    )
    expect(result.error).toBeUndefined()
    expect(metrics.iterationCount).toBe(2)
    expect(metrics.terminationReason).toBe('max_iterations')
  })

  it('terminates when predicate returns false', async () => {
    const node = makeLoopNode({ maxIterations: 10 })
    let calls = 0
    const exec: NodeExecutor = async (id) => {
      calls++
      return { nodeId: id, output: calls, durationMs: 1 }
    }
    const { result, metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => calls < 3 },
    )
    expect(result.error).toBeUndefined()
    expect(metrics.converged).toBe(true)
    expect(metrics.terminationReason).toBe('condition_met')
    expect(metrics.iterationCount).toBe(3)
  })

  it('aborts after body completes but before predicate evaluation', async () => {
    const controller = new AbortController()
    const node = makeLoopNode()
    const exec: NodeExecutor = async (id) => {
      controller.abort()
      return { nodeId: id, output: null, durationMs: 1 }
    }
    const { metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx({ signal: controller.signal }),
      { keepGoing: () => true },
    )
    expect(metrics.terminationReason).toBe('cancelled')
  })

  it('handles empty bodyNodes array gracefully', async () => {
    const node = makeLoopNode({ bodyNodeIds: [], maxIterations: 2 })
    const exec = vi.fn<NodeExecutor>()
    const { result, metrics } = await executeLoop(
      node,
      [],
      exec,
      makeCtx(),
      { keepGoing: () => false },
    )
    expect(result.output).toBeNull()
    expect(exec).not.toHaveBeenCalled()
    expect(metrics.iterationCount).toBe(1)
  })

  it('retains lastBodyResult output when converging', async () => {
    const node = makeLoopNode({ maxIterations: 5 })
    let i = 0
    const exec: NodeExecutor = async (id) => {
      i++
      return { nodeId: id, output: `iter-${i}`, durationMs: 1 }
    }
    const { result } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => i < 2 },
    )
    expect(result.output).toBe('iter-2')
  })
})

describe('loop-executor predicate helpers — branch coverage', () => {
  describe('stateFieldTruthy', () => {
    it('returns true for truthy values', () => {
      const pred = stateFieldTruthy('flag')
      expect(pred({ flag: true })).toBe(true)
      expect(pred({ flag: 'yes' })).toBe(true)
      expect(pred({ flag: 1 })).toBe(true)
      expect(pred({ flag: ['x'] })).toBe(true)
    })
    it('returns false for falsy values', () => {
      const pred = stateFieldTruthy('flag')
      expect(pred({ flag: false })).toBe(false)
      expect(pred({ flag: 0 })).toBe(false)
      expect(pred({ flag: '' })).toBe(false)
      expect(pred({ flag: null })).toBe(false)
      expect(pred({})).toBe(false)
    })
  })

  describe('qualityBelow', () => {
    it('returns true when field is missing (not a number)', () => {
      expect(qualityBelow('score', 0.8)({})).toBe(true)
    })
    it('returns true when value is a non-number type', () => {
      expect(qualityBelow('score', 0.8)({ score: 'high' })).toBe(true)
      expect(qualityBelow('score', 0.8)({ score: null })).toBe(true)
    })
    it('returns true when value is below threshold', () => {
      expect(qualityBelow('score', 0.8)({ score: 0.5 })).toBe(true)
    })
    it('returns false when value is at or above threshold', () => {
      expect(qualityBelow('score', 0.8)({ score: 0.8 })).toBe(false)
      expect(qualityBelow('score', 0.8)({ score: 0.9 })).toBe(false)
    })
  })

  describe('hasErrors', () => {
    it('returns false when field is missing', () => {
      expect(hasErrors('errors')({})).toBe(false)
    })
    it('returns false when field is not an array', () => {
      expect(hasErrors('errors')({ errors: 'boom' })).toBe(false)
      expect(hasErrors('errors')({ errors: 1 })).toBe(false)
      expect(hasErrors('errors')({ errors: null })).toBe(false)
    })
    it('returns false for empty array', () => {
      expect(hasErrors('errors')({ errors: [] })).toBe(false)
    })
    it('returns true for non-empty array', () => {
      expect(hasErrors('errors')({ errors: ['e1'] })).toBe(true)
    })
  })
})

describe('loop-executor — event emission paths', () => {
  it('does not error when no onEvent callback is provided', async () => {
    const node = makeLoopNode({ maxIterations: 1 })
    const exec: NodeExecutor = async (id) => ({ nodeId: id, output: 'x', durationMs: 1 })
    const { metrics } = await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => false },
    )
    expect(metrics.iterationCount).toBe(1)
  })

  it('emits iteration events with monotonically-increasing indices', async () => {
    const node = makeLoopNode({ maxIterations: 3 })
    const exec: NodeExecutor = async (id) => ({ nodeId: id, output: id, durationMs: 1 })
    const events: PipelineRuntimeEvent[] = []
    const onEvent = (e: PipelineRuntimeEvent): void => { events.push(e) }
    await executeLoop(
      node,
      [makeBody('body1')],
      exec,
      makeCtx(),
      { keepGoing: () => true },
      onEvent,
    )
    const iterations = events
      .filter(e => e.type === 'pipeline:loop_iteration')
      .map(e => (e as { iteration: number }).iteration)
    expect(iterations).toEqual([1, 2, 3])
  })
})
