import { describe, it, expect, vi, afterEach } from 'vitest'

import { ExecutionTraceCapture } from '../recovery/adapter-recovery.js'
import type { AgentInput } from '../types.js'

describe('ExecutionTraceCapture eviction', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('should evict traces after TTL expires', () => {
    vi.useFakeTimers()
    const capture = new ExecutionTraceCapture({ ttlMs: 1000, sweepIntervalMs: 500 })
    const trace = capture.startTrace({ prompt: 'test' } as AgentInput)
    expect(capture.getTrace(trace.traceId)).toBeDefined()

    vi.advanceTimersByTime(1500)

    expect(capture.getTrace(trace.traceId)).toBeUndefined()
    capture.dispose()
  })

  it('should enforce max traces', () => {
    const capture = new ExecutionTraceCapture({ maxTraces: 2 })
    capture.startTrace({ prompt: 'a' } as AgentInput)
    capture.startTrace({ prompt: 'b' } as AgentInput)
    capture.startTrace({ prompt: 'c' } as AgentInput)
    expect(capture.getAllTraces().length).toBeLessThanOrEqual(2)
    capture.dispose()
  })

  it('should evict oldest traces first', () => {
    const capture = new ExecutionTraceCapture({ maxTraces: 1 })
    const t1 = capture.startTrace({ prompt: 'first' } as AgentInput)
    const t2 = capture.startTrace({ prompt: 'second' } as AgentInput)
    expect(capture.getTrace(t1.traceId)).toBeUndefined()
    expect(capture.getTrace(t2.traceId)).toBeDefined()
    capture.dispose()
  })

  it('dispose should stop sweep timer', () => {
    vi.useFakeTimers()
    const capture = new ExecutionTraceCapture({ sweepIntervalMs: 100 })
    capture.dispose()
    // Should not throw when timer fires
    vi.advanceTimersByTime(200)
  })

  it('clear should also clear createdAt tracking', () => {
    const capture = new ExecutionTraceCapture({ maxTraces: 5 })
    capture.startTrace({ prompt: 'a' } as AgentInput)
    capture.startTrace({ prompt: 'b' } as AgentInput)
    expect(capture.getAllTraces()).toHaveLength(2)

    capture.clear()
    expect(capture.getAllTraces()).toHaveLength(0)

    // After clear, adding new traces should work without stale createdAt entries
    capture.startTrace({ prompt: 'c' } as AgentInput)
    expect(capture.getAllTraces()).toHaveLength(1)
    capture.dispose()
  })

  it('should keep traces within TTL during sweep', () => {
    vi.useFakeTimers()
    const capture = new ExecutionTraceCapture({ ttlMs: 2000, sweepIntervalMs: 500 })
    const trace = capture.startTrace({ prompt: 'recent' } as AgentInput)

    // Advance past one sweep but before TTL expires
    vi.advanceTimersByTime(600)
    expect(capture.getTrace(trace.traceId)).toBeDefined()

    capture.dispose()
  })

  it('should use default config when none provided', () => {
    const capture = new ExecutionTraceCapture()
    // Should be able to add many traces without eviction kicking in (default max is 1000)
    for (let i = 0; i < 50; i++) {
      capture.startTrace({ prompt: `trace-${String(i)}` } as AgentInput)
    }
    expect(capture.getAllTraces()).toHaveLength(50)
    capture.dispose()
  })
})
