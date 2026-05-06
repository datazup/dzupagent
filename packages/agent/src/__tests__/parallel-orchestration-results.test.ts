import { describe, expect, it, vi } from 'vitest'
import {
  recordParallelCircuitBreakerOutcomes,
  renderMergedParallelOutput,
  toParallelAgentResults,
} from '../orchestration/parallel-orchestration-results.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'

function createBreakerSpy(): AgentCircuitBreaker & {
  recordSuccess: ReturnType<typeof vi.fn>
  recordFailure: ReturnType<typeof vi.fn>
  recordTimeout: ReturnType<typeof vi.fn>
} {
  return {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordTimeout: vi.fn(),
    filterAvailable: vi.fn((agents) => agents),
    getState: vi.fn(() => 'closed'),
  } as unknown as AgentCircuitBreaker & {
    recordSuccess: ReturnType<typeof vi.fn>
    recordFailure: ReturnType<typeof vi.fn>
    recordTimeout: ReturnType<typeof vi.fn>
  }
}

describe('parallel orchestration result helpers', () => {
  it('records success, timeout, and generic failure into the circuit breaker', () => {
    const breaker = createBreakerSpy()

    recordParallelCircuitBreakerOutcomes(
      [{ id: 'ok' }, { id: 'slow' }, { id: 'bad' }],
      [
        { status: 'fulfilled', value: { content: 'done' } },
        { status: 'rejected', reason: new Error('operation timeout exceeded') },
        { status: 'rejected', reason: new Error('connection refused') },
      ],
      breaker,
    )

    expect(breaker.recordSuccess).toHaveBeenCalledWith('ok')
    expect(breaker.recordTimeout).toHaveBeenCalledWith('slow')
    expect(breaker.recordFailure).toHaveBeenCalledWith('bad')
  })

  it('normalizes settled generate results for merge strategies', () => {
    const results = toParallelAgentResults(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        { status: 'fulfilled', value: { content: 'A' } },
        { status: 'rejected', reason: 'timeout while waiting' },
        { status: 'rejected', reason: new Error('boom') },
      ],
    )

    expect(results).toEqual([
      { agentId: 'a', status: 'success', output: 'A' },
      { agentId: 'b', status: 'timeout', error: 'timeout while waiting' },
      { agentId: 'c', status: 'error', error: 'boom' },
    ])
  })

  it('renders merge outputs with legacy AgentOrchestrator.parallel semantics', () => {
    expect(renderMergedParallelOutput({
      status: 'success',
      output: 'merged text',
      agentResults: [],
      successCount: 1,
      timeoutCount: 0,
      errorCount: 0,
    })).toBe('merged text')

    expect(renderMergedParallelOutput({
      status: 'partial',
      output: { value: 42 },
      agentResults: [],
      successCount: 1,
      timeoutCount: 0,
      errorCount: 0,
    })).toBe('{"value":42}')

    expect(renderMergedParallelOutput({
      status: 'all_failed',
      agentResults: [],
      successCount: 0,
      timeoutCount: 0,
      errorCount: 1,
    })).toBe('Merge status: all_failed (no output)')
  })
})
