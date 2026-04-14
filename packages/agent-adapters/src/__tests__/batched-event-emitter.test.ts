import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BatchedEventEmitter } from '../utils/batched-event-emitter.js'
import type { DzupEventBus, DzupEvent } from '@dzupagent/core'

function createMockBus(): DzupEventBus & { emitted: DzupEvent[] } {
  const emitted: DzupEvent[] = []
  return {
    emitted,
    emit(event: DzupEvent) { emitted.push(event) },
    on() { return () => {} },
    once() { return () => {} },
    onAny() { return () => {} },
  } as DzupEventBus & { emitted: DzupEvent[] }
}

describe('BatchedEventEmitter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('emits critical events immediately', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus)

    emitter.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(bus.emitted).toHaveLength(1)

    emitter.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })
    expect(bus.emitted).toHaveLength(2)

    emitter.emit({ type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'ERR_UNKNOWN' as never, message: 'fail' })
    expect(bus.emitted).toHaveLength(3)

    emitter.dispose()
  })

  it('batches non-critical events', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus, { maxDelayMs: 100 })

    emitter.emit({ type: 'tool:called', toolName: 'test', input: {} })
    emitter.emit({ type: 'tool:result', toolName: 'test', durationMs: 50 })

    // Not emitted yet
    expect(bus.emitted).toHaveLength(0)
    expect(emitter.queueSize).toBe(2)

    // After delay, flushed
    vi.advanceTimersByTime(150)
    expect(bus.emitted).toHaveLength(2)
    expect(emitter.queueSize).toBe(0)

    emitter.dispose()
  })

  it('flushes when batch size reached', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus, { maxBatchSize: 3 })

    emitter.emit({ type: 'tool:called', toolName: 'a', input: {} })
    emitter.emit({ type: 'tool:called', toolName: 'b', input: {} })
    expect(bus.emitted).toHaveLength(0)

    emitter.emit({ type: 'tool:called', toolName: 'c', input: {} })
    expect(bus.emitted).toHaveLength(3)

    emitter.dispose()
  })

  it('flush() empties queue immediately', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus)

    emitter.emit({ type: 'tool:called', toolName: 'a', input: {} })
    emitter.emit({ type: 'tool:called', toolName: 'b', input: {} })
    expect(bus.emitted).toHaveLength(0)

    emitter.flush()
    expect(bus.emitted).toHaveLength(2)
    expect(emitter.queueSize).toBe(0)

    emitter.dispose()
  })

  it('dispose() flushes and stops timer', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus)

    emitter.emit({ type: 'tool:called', toolName: 'a', input: {} })
    emitter.dispose()
    expect(bus.emitted).toHaveLength(1) // Flushed on dispose
  })

  it('approval events are immediate', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus)

    emitter.emit({ type: 'approval:requested', runId: 'r1', plan: {} })
    expect(bus.emitted).toHaveLength(1)

    emitter.emit({ type: 'budget:exceeded', reason: 'over', usage: { tokensUsed: 0, tokensLimit: 0, costCents: 0, costLimitCents: 0, iterations: 0, iterationsLimit: 0, percent: 100 } })
    expect(bus.emitted).toHaveLength(2)

    emitter.dispose()
  })

  it('custom immediate patterns work', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus, {
      immediatePatterns: ['mcp:connected'],
    })

    emitter.emit({ type: 'mcp:connected', serverName: 's1', toolCount: 3 })
    expect(bus.emitted).toHaveLength(1)

    // agent:started is NOT in custom list, so batched
    emitter.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(bus.emitted).toHaveLength(1)

    emitter.dispose()
  })

  it('recovery prefix events are immediate', () => {
    const bus = createMockBus()
    const emitter = new BatchedEventEmitter(bus)

    emitter.emit({ type: 'recovery:cancelled', agentId: 'a1', runId: 'r1', attempts: 3, durationMs: 500, reason: 'timeout' })
    expect(bus.emitted).toHaveLength(1)

    emitter.dispose()
  })
})
