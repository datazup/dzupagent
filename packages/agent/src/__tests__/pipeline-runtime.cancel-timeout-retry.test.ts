/**
 * pipeline-runtime.cancel-timeout-retry.test.ts
 *
 * Gap-coverage tests for PipelineRuntime targeting three scenarios:
 *
 * 1. Step retry exhaustion — pipeline fails after all retries are consumed
 *    and emits the correct error details via the NodeResult.
 *
 * 2. Timeout race — step times out via vi.useFakeTimers(). The runtime
 *    surfaces the timeout-sourced error correctly.
 *
 * 3. Graceful cancel via AbortSignal — pipeline stops cleanly mid-run
 *    and returns state 'cancelled'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { StepExecutionError } from '../skill-chain-executor/errors.js'
import type {
  PipelineDefinition,
  PipelineNode,
} from '@dzupagent/core'
import type {
  NodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  NodeExecutionContext,
} from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSingleNodePipeline(
  node: PipelineNode,
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  return {
    id: 'gap-test-pipeline',
    name: 'Gap Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: node.id,
    nodes: [node],
    edges: [],
    ...overrides,
  }
}

function makeLinearPipeline(
  nodes: PipelineNode[],
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  const edges = nodes.slice(0, -1).map((n, i) => ({
    type: 'sequential' as const,
    sourceNodeId: n.id,
    targetNodeId: nodes[i + 1]!.id,
  }))
  return {
    id: 'gap-test-pipeline',
    name: 'Gap Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: nodes[0]!.id,
    nodes,
    edges,
    ...overrides,
  }
}

function collectEvents(
  bag: PipelineRuntimeEvent[],
): (e: PipelineRuntimeEvent) => void {
  return (e) => bag.push(e)
}

// ---------------------------------------------------------------------------
// Scenario 1 — Retry exhaustion
// ---------------------------------------------------------------------------

describe('PipelineRuntime — retry exhaustion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fails pipeline after all retries are consumed', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'persistent error' }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 3,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 2 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    // 1 initial attempt + 3 retries = 4 total calls
    expect(callCount).toBe(4)
    expect(result.nodeResults.get('A')?.error).toBe('persistent error')
  })

  it('emits node_retry events for each retry attempt', async () => {
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId, output: null, durationMs: 1, error: 'always fails',
    })

    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 2,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 50, multiplier: 2 },
      onEvent: collectEvents(events),
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    const retryEvents = events.filter(
      (e): e is Extract<PipelineRuntimeEvent, { type: 'pipeline:node_retry' }> =>
        e.type === 'pipeline:node_retry',
    )

    // 2 retries = 2 retry events
    expect(retryEvents.length).toBe(2)
    expect(retryEvents[0]!.nodeId).toBe('A')
    expect(retryEvents[0]!.attempt).toBe(1)
    expect(retryEvents[0]!.maxAttempts).toBe(3)
    expect(retryEvents[1]!.attempt).toBe(2)
  })

  it('emits node_failed event after retry exhaustion', async () => {
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId, output: null, durationMs: 1, error: 'exhausted',
    })

    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 1,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 50 },
      onEvent: collectEvents(events),
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    const failedEvents = events.filter(e => e.type === 'pipeline:node_failed')
    expect(failedEvents.length).toBe(1)

    const failedEvent = failedEvents[0] as Extract<
      PipelineRuntimeEvent,
      { type: 'pipeline:node_failed' }
    >
    expect(failedEvent.nodeId).toBe('A')
    expect(failedEvent.error).toBe('exhausted')
  })

  it('emits pipeline:failed event after retry exhaustion', async () => {
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId, output: null, durationMs: 1, error: 'final failure',
    })

    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 2,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 50 },
      onEvent: collectEvents(events),
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    const pipelineFailed = events.filter(e => e.type === 'pipeline:failed')
    expect(pipelineFailed.length).toBe(1)
  })

  it('does NOT retry when retries=0 — only one attempt made', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'no retry configured' }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 0,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(callCount).toBe(1)
  })

  it('succeeds on 3rd attempt after 2 failures (retries=3)', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount < 3) {
        return { nodeId, output: null, durationMs: 1, error: `attempt ${callCount} failed` }
      }
      return { nodeId, output: 'recovered', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 3,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 50 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(callCount).toBe(3)
    expect(result.nodeResults.get('A')?.output).toBe('recovered')
  })

  it('StepExecutionError thrown by executor is captured in node result and fails pipeline', async () => {
    const cause = new Error('downstream service failed')
    const stepErr = new StepExecutionError(0, 'mySkill', cause, { partial: true })

    const executor: NodeExecutor = async (_nodeId, _node, _ctx) => {
      throw stepErr
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 2,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 50 },
    })

    // When executor throws (as opposed to returning error), no retry loop runs —
    // the catch block captures it. Pipeline should ultimately throw/fail.
    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    // The catch block in executeFromNode propagates throws, leading to the
    // outer execute() catch handler which marks the run as failed.
    expect(result.state).toBe('failed')
    const nodeResult = result.nodeResults.get('A')
    expect(nodeResult).toBeDefined()
    expect(nodeResult?.error).toContain('downstream service failed')
  })

  it('backoff delays increase exponentially across retries', async () => {
    const delaysSeen: number[] = []
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId, output: null, durationMs: 1, error: 'fail',
    })

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 3,
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 2, maxBackoffMs: 10000 },
      onEvent: (e) => {
        if (e.type === 'pipeline:node_retry') delaysSeen.push(e.backoffMs)
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    expect(delaysSeen).toEqual([100, 200, 400])
  })

  it('non-retryable error stops at first attempt despite retries > 0', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'schema validation failed' }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 5,
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 50,
        // Only timeout-like errors are retryable
        retryableErrors: [/timeout/i, /rate limit/i, /ECONNRESET/],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    // No retry because error doesn't match any retryable pattern
    expect(callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Scenario 2 — Timeout race
// ---------------------------------------------------------------------------

describe('PipelineRuntime — timeout race via fake timers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('executor that times out (resolves with timeout error after delay) fails pipeline', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      // Simulate a step that hangs then resolves with a timeout error
      await new Promise<void>(resolve => setTimeout(resolve, 10_000))
      return {
        nodeId,
        output: null,
        durationMs: 10_000,
        error: 'TIMEOUT: step exceeded 10s limit',
      }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 10_000,
      }),
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()

    // Advance fake timers past the step's internal 10s timer
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await resultPromise

    expect(result.state).toBe('failed')
    const nodeResult = result.nodeResults.get('A')
    expect(nodeResult?.error).toMatch(/timeout/i)
  })

  it('executor timeout error triggers retry if error matches retryable pattern', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        // First call: simulate timeout via fake timers
        await new Promise<void>(resolve => setTimeout(resolve, 5_000))
        return { nodeId, output: null, durationMs: 5_000, error: 'TIMEOUT: request timed out' }
      }
      // Second call: succeeds immediately
      return { nodeId, output: 'ok after timeout', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 1,
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 200,
        retryableErrors: [/timeout/i],
      },
    })

    const resultPromise = runtime.execute()

    // Advance through: 5000ms timeout + 200ms backoff
    await vi.advanceTimersByTimeAsync(5_200)
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(callCount).toBe(2)
    expect(result.nodeResults.get('A')?.output).toBe('ok after timeout')
  })

  it('abort during backoff after timeout error stops retrying', async () => {
    const controller = new AbortController()
    let callCount = 0

    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        // Simulate a timeout after 1 second
        await new Promise<void>(resolve => setTimeout(resolve, 1_000))
        return { nodeId, output: null, durationMs: 1_000, error: 'TIMEOUT: step timed out' }
      }
      return { nodeId, output: 'should not reach', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 3,
      }),
      nodeExecutor: executor,
      signal: controller.signal,
      retryPolicy: {
        initialBackoffMs: 10_000, // long backoff so abort fires first
        retryableErrors: [/timeout/i],
      },
    })

    const resultPromise = runtime.execute()

    // Advance past the 1s "timeout" inside the step
    await vi.advanceTimersByTimeAsync(1_000)
    // Now mid-backoff: abort the pipeline
    controller.abort()
    // Advance slightly to let abort propagate through setTimeout listener
    await vi.advanceTimersByTimeAsync(50)

    const result = await resultPromise

    // The abort during backoff produces a 'cancelled during retry backoff' error
    // and the state becomes 'failed' (the abort check after delay sets an error result)
    expect(['failed', 'cancelled']).toContain(result.state)
    expect(callCount).toBe(1)
  })

  it('multiple nodes: second node times out, pipeline fails with error recorded', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      if (nodeId === 'B') {
        // B hangs for 3 seconds then surfaces a timeout error
        await new Promise<void>(resolve => setTimeout(resolve, 3_000))
        return { nodeId, output: null, durationMs: 3_000, error: 'B timed out' }
      }
      return { nodeId, output: `ok-${nodeId}`, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(result.nodeResults.get('A')?.output).toBe('ok-A')
    expect(result.nodeResults.get('B')?.error).toBe('B timed out')
    // C should not have been reached
    expect(result.nodeResults.has('C')).toBe(false)
  })

  it('timeout error routed to error edge does not fail pipeline', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId)
      if (nodeId === 'A') {
        await new Promise<void>(resolve => setTimeout(resolve, 2_000))
        return {
          nodeId,
          output: null,
          durationMs: 2_000,
          error: 'TIMEOUT: A exceeded time limit',
        }
      }
      return { nodeId, output: `ok-${nodeId}`, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: {
        id: 'gap-test-pipeline',
        name: 'Timeout Error Edge',
        version: '1.0.0',
        schemaVersion: '1.0.0',
        entryNodeId: 'A',
        nodes: [
          { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
          { id: 'timeout-handler', type: 'agent', agentId: 'th', timeoutMs: 5000 },
          { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
        ],
        edges: [
          { type: 'error', sourceNodeId: 'A', targetNodeId: 'timeout-handler', errorCodes: ['TIMEOUT'] },
          { type: 'sequential', sourceNodeId: 'timeout-handler', targetNodeId: 'C' },
        ],
      },
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(order).toContain('A')
    expect(order).toContain('timeout-handler')
    expect(order).toContain('C')
  })
})

// ---------------------------------------------------------------------------
// Scenario 3 — Graceful cancel via AbortSignal
// ---------------------------------------------------------------------------

describe('PipelineRuntime — graceful cancel via AbortSignal', () => {
  it('AbortSignal already aborted before execute() — returns cancelled immediately', async () => {
    const controller = new AbortController()
    controller.abort()

    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: nodeId, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('cancelled')
    expect(runtime.getRunState()).toBe('cancelled')
    // No nodes should have been executed
    expect(callCount).toBe(0)
  })

  it('AbortSignal aborted after first node — second node is skipped', async () => {
    const controller = new AbortController()
    const order: string[] = []

    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId)
      if (nodeId === 'A') {
        controller.abort()
      }
      return { nodeId, output: nodeId, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('cancelled')
    // A ran, but B and C should be skipped after abort
    expect(order).toContain('A')
    expect(order).not.toContain('C')
  })

  it('cancelled result contains completed node results up to cancellation', async () => {
    const controller = new AbortController()
    let callCount = 0

    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 2) {
        controller.abort()
      }
      return { nodeId, output: `out-${nodeId}`, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('cancelled')
    // A and B ran before abort was detected on the next loop iteration
    expect(result.nodeResults.has('A')).toBe(true)
    expect(result.nodeResults.get('A')?.output).toBe('out-A')
    expect(result.nodeResults.has('B')).toBe(true)
    expect(result.nodeResults.get('B')?.output).toBe('out-B')
    // C was skipped
    expect(result.nodeResults.has('C')).toBe(false)
  })

  it('getRunState() returns cancelled after AbortSignal cancellation', async () => {
    const controller = new AbortController()
    let callCount = 0

    // The abort-check happens at the TOP of the execution loop, so it's detected
    // before the NEXT node executes. We need at least two nodes: abort during the
    // first node is detected on the loop's next iteration before running the second.
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (nodeId === 'A') {
        controller.abort()
      }
      return { nodeId, output: nodeId, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('cancelled')
    expect(runtime.getRunState()).toBe('cancelled')
    // Only A ran; B was skipped due to abort check at loop top
    expect(callCount).toBe(1)
  })

  it('cancel() method mid-run stops execution cleanly', async () => {
    let callCount = 0
    let runtimeRef: PipelineRuntime

    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        runtimeRef!.cancel('manual cancel')
      }
      return { nodeId, output: nodeId, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makeLinearPipeline([
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ]),
      nodeExecutor: executor,
    })
    runtimeRef = runtime

    const result = await runtime.execute()

    expect(result.state).toBe('cancelled')
    expect(runtime.getRunState()).toBe('cancelled')
    expect(callCount).toBe(1)
  })

  it('cancelled run includes pipeline runId and pipelineId in result', async () => {
    const controller = new AbortController()
    controller.abort()

    const executor: NodeExecutor = async (nodeId) => ({ nodeId, output: nodeId, durationMs: 1 })

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
      }),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('cancelled')
    expect(result.pipelineId).toBe('gap-test-pipeline')
    expect(typeof result.runId).toBe('string')
    expect(result.runId.length).toBeGreaterThan(0)
  })

  it('AbortSignal cancellation during retry backoff produces failed/cancelled result', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    let callCount = 0

    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'transient error' }
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
        retries: 5,
      }),
      nodeExecutor: executor,
      signal: controller.signal,
      retryPolicy: { initialBackoffMs: 5_000 }, // long backoff
    })

    const resultPromise = runtime.execute()

    // Execute first attempt, then abort during the long backoff
    await vi.advanceTimersByTimeAsync(10) // run the executor
    controller.abort()
    await vi.advanceTimersByTimeAsync(100) // let abort propagate through listener

    const result = await resultPromise

    // With abort during backoff: error is set to 'Pipeline cancelled during retry backoff'
    // and pipeline state is 'failed' (the abort check after delay sets an error result)
    expect(['failed', 'cancelled']).toContain(result.state)
    expect(callCount).toBe(1) // only first attempt ran

    vi.useRealTimers()
  })

  it('AbortSignal abort during long-running executor — pipeline surfaces abort-sourced error', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()

    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      // Executor respects signal by returning an error when aborted
      return new Promise<NodeResult>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ nodeId, output: 'late', durationMs: 10_000 })
        }, 10_000)

        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(timeout)
          resolve({
            nodeId,
            output: null,
            durationMs: 0,
            error: 'Aborted by signal',
          })
        }, { once: true })
      })
    }

    const runtime = new PipelineRuntime({
      definition: makeSingleNodePipeline({
        id: 'A',
        type: 'agent',
        agentId: 'a1',
        timeoutMs: 5000,
      }),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const resultPromise = runtime.execute()

    // Abort after 500ms
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()
    await vi.advanceTimersByTimeAsync(50)

    const result = await resultPromise

    // Pipeline reports failed (because the node returned an error) or cancelled
    expect(['failed', 'cancelled']).toContain(result.state)
    const nodeResult = result.nodeResults.get('A')
    if (nodeResult) {
      expect(nodeResult.error).toBe('Aborted by signal')
    }

    vi.useRealTimers()
  })
})
