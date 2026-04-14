import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  ExecutionTraceCapture,
  AdapterRecoveryCopilot,
  type RecoveryConfig,
} from '../recovery/adapter-recovery.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  results: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of results) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMsg: string,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      throw new Error(errorMsg)
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createAbortingAdapter(
  providerId: AdapterProviderId,
  errorMsg = 'cancelled',
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess-abort',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:failed',
        providerId,
        error: errorMsg,
        code: 'AGENT_ABORTED',
        timestamp: Date.now(),
      }
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: errorMsg,
        recoverable: true,
      })
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

/** Create a registry that returns successes from the given adapter. */
function createMockRegistry(
  adapter: AgentCLIAdapter,
  adapters: AdapterProviderId[] = [adapter.providerId],
): AdapterRegistry {
  const decision: RoutingDecision = {
    provider: adapter.providerId,
    reason: 'mock',
    confidence: 1,
  }

  return {
    getForTask(_task: TaskDescriptor) {
      return { adapter, decision }
    },
    listAdapters() {
      return adapters
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry
}

/** Create a registry that alternates between failing and succeeding. */
function createRetryRegistry(
  failCount: number,
  successProviderId: AdapterProviderId = 'claude',
): AdapterRegistry {
  let callCount = 0

  const successAdapter = createMockAdapter(successProviderId, [
    {
      type: 'adapter:completed',
      providerId: successProviderId,
      sessionId: 'sess-1',
      result: 'recovered',
      durationMs: 50,
      timestamp: Date.now(),
    },
  ])

  const failAdapter = createFailingAdapter(successProviderId, 'transient failure')

  return {
    getForTask(_task: TaskDescriptor) {
      callCount++
      const adapter = callCount <= failCount ? failAdapter : successAdapter
      return {
        adapter,
        decision: {
          provider: successProviderId,
          reason: 'mock',
          confidence: 1,
        },
      }
    },
    listAdapters() {
      return [successProviderId]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry
}

function createAbortThenSuccessRegistry(
  providerId: AdapterProviderId = 'claude',
): { registry: AdapterRegistry; getCallCount: () => number } {
  let callCount = 0

  const successAdapter = createMockAdapter(providerId, [
    {
      type: 'adapter:completed',
      providerId,
      sessionId: 'sess-success',
      result: 'recovered',
      durationMs: 50,
      timestamp: Date.now(),
    },
  ])
  const abortAdapter = createAbortingAdapter(providerId)

  const registry = {
    getForTask(_task: TaskDescriptor) {
      callCount++
      return {
        adapter: callCount === 1 ? abortAdapter : successAdapter,
        decision: {
          provider: providerId,
          reason: 'mock',
          confidence: 1,
        },
      }
    },
    listAdapters() {
      return [providerId]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry

  return {
    registry,
    getCallCount: () => callCount,
  }
}

function createRoutingFailureRegistry(
  providers: AdapterProviderId[],
): AdapterRegistry {
  return {
    getForTask() {
      throw new Error('routing unavailable')
    },
    listAdapters() {
      return providers
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// ExecutionTraceCapture tests
// ---------------------------------------------------------------------------

describe('ExecutionTraceCapture', () => {
  let capture: ExecutionTraceCapture

  beforeEach(() => {
    capture = new ExecutionTraceCapture()
  })

  afterEach(() => {
    capture.dispose()
  })

  it('startTrace creates trace', () => {
    const input: AgentInput = { prompt: 'hello' }
    const trace = capture.startTrace(input)

    expect(trace.traceId).toBeDefined()
    expect(trace.startedAt).toBeInstanceOf(Date)
    expect(trace.input).toBe(input)
    expect(trace.decisions).toEqual([])
    expect(trace.events).toEqual([])
    expect(trace.completedAt).toBeUndefined()
  })

  it('recordDecision adds to trace', () => {
    const trace = capture.startTrace({ prompt: 'test' })

    capture.recordDecision(trace.traceId, {
      type: 'route',
      providerId: 'claude',
      reason: 'tag match',
    })

    const stored = capture.getTrace(trace.traceId)
    expect(stored!.decisions).toHaveLength(1)
    expect(stored!.decisions[0]!.type).toBe('route')
    expect(stored!.decisions[0]!.timestamp).toBeInstanceOf(Date)
  })

  it('recordDecision does nothing for unknown traceId', () => {
    capture.recordDecision('nonexistent', {
      type: 'route',
      providerId: 'claude',
      reason: 'x',
    })
    // No error, no side effects
    expect(capture.getAllTraces()).toHaveLength(0)
  })

  it('recordEvent adds to trace', () => {
    const trace = capture.startTrace({ prompt: 'test' })
    const event: AgentEvent = {
      type: 'adapter:started',
      providerId: 'claude',
      sessionId: 's1',
      timestamp: Date.now(),
    }

    capture.recordEvent(trace.traceId, event)

    const stored = capture.getTrace(trace.traceId)
    expect(stored!.events).toHaveLength(1)
    expect(stored!.events[0]!.event).toBe(event)
    expect(stored!.events[0]!.timestamp).toBeInstanceOf(Date)
  })

  it('recordEvent does nothing for unknown traceId', () => {
    const event: AgentEvent = {
      type: 'adapter:started',
      providerId: 'claude',
      sessionId: 's1',
      timestamp: Date.now(),
    }
    capture.recordEvent('nonexistent', event)
    expect(capture.getAllTraces()).toHaveLength(0)
  })

  it('completeTrace sets completedAt', () => {
    const trace = capture.startTrace({ prompt: 'test' })
    expect(trace.completedAt).toBeUndefined()

    const completed = capture.completeTrace(trace.traceId)
    expect(completed).toBeDefined()
    expect(completed!.completedAt).toBeInstanceOf(Date)
  })

  it('completeTrace returns undefined for unknown traceId', () => {
    expect(capture.completeTrace('nonexistent')).toBeUndefined()
  })

  it('getTrace returns by ID', () => {
    const trace = capture.startTrace({ prompt: 'test' })
    expect(capture.getTrace(trace.traceId)).toBe(trace)
  })

  it('getTrace returns undefined for unknown ID', () => {
    expect(capture.getTrace('nonexistent')).toBeUndefined()
  })

  it('getAllTraces returns all traces', () => {
    capture.startTrace({ prompt: 'a' })
    capture.startTrace({ prompt: 'b' })
    expect(capture.getAllTraces()).toHaveLength(2)
  })

  it('clear removes all traces', () => {
    capture.startTrace({ prompt: 'a' })
    capture.startTrace({ prompt: 'b' })
    expect(capture.getAllTraces()).toHaveLength(2)

    capture.clear()
    expect(capture.getAllTraces()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AdapterRecoveryCopilot tests
// ---------------------------------------------------------------------------

describe('AdapterRecoveryCopilot', () => {
  describe('executeWithRecovery()', () => {
    it('succeeds on first try', async () => {
      const adapter = createMockAdapter('claude', [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'success',
          durationMs: 50,
          timestamp: Date.now(),
        },
      ])
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry)

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(true)
      expect(result.result).toBe('success')
      expect(result.totalAttempts).toBe(1)
      expect(result.providerId).toBe('claude')
    })

    it('retries with different provider on failure', async () => {
      const registry = createRetryRegistry(1, 'claude')
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(true)
      expect(result.totalAttempts).toBe(2)
    })

    it('retries same provider when strategy is retry-same-provider', async () => {
      const registry = createRetryRegistry(1, 'claude')
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        strategyOrder: ['retry-same-provider', 'abort'],
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(true)
      expect(result.totalAttempts).toBe(2)
    })

    it('increase-budget increases limits', async () => {
      let capturedInput: AgentInput | undefined

      const callInputs: AgentInput[] = []
      let callCount = 0

      const registry = {
        getForTask(_task: TaskDescriptor) {
          callCount++
          const shouldFail = callCount <= 1

          const adapter: AgentCLIAdapter = {
            providerId: 'claude' as AdapterProviderId,
            async *execute(input: AgentInput) {
              callInputs.push(input)
              if (shouldFail) throw new Error('over budget')
              yield {
                type: 'adapter:completed' as const,
                providerId: 'claude' as AdapterProviderId,
                sessionId: 's1',
                result: 'ok',
                durationMs: 10,
                timestamp: Date.now(),
              }
            },
            async *resumeSession() {},
            interrupt() {},
            async healthCheck() {
              return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
            },
            configure() {},
          }

          return {
            adapter,
            decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
          }
        },
        listAdapters() {
          return ['claude' as AdapterProviderId]
        },
        recordSuccess() {},
        recordFailure() {},
      } as unknown as AdapterRegistry

      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        strategyOrder: ['increase-budget', 'abort'],
        budgetMultiplier: 2,
      })

      const result = await copilot.executeWithRecovery({
        prompt: 'do it',
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      })

      expect(result.success).toBe(true)
      expect(result.totalAttempts).toBe(2)

      // Second call should have increased budget
      const retryInput = callInputs[1]!
      expect(retryInput.maxTurns).toBe(20) // 10 * 2
      expect(retryInput.maxBudgetUsd).toBe(2.0) // 1.0 * 2
    })

    it('exhausts all strategies and returns failure', async () => {
      const adapter = createFailingAdapter('claude', 'always fails')
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 2,
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(false)
      expect(result.totalAttempts).toBe(2)
      expect(result.error).toContain('always fails')
    })

    it('uses custom strategySelector', async () => {
      const registry = createRetryRegistry(1)
      const strategies: string[] = []

      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        strategySelector: (failure) => {
          strategies.push(`attempt-${failure.attemptNumber}`)
          return 'retry-same-provider'
        },
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(true)
      expect(strategies).toEqual(['attempt-1'])
    })

    it('maxAttempts limits retries', async () => {
      const adapter = createFailingAdapter('claude', 'fail')
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 1,
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(false)
      expect(result.totalAttempts).toBe(1)
    })

    it('stops immediately when strategy selects abort', async () => {
      const adapter = createFailingAdapter('claude', 'fail')
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 5,
        strategyOrder: ['abort'],
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(false)
      expect(result.strategy).toBe('abort')
      expect(result.totalAttempts).toBe(1)
    })

    it('stops when strategy selects escalate-human', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)

      const adapter = createFailingAdapter('claude', 'fail')
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 5,
        strategyOrder: ['escalate-human'],
        eventBus: bus,
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      expect(result.success).toBe(false)
      expect(result.strategy).toBe('escalate-human')
      expect(result.error).toContain('Escalated to human')

      // Should have emitted approval:requested
      const approvalEvents = emitted.filter((e) => e.type === 'approval:requested')
      expect(approvalEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('returns a cancelled result for AGENT_ABORTED without retrying', async () => {
      const { registry, getCallCount } = createAbortThenSuccessRegistry('claude')
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
      })

      const result = await copilot.executeWithRecovery({ prompt: 'do it' })

      // Intentional contract change: cancellation now resolves with an explicit result
      // so callers can branch on `cancelled` instead of catching a rejected promise.
      expect(result.success).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(result.strategy).toBe('abort')
      expect(result.error).toContain('cancelled')
      expect(getCallCount()).toBe(1)
    })
  })

  describe('traceCapture getter', () => {
    it('returns the trace capture instance', () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry)

      const capture = copilot.traceCapture
      expect(capture).toBeInstanceOf(ExecutionTraceCapture)
    })
  })

  describe('executeWithRecoveryStream()', () => {
    it('yields events on success', async () => {
      const adapter = createMockAdapter('claude', [
        {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 's1',
          timestamp: Date.now(),
        },
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'done',
          durationMs: 50,
          timestamp: Date.now(),
        },
      ])
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry)

      const events = await collectEvents(
        copilot.executeWithRecoveryStream({ prompt: 'do it' }),
      )

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe('adapter:started')
      expect(events[1]!.type).toBe('adapter:completed')
    })

    it('retries on failure and yields failed events', async () => {
      const registry = createRetryRegistry(1)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
      })

      const events = await collectEvents(
        copilot.executeWithRecoveryStream({ prompt: 'do it' }),
      )

      // Should have a failed event from first attempt, then completed from second
      const failedEvents = events.filter((e) => e.type === 'adapter:failed')
      const completedEvents = events.filter((e) => e.type === 'adapter:completed')
      expect(failedEvents.length).toBeGreaterThanOrEqual(1)
      expect(completedEvents).toHaveLength(1)
    })

    it('throws ForgeError when all attempts exhausted', async () => {
      const adapter = createFailingAdapter('claude', 'always fails')
      const registry = createMockRegistry(adapter)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 2,
      })

      await expect(
        collectEvents(copilot.executeWithRecoveryStream({ prompt: 'do it' })),
      ).rejects.toThrow('Recovery exhausted')
    })

    it('records trace decisions during recovery stream', async () => {
      const registry = createRetryRegistry(1)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
      })

      await collectEvents(
        copilot.executeWithRecoveryStream({ prompt: 'do it' }),
      )

      const traces = copilot.traceCapture.getAllTraces()
      expect(traces).toHaveLength(1)
      expect(traces[0]!.decisions.length).toBeGreaterThanOrEqual(1)
      expect(traces[0]!.completedAt).toBeInstanceOf(Date)
    })

    it('falls back to an observed provider when routing metadata is unavailable', async () => {
      const registry = createRoutingFailureRegistry(['codex', 'gemini'])
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 1,
      })

      const yielded: AgentEvent[] = []
      try {
        for await (const event of copilot.executeWithRecoveryStream({ prompt: 'do it' })) {
          yielded.push(event)
        }
      } catch {
        // Expected: the stream exhausts after yielding the synthesized failure event.
      }

      expect(yielded).toHaveLength(1)
      expect(yielded[0]).toMatchObject({
        type: 'adapter:failed',
        providerId: 'codex',
        code: 'RECOVERY_ATTEMPT_FAILED',
      })
      expect(
        yielded.some((event) => event.type === 'adapter:failed' && event.providerId === 'claude'),
      ).toBe(false)
    })

    it('stops on AGENT_ABORTED without retrying or synthesizing recovery failure', async () => {
      const { registry, getCallCount } = createAbortThenSuccessRegistry('claude')
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
      })

      const yielded: AgentEvent[] = []
      for await (const event of copilot.executeWithRecoveryStream({ prompt: 'do it' })) {
        yielded.push(event)
      }

      expect(getCallCount()).toBe(1)
      expect(yielded.map((e) => e.type)).toEqual([
        'adapter:started',
        'adapter:failed',
        'recovery:cancelled',
      ])
      expect(yielded.some((e) => e.type === 'adapter:failed' && e.code === 'RECOVERY_ATTEMPT_FAILED')).toBe(false)
    })

    it('emits recovery:cancelled on the event bus for AGENT_ABORTED', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)

      const { registry } = createAbortThenSuccessRegistry('claude')
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        eventBus: bus,
      })

      await collectEvents(copilot.executeWithRecoveryStream({ prompt: 'do it' }))

      const cancelled = emitted.find((e) => e.type === 'recovery:cancelled')
      expect(cancelled).toMatchObject({
        type: 'recovery:cancelled',
        agentId: 'claude',
        runId: expect.any(String),
        attempts: 1,
        durationMs: expect.any(Number),
        reason: 'cancelled',
      })
    })
  })

  describe('event bus integration', () => {
    it('emits recovery events to event bus', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)

      const registry = createRetryRegistry(1)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        eventBus: bus,
      })

      await copilot.executeWithRecovery({ prompt: 'do it' })

      // Should have emitted at least started and succeeded events
      expect(emitted.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('CrossProviderHandoff integration', () => {
    it('enriches input with handoff context when retry-different-provider is selected', async () => {
      // First call fails after yielding some events, second call succeeds
      let callCount = 0
      const capturedInputs: AgentInput[] = []

      const registry = {
        getForTask(_task: TaskDescriptor) {
          callCount++

          const adapter: AgentCLIAdapter = {
            providerId: (callCount === 1 ? 'claude' : 'codex') as AdapterProviderId,
            async *execute(input: AgentInput) {
              capturedInputs.push(input)
              if (callCount === 1) {
                // Yield partial events before failure
                yield {
                  type: 'adapter:started' as const,
                  providerId: 'claude' as AdapterProviderId,
                  sessionId: 's1',
                  timestamp: Date.now(),
                  prompt: input.prompt,
                }
                yield {
                  type: 'adapter:message' as const,
                  providerId: 'claude' as AdapterProviderId,
                  content: 'I started working on the task',
                  role: 'assistant' as const,
                  timestamp: Date.now(),
                }
                yield {
                  type: 'adapter:tool_call' as const,
                  providerId: 'claude' as AdapterProviderId,
                  toolName: 'read_file',
                  input: { path: 'src/main.ts' },
                  timestamp: Date.now(),
                }
                throw new Error('provider crashed')
              }
              // Second attempt succeeds
              yield {
                type: 'adapter:completed' as const,
                providerId: 'codex' as AdapterProviderId,
                sessionId: 's2',
                result: 'done',
                durationMs: 10,
                timestamp: Date.now(),
              }
            },
            async *resumeSession() {},
            interrupt() {},
            async healthCheck() {
              return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
            },
            configure() {},
          }

          return {
            adapter,
            decision: { provider: adapter.providerId, reason: 'mock', confidence: 1 },
          }
        },
        listAdapters() {
          return ['claude' as AdapterProviderId, 'codex' as AdapterProviderId]
        },
        recordSuccess() {},
        recordFailure() {},
      } as unknown as AdapterRegistry

      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        strategyOrder: ['retry-different-provider', 'abort'],
      })

      const result = await copilot.executeWithRecovery({ prompt: 'Fix the bug' })

      expect(result.success).toBe(true)
      expect(result.totalAttempts).toBe(2)

      // The second attempt's input should have handoff context in systemPrompt
      const retryInput = capturedInputs[1]!
      expect(retryInput.systemPrompt).toBeDefined()
      expect(retryInput.systemPrompt).toContain('Partial progress from previous provider')
      expect(retryInput.systemPrompt).toContain('I started working on the task')
      expect(retryInput.systemPrompt).toContain('read_file')
    })

    it('does not enrich input when strategy is not retry-different-provider', async () => {
      let callCount = 0
      const capturedInputs: AgentInput[] = []

      const registry = {
        getForTask(_task: TaskDescriptor) {
          callCount++

          const adapter: AgentCLIAdapter = {
            providerId: 'claude' as AdapterProviderId,
            async *execute(input: AgentInput) {
              capturedInputs.push(input)
              if (callCount === 1) {
                yield {
                  type: 'adapter:message' as const,
                  providerId: 'claude' as AdapterProviderId,
                  content: 'partial work',
                  role: 'assistant' as const,
                  timestamp: Date.now(),
                }
                throw new Error('transient failure')
              }
              yield {
                type: 'adapter:completed' as const,
                providerId: 'claude' as AdapterProviderId,
                sessionId: 's1',
                result: 'done',
                durationMs: 10,
                timestamp: Date.now(),
              }
            },
            async *resumeSession() {},
            interrupt() {},
            async healthCheck() {
              return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
            },
            configure() {},
          }

          return {
            adapter,
            decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
          }
        },
        listAdapters() {
          return ['claude' as AdapterProviderId]
        },
        recordSuccess() {},
        recordFailure() {},
      } as unknown as AdapterRegistry

      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        strategyOrder: ['retry-same-provider', 'abort'],
      })

      const result = await copilot.executeWithRecovery({ prompt: 'Fix the bug' })

      expect(result.success).toBe(true)
      expect(result.totalAttempts).toBe(2)

      // The second attempt's input should NOT have handoff context
      const retryInput = capturedInputs[1]!
      expect(retryInput.systemPrompt).toBeUndefined()
    })
  })
})
