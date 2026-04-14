import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  AdapterStuckDetector,
  AdapterGuardrails,
} from '../guardrails/adapter-guardrails.js'
import type { AgentEvent } from '../types.js'
import { collectEvents } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
  for (const event of events) {
    yield event
  }
}

function makeToolCallEvent(
  toolName: string,
  input: unknown = 'same-input',
): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: 'claude',
    toolName,
    input,
    timestamp: Date.now(),
  }
}

function makeCompletedEvent(
  result = 'done',
  usage?: { inputTokens: number; outputTokens: number; costCents?: number },
): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 'sess-1',
    result,
    usage,
    durationMs: 100,
    timestamp: Date.now(),
  }
}

function makeToolResultEvent(
  toolName: string,
  output: string,
): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: 'claude',
    toolName,
    output,
    durationMs: 10,
    timestamp: Date.now(),
  }
}

function makeStartedEvent(): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 'sess-1',
    timestamp: Date.now(),
  }
}

function makeFailedEvent(error = 'Something broke'): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId: 'claude',
    error,
    code: 'TEST_ERROR',
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests: AdapterStuckDetector
// ---------------------------------------------------------------------------

describe('AdapterStuckDetector', () => {
  let sut: AdapterStuckDetector

  beforeEach(() => {
    sut = new AdapterStuckDetector()
  })

  describe('recordToolCall', () => {
    it('detects repeated identical tool calls (3x same name+input)', () => {
      sut.recordToolCall('read_file', { path: '/a.ts' })
      sut.recordToolCall('read_file', { path: '/a.ts' })
      const status = sut.recordToolCall('read_file', { path: '/a.ts' })

      expect(status.stuck).toBe(true)
      expect(status.reason).toContain('read_file')
      expect(status.reason).toContain('3')
    })

    it('does not flag different tool calls', () => {
      sut.recordToolCall('read_file', { path: '/a.ts' })
      sut.recordToolCall('write_file', { path: '/b.ts' })
      const status = sut.recordToolCall('read_file', { path: '/c.ts' })

      expect(status.stuck).toBe(false)
    })

    it('does not flag same name with different input', () => {
      sut.recordToolCall('read_file', { path: '/a.ts' })
      sut.recordToolCall('read_file', { path: '/b.ts' })
      const status = sut.recordToolCall('read_file', { path: '/c.ts' })

      expect(status.stuck).toBe(false)
    })

    it('respects custom maxRepeatCalls config', () => {
      sut = new AdapterStuckDetector({ maxRepeatCalls: 2 })
      sut.recordToolCall('read_file', 'same')
      const status = sut.recordToolCall('read_file', 'same')

      expect(status.stuck).toBe(true)
    })
  })

  describe('recordError', () => {
    it('detects high error rate in window', () => {
      // Default maxErrorsInWindow = 5
      for (let i = 0; i < 4; i++) {
        const s = sut.recordError(`Error ${i}`)
        expect(s.stuck).toBe(false)
      }
      const status = sut.recordError('Error 5')
      expect(status.stuck).toBe(true)
      expect(status.reason).toContain('5')
    })
  })

  describe('recordIteration', () => {
    it('detects idle iterations (no tool calls)', () => {
      // Default maxIdleIterations = 3
      sut.recordIteration(0)
      sut.recordIteration(0)
      const status = sut.recordIteration(0)

      expect(status.stuck).toBe(true)
      expect(status.reason).toContain('3')
      expect(status.reason).toContain('no tool calls')
    })

    it('resets idle count when tool calls happen', () => {
      sut.recordIteration(0)
      sut.recordIteration(0)
      sut.recordIteration(1) // progress
      const status = sut.recordIteration(0) // only 1 idle now

      expect(status.stuck).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      sut.recordToolCall('read_file', 'same')
      sut.recordToolCall('read_file', 'same')
      sut.recordError('err')
      sut.recordIteration(0)
      sut.recordIteration(0)

      sut.reset()

      // After reset, nothing should be stuck
      const toolStatus = sut.recordToolCall('read_file', 'same')
      expect(toolStatus.stuck).toBe(false)
      const idleStatus = sut.recordIteration(0)
      expect(idleStatus.stuck).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: AdapterGuardrails
// ---------------------------------------------------------------------------

describe('AdapterGuardrails', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = []
    bus.onAny((e) => emitted.push(e))
  })

  it('passes through events when within limits', async () => {
    const guardrails = new AdapterGuardrails({ maxIterations: 10 })

    const events = [
      makeStartedEvent(),
      makeToolCallEvent('read_file', '/a.ts'),
      makeCompletedEvent('result', { inputTokens: 10, outputTokens: 5 }),
    ]

    const output = await collectEvents(guardrails.wrap(eventStream(events)))

    expect(output).toHaveLength(3)
    expect(output[0]!.type).toBe('adapter:started')
    expect(output[1]!.type).toBe('adapter:tool_call')
    expect(output[2]!.type).toBe('adapter:completed')
  })

  it('blocks forbidden tools and yields failed event', async () => {
    const abortFn = vi.fn()
    const guardrails = new AdapterGuardrails({
      blockedTools: ['dangerous_tool'],
    })

    const events = [
      makeStartedEvent(),
      makeToolCallEvent('dangerous_tool', {}),
      makeCompletedEvent(),
    ]

    const output = await collectEvents(
      guardrails.wrap(eventStream(events), abortFn),
    )

    // Should yield started + failed event (blocked)
    expect(output).toHaveLength(2)
    expect(output[0]!.type).toBe('adapter:started')
    expect(output[1]!.type).toBe('adapter:failed')
    expect((output[1]! as Extract<AgentEvent, { type: 'adapter:failed' }>).error).toContain(
      'dangerous_tool',
    )
    expect(abortFn).toHaveBeenCalled()
  })

  it('enforces maxIterations limit', async () => {
    const guardrails = new AdapterGuardrails({ maxIterations: 2 })
    const abortFn = vi.fn()

    const events = [
      makeToolCallEvent('t1', 'a'),
      makeToolCallEvent('t2', 'b'),
      makeToolCallEvent('t3', 'c'), // 3rd iteration exceeds limit of 2
    ]

    const output = await collectEvents(
      guardrails.wrap(eventStream(events), abortFn),
    )

    // First 2 pass, 3rd triggers abort
    const lastEvent = output[output.length - 1]!
    expect(lastEvent.type).toBe('adapter:failed')
    expect(
      (lastEvent as Extract<AgentEvent, { type: 'adapter:failed' }>).error,
    ).toContain('Iteration limit')
    expect(abortFn).toHaveBeenCalled()
  })

  it('enforces maxTokens limit from adapter:completed usage', async () => {
    const guardrails = new AdapterGuardrails({
      maxTokens: 100,
      maxIterations: 100,
    })
    const abortFn = vi.fn()

    const events = [
      makeCompletedEvent('r1', { inputTokens: 60, outputTokens: 50 }),
      // total = 110, over limit
    ]

    const output = await collectEvents(
      guardrails.wrap(eventStream(events), abortFn),
    )

    const lastEvent = output[output.length - 1]!
    expect(lastEvent.type).toBe('adapter:failed')
    expect(
      (lastEvent as Extract<AgentEvent, { type: 'adapter:failed' }>).error,
    ).toContain('Token limit')
    expect(abortFn).toHaveBeenCalled()
  })

  it('enforces maxCostCents limit', async () => {
    const guardrails = new AdapterGuardrails({
      maxCostCents: 5,
      maxIterations: 100,
    })
    const abortFn = vi.fn()

    const events = [
      makeCompletedEvent('r1', { inputTokens: 10, outputTokens: 5, costCents: 6 }),
    ]

    const output = await collectEvents(
      guardrails.wrap(eventStream(events), abortFn),
    )

    const lastEvent = output[output.length - 1]!
    expect(lastEvent.type).toBe('adapter:failed')
    expect(
      (lastEvent as Extract<AgentEvent, { type: 'adapter:failed' }>).error,
    ).toContain('Cost limit')
  })

  it('enforces maxDurationMs timeout', async () => {
    const guardrails = new AdapterGuardrails({
      maxDurationMs: 1, // 1ms timeout
      maxIterations: 100,
    })
    const abortFn = vi.fn()

    // Need a stream that takes some time
    async function* delayedStream(): AsyncGenerator<AgentEvent, void, undefined> {
      yield makeStartedEvent()
      await new Promise((r) => setTimeout(r, 20))
      yield makeToolCallEvent('read_file', '/a.ts')
    }

    const output = await collectEvents(
      guardrails.wrap(delayedStream(), abortFn),
    )

    const lastEvent = output[output.length - 1]!
    expect(lastEvent.type).toBe('adapter:failed')
    expect(
      (lastEvent as Extract<AgentEvent, { type: 'adapter:failed' }>).error,
    ).toContain('Timeout')
  })

  it('emits budget:warning at thresholds', async () => {
    const guardrails = new AdapterGuardrails({
      maxIterations: 10,
      warningThresholds: [0.7],
      eventBus: bus,
    })

    // Push 7 tool calls to reach 70% threshold
    const events: AgentEvent[] = []
    for (let i = 0; i < 7; i++) {
      events.push(makeToolCallEvent(`tool_${i}`, `input_${i}`))
    }
    events.push(makeCompletedEvent())

    await collectEvents(guardrails.wrap(eventStream(events)))

    const warningEvents = emitted.filter(
      (e) => 'type' in e && e.type === 'budget:warning',
    )
    expect(warningEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('emits agent:stuck_detected when stuck', async () => {
    const guardrails = new AdapterGuardrails({
      maxIterations: 100,
      eventBus: bus,
      stuckDetector: { maxRepeatCalls: 3 },
    })

    const events = [
      makeToolCallEvent('read_file', 'same'),
      makeToolCallEvent('read_file', 'same'),
      makeToolCallEvent('read_file', 'same'),
    ]

    await collectEvents(guardrails.wrap(eventStream(events)))

    const stuckEvents = emitted.filter(
      (e) => 'type' in e && e.type === 'agent:stuck_detected',
    )
    expect(stuckEvents.length).toBe(1)
  })

  it('calls abortFn on critical violation', async () => {
    const abortFn = vi.fn()
    const guardrails = new AdapterGuardrails({
      blockedTools: ['banned'],
    })

    const events = [makeToolCallEvent('banned', {})]

    await collectEvents(guardrails.wrap(eventStream(events), abortFn))

    expect(abortFn).toHaveBeenCalledTimes(1)
  })

  describe('getStatus()', () => {
    it('returns current state', async () => {
      const guardrails = new AdapterGuardrails({ maxIterations: 100 })

      const events = [
        makeToolCallEvent('t1', 'a'),
        makeToolCallEvent('t2', 'b'),
        makeCompletedEvent('done', { inputTokens: 50, outputTokens: 30 }),
      ]

      await collectEvents(guardrails.wrap(eventStream(events)))

      const status = guardrails.getStatus()
      expect(status.safe).toBe(true)
      expect(status.budgetState.iterations).toBe(2)
      expect(status.budgetState.totalInputTokens).toBe(50)
      expect(status.budgetState.totalOutputTokens).toBe(30)
    })

    it('reports unsafe after critical violation', async () => {
      const guardrails = new AdapterGuardrails({
        blockedTools: ['banned'],
      })

      const events = [makeToolCallEvent('banned', {})]
      await collectEvents(guardrails.wrap(eventStream(events)))

      const status = guardrails.getStatus()
      expect(status.safe).toBe(false)
      expect(status.violations.length).toBeGreaterThan(0)
      expect(status.violations[0]!.severity).toBe('critical')
    })
  })

  describe('reset()', () => {
    it('clears all tracking state', async () => {
      const guardrails = new AdapterGuardrails({ maxIterations: 100 })

      const events = [
        makeToolCallEvent('t1', 'a'),
        makeCompletedEvent('done', { inputTokens: 50, outputTokens: 30 }),
      ]
      await collectEvents(guardrails.wrap(eventStream(events)))

      guardrails.reset()

      const status = guardrails.getStatus()
      expect(status.safe).toBe(true)
      expect(status.violations).toHaveLength(0)
      expect(status.budgetState.iterations).toBe(0)
      expect(status.budgetState.totalInputTokens).toBe(0)
      expect(status.budgetState.totalOutputTokens).toBe(0)
    })
  })

  describe('output filter', () => {
    it('applies output filter on completion and modifies result', async () => {
      const guardrails = new AdapterGuardrails({
        maxIterations: 100,
        outputFilter: async (output: string) => output.replace('bad', '***'),
      })

      const events = [
        makeCompletedEvent('This is bad content', {
          inputTokens: 10,
          outputTokens: 5,
        }),
      ]

      const output = await collectEvents(guardrails.wrap(eventStream(events)))

      expect(output).toHaveLength(1)
      const completed = output[0] as Extract<AgentEvent, { type: 'adapter:completed' }>
      expect(completed.result).toBe('This is *** content')
    })

    it('rejects output when filter returns null', async () => {
      const abortFn = vi.fn()
      const guardrails = new AdapterGuardrails({
        maxIterations: 100,
        outputFilter: async () => null,
      })

      const events = [
        makeCompletedEvent('toxic content', {
          inputTokens: 10,
          outputTokens: 5,
        }),
      ]

      const output = await collectEvents(
        guardrails.wrap(eventStream(events), abortFn),
      )

      const lastEvent = output[output.length - 1]!
      expect(lastEvent.type).toBe('adapter:failed')
      expect(
        (lastEvent as Extract<AgentEvent, { type: 'adapter:failed' }>).error,
      ).toContain('content filter')
      expect(abortFn).toHaveBeenCalled()
    })
  })

  it('disables stuck detector when stuckDetector is false', async () => {
    const guardrails = new AdapterGuardrails({
      maxIterations: 100,
      stuckDetector: false,
    })

    // 3 identical calls should NOT trigger stuck detection
    const events = [
      makeToolCallEvent('read_file', 'same'),
      makeToolCallEvent('read_file', 'same'),
      makeToolCallEvent('read_file', 'same'),
      makeCompletedEvent(),
    ]

    const output = await collectEvents(guardrails.wrap(eventStream(events)))

    // All 4 events should pass through (no abort)
    expect(output).toHaveLength(4)
  })
})
