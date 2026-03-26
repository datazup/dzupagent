import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import type {
  PipelineDefinition,
  PipelineNode,
} from '@forgeagent/core'
import type {
  NodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  NodeExecutionContext,
} from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  return {
    id: 'test-pipeline',
    name: 'Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'A',
    nodes: [
      { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
    ],
    edges: [],
    ...overrides,
  }
}

function collectEvents(events: PipelineRuntimeEvent[]): (event: PipelineRuntimeEvent) => void {
  return (event) => { events.push(event) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineRuntime — node retry with exponential backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('no retries configured (retries=0) — single attempt, fails on error', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'transient failure' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 0 }],
      }),
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(result.nodeResults.get('A')?.error).toBe('transient failure')
  })

  it('no retries configured (retries=undefined) — single attempt, fails on error', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'transient failure' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(result.nodeResults.get('A')?.error).toBe('transient failure')
  })

  it('retry succeeds on 2nd attempt', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        return { nodeId, output: null, durationMs: 1, error: 'API timeout' }
      }
      return { nodeId, output: 'success', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(result.nodeResults.get('A')?.output).toBe('success')
    expect(result.nodeResults.get('A')?.error).toBeUndefined()
    expect(callCount).toBe(2)
  })

  it('retry exhausted — routes to error edge', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId)
      if (nodeId === 'A') {
        return { nodeId, output: null, durationMs: 1, error: 'persistent failure' }
      }
      return { nodeId, output: 'handled', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [
          { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 1 },
          { id: 'err-handler', type: 'agent', agentId: 'err', timeoutMs: 5000 },
        ],
        edges: [
          { type: 'error', sourceNodeId: 'A', targetNodeId: 'err-handler' },
        ],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    // A called twice (initial + 1 retry), then error handler
    expect(order).toEqual(['A', 'A', 'err-handler'])
  })

  it('retry exhausted, no error edge — pipeline fails', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'always fails' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(callCount).toBe(3) // 1 initial + 2 retries
  })

  it('exponential backoff — delay increases with each attempt', async () => {
    const delays: number[] = []
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 2, maxBackoffMs: 1000 },
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // 3 retries = 3 retry events with increasing backoff
    expect(delays).toEqual([100, 200, 400])
    expect(callCount).toBe(4) // 1 initial + 3 retries
  })

  it('exponential backoff — capped at maxBackoffMs', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 4 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 3, maxBackoffMs: 500 },
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // 100, 300, 500 (capped), 500 (capped)
    expect(delays).toEqual([100, 300, 500, 500])
  })

  it('abort during retry — cancels retry wait', async () => {
    const controller = new AbortController()
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        // Abort after first failure, during backoff wait
        setTimeout(() => controller.abort(), 50)
        return { nodeId, output: null, durationMs: 1, error: 'transient' }
      }
      return { nodeId, output: 'should not reach', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      signal: controller.signal,
      retryPolicy: { initialBackoffMs: 5000 },
    })

    const resultPromise = runtime.execute()
    // Advance past the abort timeout (50ms) but not the full backoff (5000ms)
    await vi.advanceTimersByTimeAsync(100)
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(result.nodeResults.get('A')?.error).toBe('Pipeline cancelled during retry backoff')
    expect(callCount).toBe(1) // Only 1 attempt — aborted during backoff
  })

  it('non-retryable error — no retry when error does not match retryableErrors', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'validation error: bad input' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 100,
        retryableErrors: [/timeout/i, /rate limit/i],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(callCount).toBe(1) // No retry — error didn't match patterns
  })

  it('retryable error pattern matches — does retry', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount < 3) {
        return { nodeId, output: null, durationMs: 1, error: 'Request timeout after 30s' }
      }
      return { nodeId, output: 'ok', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 100,
        retryableErrors: [/timeout/i, /rate limit/i],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(callCount).toBe(3)
  })

  it('pipeline:node_retry event emitted with correct fields', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount <= 2) {
        return { nodeId, output: null, durationMs: 1, error: `fail-${callCount}` }
      }
      return { nodeId, output: 'ok', durationMs: 1 }
    }

    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 200, multiplier: 2 },
      onEvent: collectEvents(events),
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    const retryEvents = events.filter(
      (e): e is Extract<PipelineRuntimeEvent, { type: 'pipeline:node_retry' }> =>
        e.type === 'pipeline:node_retry',
    )

    expect(retryEvents.length).toBe(2)

    // First retry
    expect(retryEvents[0]).toEqual({
      type: 'pipeline:node_retry',
      nodeId: 'A',
      attempt: 1,
      maxAttempts: 4,
      error: 'fail-1',
      backoffMs: 200,
    })

    // Second retry
    expect(retryEvents[1]).toEqual({
      type: 'pipeline:node_retry',
      nodeId: 'A',
      attempt: 2,
      maxAttempts: 4,
      error: 'fail-2',
      backoffMs: 400,
    })
  })

  it('durationMs in final result reflects total time including retries', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        return { nodeId, output: null, durationMs: 50, error: 'fail' }
      }
      return { nodeId, output: 'ok', durationMs: 50 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 1 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 500 },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    // durationMs should be >= 500 (backoff time) since we used fake timers
    const nodeDuration = result.nodeResults.get('A')?.durationMs ?? 0
    expect(nodeDuration).toBeGreaterThanOrEqual(500)
  })

  it('retry does not apply to special node types (suspend, gate, fork, loop)', async () => {
    // Suspend nodes with retries should still suspend, not retry
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [
          { id: 'A', type: 'suspend', timeoutMs: 5000, retries: 3 },
        ],
      }),
      nodeExecutor: executor,
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('suspended')
  })

  it('retryableErrors with string patterns — matches via includes()', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        return { nodeId, output: null, durationMs: 1, error: 'connection timeout after 30s' }
      }
      return { nodeId, output: 'ok', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 100,
        retryableErrors: ['timeout', 'ECONNRESET'],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(callCount).toBe(2) // retried because error includes 'timeout'
  })

  it('retryableErrors with string patterns — non-matching string skips retry', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      return { nodeId, output: null, durationMs: 1, error: 'validation failed' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 100,
        retryableErrors: ['timeout', 'ECONNRESET'],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('failed')
    expect(callCount).toBe(1) // no retry — error doesn't include any pattern
  })

  it('retryableErrors with mixed string and RegExp patterns', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        return { nodeId, output: null, durationMs: 1, error: 'Rate Limit Exceeded' }
      }
      return { nodeId, output: 'ok', durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: {
        initialBackoffMs: 100,
        retryableErrors: ['timeout', /rate limit/i],
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.state).toBe('completed')
    expect(callCount).toBe(2) // matched via RegExp
  })

  it('backoffMultiplier alias works when multiplier is not set', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 3 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, backoffMultiplier: 3, maxBackoffMs: 5000 },
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // 100, 300, 900
    expect(delays).toEqual([100, 300, 900])
  })

  it('multiplier takes precedence over backoffMultiplier', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 2, backoffMultiplier: 10 },
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // multiplier=2 takes precedence: 100, 200
    expect(delays).toEqual([100, 200])
  })

  it('default retry policy (no retryPolicy config) uses sensible defaults', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      // No retryPolicy — uses defaults (initialBackoffMs=1000, multiplier=2, maxBackoffMs=30000)
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    expect(delays).toEqual([1000, 2000]) // default: 1000ms initial, 2x multiplier
  })
})
