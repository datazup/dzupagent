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
  RetryPolicy,
} from '../pipeline/pipeline-runtime-types.js'
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoff,
  isRetryable,
  resolveRetryPolicy,
} from '../pipeline/retry-policy.js'

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

  it('jitter adds randomness to backoff delays', async () => {
    // Seed Math.random to produce predictable jitter
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5) // 0.5 * 0.5 = 25% jitter

    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000, retries: 2 }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 100, multiplier: 2, jitter: true },
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // With Math.random() = 0.5 => jitter factor = 0.25
    // Attempt 1: base=100, jittered = 100 + 100*0.25 = 125
    // Attempt 2: base=200, jittered = 200 + 200*0.25 = 250
    expect(delays).toEqual([125, 250])

    randomSpy.mockRestore()
  })

  it('per-node retryPolicy overrides global retryPolicy', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{
          id: 'A',
          type: 'agent',
          agentId: 'a1',
          timeoutMs: 5000,
          retries: 2,
          retryPolicy: { initialBackoffMs: 50, multiplier: 3 },
        }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 1000, multiplier: 2 }, // global — should be overridden
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // Node policy: initialBackoffMs=50, multiplier=3
    // Attempt 1: 50, Attempt 2: 150
    expect(delays).toEqual([50, 150])
  })

  it('per-node retryPolicy merges with global — node overrides only set fields', async () => {
    const delays: number[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: null, durationMs: 1, error: 'fail' }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{
          id: 'A',
          type: 'agent',
          agentId: 'a1',
          timeoutMs: 5000,
          retries: 2,
          // Only override initialBackoffMs, inherit multiplier from global
          retryPolicy: { initialBackoffMs: 50 },
        }],
      }),
      nodeExecutor: executor,
      retryPolicy: { initialBackoffMs: 1000, multiplier: 3 },
      onEvent: (event) => {
        if (event.type === 'pipeline:node_retry') {
          delays.push(event.backoffMs)
        }
      },
    })

    const resultPromise = runtime.execute()
    await vi.runAllTimersAsync()
    await resultPromise

    // Node: initialBackoffMs=50 (override), multiplier=3 (from global)
    // Attempt 1: 50, Attempt 2: 150
    expect(delays).toEqual([50, 150])
  })
})

// ---------------------------------------------------------------------------
// Standalone utility function tests
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('returns initialBackoffMs for attempt 1', () => {
    expect(calculateBackoff(1, { initialBackoffMs: 500 })).toBe(500)
  })

  it('applies exponential multiplier', () => {
    const policy: RetryPolicy = { initialBackoffMs: 100, multiplier: 2 }
    expect(calculateBackoff(1, policy)).toBe(100)
    expect(calculateBackoff(2, policy)).toBe(200)
    expect(calculateBackoff(3, policy)).toBe(400)
    expect(calculateBackoff(4, policy)).toBe(800)
  })

  it('caps at maxBackoffMs', () => {
    const policy: RetryPolicy = { initialBackoffMs: 100, multiplier: 10, maxBackoffMs: 500 }
    expect(calculateBackoff(1, policy)).toBe(100)
    expect(calculateBackoff(2, policy)).toBe(500) // 1000 capped to 500
    expect(calculateBackoff(3, policy)).toBe(500) // 10000 capped to 500
  })

  it('uses defaults when no policy provided', () => {
    // Default: initialBackoffMs=1000, multiplier=2, maxBackoffMs=30000
    expect(calculateBackoff(1)).toBe(1000)
    expect(calculateBackoff(2)).toBe(2000)
    expect(calculateBackoff(3)).toBe(4000)
  })

  it('adds jitter when enabled', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.4) // 0.4 * 0.5 = 20% jitter
    const policy: RetryPolicy = { initialBackoffMs: 100, multiplier: 2, jitter: true }

    const result = calculateBackoff(1, policy)
    // base=100, jitter = 100 * 0.2 = 20, total = 120
    expect(result).toBe(120)

    randomSpy.mockRestore()
  })

  it('jitter disabled by default', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const policy: RetryPolicy = { initialBackoffMs: 100, multiplier: 2 }

    // No jitter: should be exactly 100 regardless of Math.random
    expect(calculateBackoff(1, policy)).toBe(100)
    randomSpy.mockRestore()
  })

  it('jitter produces values in expected range [base, base*1.5]', () => {
    const policy: RetryPolicy = { initialBackoffMs: 1000, multiplier: 1, jitter: true }

    // Min jitter (Math.random=0): base * 1.0 = 1000
    const spy1 = vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(calculateBackoff(1, policy)).toBe(1000)
    spy1.mockRestore()

    // Max jitter (Math.random=1): base * 1.5 = 1500
    const spy2 = vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(calculateBackoff(1, policy)).toBe(1500)
    spy2.mockRestore()
  })

  it('respects backoffMultiplier alias when multiplier is not set', () => {
    const policy: RetryPolicy = { initialBackoffMs: 100, backoffMultiplier: 5 }
    expect(calculateBackoff(1, policy)).toBe(100)
    expect(calculateBackoff(2, policy)).toBe(500)
  })
})

describe('isRetryable', () => {
  it('returns true when no retryableErrors defined (all errors retryable)', () => {
    expect(isRetryable('anything', {})).toBe(true)
    expect(isRetryable('anything')).toBe(true)
    expect(isRetryable('anything', { retryableErrors: [] })).toBe(true)
  })

  it('matches string patterns via includes()', () => {
    const policy: RetryPolicy = { retryableErrors: ['timeout', 'ECONNRESET'] }
    expect(isRetryable('Request timeout after 30s', policy)).toBe(true)
    expect(isRetryable('ECONNRESET: connection reset', policy)).toBe(true)
    expect(isRetryable('validation failed', policy)).toBe(false)
  })

  it('matches RegExp patterns via test()', () => {
    const policy: RetryPolicy = { retryableErrors: [/rate.?limit/i, /429/] }
    expect(isRetryable('Rate Limit Exceeded', policy)).toBe(true)
    expect(isRetryable('HTTP 429 Too Many Requests', policy)).toBe(true)
    expect(isRetryable('validation error', policy)).toBe(false)
  })

  it('supports mixed string and RegExp patterns', () => {
    const policy: RetryPolicy = { retryableErrors: ['ECONNREFUSED', /timeout/i] }
    expect(isRetryable('connect ECONNREFUSED 127.0.0.1:3000', policy)).toBe(true)
    expect(isRetryable('Request Timeout', policy)).toBe(true)
    expect(isRetryable('syntax error', policy)).toBe(false)
  })
})

describe('resolveRetryPolicy', () => {
  it('returns undefined when both inputs are undefined', () => {
    expect(resolveRetryPolicy(undefined, undefined)).toBeUndefined()
  })

  it('returns global policy when node policy is undefined', () => {
    const global: RetryPolicy = { initialBackoffMs: 500 }
    expect(resolveRetryPolicy(undefined, global)).toBe(global)
  })

  it('returns node policy when global policy is undefined', () => {
    const node: RetryPolicy = { initialBackoffMs: 200 }
    expect(resolveRetryPolicy(node, undefined)).toBe(node)
  })

  it('merges node over global — node values take precedence', () => {
    const global: RetryPolicy = { initialBackoffMs: 1000, multiplier: 2, maxBackoffMs: 30000 }
    const node: RetryPolicy = { initialBackoffMs: 50 }

    const merged = resolveRetryPolicy(node, global)
    expect(merged).toEqual({
      initialBackoffMs: 50,       // from node
      multiplier: 2,              // from global
      maxBackoffMs: 30000,        // from global
      backoffMultiplier: undefined,
      jitter: undefined,
      retryableErrors: undefined,
    })
  })

  it('node jitter overrides global jitter', () => {
    const global: RetryPolicy = { jitter: false }
    const node: RetryPolicy = { jitter: true }

    const merged = resolveRetryPolicy(node, global)
    expect(merged?.jitter).toBe(true)
  })

  it('node retryableErrors override global retryableErrors', () => {
    const global: RetryPolicy = { retryableErrors: [/timeout/i] }
    const node: RetryPolicy = { retryableErrors: ['ECONNRESET'] }

    const merged = resolveRetryPolicy(node, global)
    expect(merged?.retryableErrors).toEqual(['ECONNRESET'])
  })
})

describe('DEFAULT_RETRY_POLICY', () => {
  it('has expected default values', () => {
    expect(DEFAULT_RETRY_POLICY.initialBackoffMs).toBe(1000)
    expect(DEFAULT_RETRY_POLICY.maxBackoffMs).toBe(30000)
    expect(DEFAULT_RETRY_POLICY.multiplier).toBe(2)
    expect(DEFAULT_RETRY_POLICY.jitter).toBe(true)
  })

  it('has retryable error patterns for common transient failures', () => {
    const patterns = DEFAULT_RETRY_POLICY.retryableErrors!
    expect(patterns.length).toBeGreaterThan(0)

    // Test that default patterns match common transient errors
    const matchesAny = (error: string) =>
      patterns.some(p => typeof p === 'string' ? error.includes(p) : p.test(error))

    expect(matchesAny('HTTP 429 Too Many Requests')).toBe(true)
    expect(matchesAny('Rate limit exceeded')).toBe(true)
    expect(matchesAny('Request timeout after 30s')).toBe(true)
    expect(matchesAny('connect ECONNRESET')).toBe(true)
    expect(matchesAny('connect ECONNREFUSED 127.0.0.1:3000')).toBe(true)
    expect(matchesAny('ETIMEDOUT')).toBe(true)
    expect(matchesAny('socket hang up')).toBe(true)

    // Non-transient errors should not match
    expect(matchesAny('SyntaxError: unexpected token')).toBe(false)
    expect(matchesAny('validation failed')).toBe(false)
  })
})
