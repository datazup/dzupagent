/**
 * Unit tests for RecoveryAttemptHandler (M-12 audit finding).
 *
 * Covers the handler's public surface directly — no AdapterRecoveryCopilot
 * involved. All dependencies are hand-rolled stubs to avoid network, DB, or
 * live LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzupagent/core'

import {
  RecoveryAttemptHandler,
  type RecoveryAttemptHandlerConfig,
  type RecoveryLoopState,
  type TraceCaptureLike,
} from '../recovery/recovery-attempt-handler.js'
import { RecoveryEventEmitter } from '../recovery/recovery-event-emitter.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeTraceCapture(): TraceCaptureLike & {
  decisions: Array<{ traceId: string; type: string; reason: string }>
  completed: string[]
} {
  const decisions: Array<{ traceId: string; type: string; reason: string }> = []
  const completed: string[] = []
  return {
    decisions,
    completed,
    recordDecision(traceId, decision) {
      decisions.push({ traceId, type: decision.type, reason: decision.reason })
    },
    recordEvent(_traceId, _event) {},
    completeTrace(traceId) {
      completed.push(traceId)
      return undefined
    },
  }
}

function makeEmitter(): RecoveryEventEmitter & { calls: string[] } {
  const calls: string[] = []
  const emitter = new RecoveryEventEmitter(undefined) as RecoveryEventEmitter & { calls: string[] }
  emitter.calls = calls
  vi.spyOn(emitter, 'attemptStarted').mockImplementation(() => { calls.push('attemptStarted') })
  vi.spyOn(emitter, 'succeeded').mockImplementation(() => { calls.push('succeeded') })
  vi.spyOn(emitter, 'exhausted').mockImplementation(() => { calls.push('exhausted') })
  vi.spyOn(emitter, 'cancelled').mockImplementation(() => { calls.push('cancelled') })
  vi.spyOn(emitter, 'approvalRequested').mockImplementation(() => { calls.push('approvalRequested') })
  return emitter
}

function makeSuccessAdapter(providerId: AdapterProviderId, result = 'ok'): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: 'sess-1',
        result,
        durationMs: 10,
        timestamp: Date.now(),
      } as AgentEvent
    },
    async *resumeSession(_id: string, _input: AgentInput) { /* noop */ },
    interrupt() {},
    async healthCheck() { return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true } },
    configure() {},
  } as unknown as AgentCLIAdapter
}

function makeFailingAdapter(providerId: AdapterProviderId, message: string): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      throw new Error(message)
    },
    async *resumeSession(_id: string, _input: AgentInput) { /* noop */ },
    interrupt() {},
    async healthCheck() { return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true } },
    configure() {},
  } as unknown as AgentCLIAdapter
}

function makeRegistry(adapter: AgentCLIAdapter): ProviderAdapterRegistry {
  return {
    getForTask(_task: TaskDescriptor) {
      return { adapter, decision: { provider: adapter.providerId, reason: 'mock', confidence: 1 } }
    },
    listAdapters() { return [adapter.providerId] },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as ProviderAdapterRegistry
}

/** Registry that alternates between a failing then a succeeding adapter. */
function makeRetryRegistry(
  failCount: number,
  providerId: AdapterProviderId = 'claude' as AdapterProviderId,
): ProviderAdapterRegistry {
  let calls = 0
  const success = makeSuccessAdapter(providerId)
  const fail = makeFailingAdapter(providerId, 'transient')
  return {
    getForTask(_task: TaskDescriptor) {
      calls++
      const adapter = calls <= failCount ? fail : success
      return { adapter, decision: { provider: providerId, reason: 'mock', confidence: 1 } }
    },
    listAdapters() { return [providerId] },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as ProviderAdapterRegistry
}

const PROVIDER: AdapterProviderId = 'claude' as AdapterProviderId
const TRACE_ID = 'trace-001'
const INPUT: AgentInput = { prompt: 'hello' }
const TASK: TaskDescriptor = { prompt: 'hello', tags: [] }

const DEFAULT_CONFIG: RecoveryAttemptHandlerConfig = {
  maxAttempts: 3,
  strategyOrder: ['retry-same-provider', 'retry-different-provider', 'escalate-human', 'abort'],
  budgetMultiplier: 1,
}

function makeLoopState(input: AgentInput = INPUT): RecoveryLoopState {
  return {
    exhaustedProviders: [],
    lastStrategy: 'retry-different-provider',
    lastProviderId: undefined,
    currentInput: { ...input },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecoveryAttemptHandler', () => {
  let traceCapture: ReturnType<typeof makeTraceCapture>
  let emitter: ReturnType<typeof makeEmitter>

  beforeEach(() => {
    traceCapture = makeTraceCapture()
    emitter = makeEmitter()
  })

  // -------------------------------------------------------------------------
  // resolveEffectiveTask
  // -------------------------------------------------------------------------

  describe('resolveEffectiveTask', () => {
    it('returns the task unchanged when provided', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const task: TaskDescriptor = { prompt: 'original', tags: ['t'] }
      expect(sut.resolveEffectiveTask(INPUT, task)).toBe(task)
    })

    it('synthesises a task from the input prompt when task is undefined', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const result = sut.resolveEffectiveTask({ prompt: 'do the thing' }, undefined)
      expect(result.prompt).toBe('do the thing')
      expect(result.tags).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // createInitialLoopState
  // -------------------------------------------------------------------------

  describe('createInitialLoopState', () => {
    it('produces zeroed exhausted list and copies the input', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = sut.createInitialLoopState(INPUT)
      expect(state.exhaustedProviders).toEqual([])
      expect(state.currentInput).toEqual(INPUT)
      expect(state.currentInput).not.toBe(INPUT) // shallow copy, not same reference
      expect(state.lastProviderId).toBeUndefined()
    })

    it('does not share state between two calls (isolation)', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const s1 = sut.createInitialLoopState(INPUT)
      const s2 = sut.createInitialLoopState(INPUT)
      s1.exhaustedProviders.push(PROVIDER)
      expect(s2.exhaustedProviders).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // runAttempt — successful path
  // -------------------------------------------------------------------------

  describe('runAttempt — success', () => {
    it('returns kind=success with populated result on first attempt', async () => {
      const registry = makeRegistry(makeSuccessAdapter(PROVIDER, 'done'))
      const sut = new RecoveryAttemptHandler(registry, traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      const outcome = await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), [])

      expect(outcome.kind).toBe('success')
      if (outcome.kind === 'success') {
        expect(outcome.result.success).toBe(true)
        expect(outcome.result.result).toBe('done')
        expect(outcome.result.totalAttempts).toBe(1)
        expect(outcome.result.providerId).toBe(PROVIDER)
      }
    })

    it('calls emitter.attemptStarted and emitter.succeeded on success', async () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), [])

      expect(emitter.calls).toContain('attemptStarted')
      expect(emitter.calls).toContain('succeeded')
    })

    it('records a route decision for attempt 1 and completes the trace', async () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), [])

      const routeDecision = traceCapture.decisions.find((d) => d.type === 'route')
      expect(routeDecision).toBeDefined()
      expect(traceCapture.completed).toContain(TRACE_ID)
    })

    it('records a recovery decision (not route) for attempt 2', async () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      await sut.runAttempt(TRACE_ID, 2, state, TASK, Date.now(), [])

      const recoveryDecision = traceCapture.decisions.find((d) => d.type === 'recovery')
      expect(recoveryDecision).toBeDefined()
      expect(recoveryDecision?.reason).toContain('attempt 2')
    })

    it('collects adapter events into partialEvents array', async () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER, 'x')), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      const partialEvents: AgentEvent[] = []

      await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), partialEvents)

      expect(partialEvents.length).toBeGreaterThan(0)
      expect(partialEvents.some((e) => e.type === 'adapter:completed')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // runAttempt — failure path
  // -------------------------------------------------------------------------

  describe('runAttempt — failure', () => {
    it('returns kind=failure when the adapter throws', async () => {
      const registry = makeRegistry(makeFailingAdapter(PROVIDER, 'boom'))
      const sut = new RecoveryAttemptHandler(registry, traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      const outcome = await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), [])

      expect(outcome.kind).toBe('failure')
      if (outcome.kind === 'failure') {
        expect(outcome.error.message).toBe('boom')
      }
    })

    it('does not emit succeeded on failure', async () => {
      const registry = makeRegistry(makeFailingAdapter(PROVIDER, 'err'))
      const sut = new RecoveryAttemptHandler(registry, traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()

      await sut.runAttempt(TRACE_ID, 1, state, TASK, Date.now(), [])

      expect(emitter.calls).not.toContain('succeeded')
    })
  })

  // -------------------------------------------------------------------------
  // buildFailureContext
  // -------------------------------------------------------------------------

  describe('buildFailureContext', () => {
    it('populates failedProvider from state.lastProviderId', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER
      const err = new Error('oops')

      const ctx = sut.buildFailureContext(state, err, err, 1, 100, TASK)

      expect(ctx.failedProvider).toBe(PROVIDER)
      expect(ctx.error).toBe('oops')
      expect(ctx.attemptNumber).toBe(1)
      expect(ctx.durationMs).toBe(100)
    })

    it('appends lastProviderId to exhaustedProviders exactly once', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER

      const err = new Error('x')
      sut.buildFailureContext(state, err, err, 1, 0, TASK)
      sut.buildFailureContext(state, err, err, 2, 0, TASK) // second call — same provider

      expect(state.exhaustedProviders.filter((p) => p === PROVIDER)).toHaveLength(1)
    })

    it('extracts errorCode from ForgeError rawError', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER
      const forge = new ForgeError({ code: 'ADAPTER_EXECUTION_FAILED', message: 'fail', recoverable: true })

      const ctx = sut.buildFailureContext(state, forge, forge, 1, 0, TASK)

      expect(ctx.errorCode).toBe('ADAPTER_EXECUTION_FAILED')
    })
  })

  // -------------------------------------------------------------------------
  // handleFailure — AGENT_ABORTED returns cancelled result
  // -------------------------------------------------------------------------

  describe('handleFailure — AGENT_ABORTED', () => {
    it('returns a cancelled result when rawError is AGENT_ABORTED ForgeError', async () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER

      const abortErr = new ForgeError({ code: 'AGENT_ABORTED', message: 'signal fired', recoverable: false })

      const result = await sut.handleFailure({
        traceId: TRACE_ID,
        error: abortErr,
        rawError: abortErr,
        attempt: 1,
        attemptStart: Date.now(),
        overallStart: Date.now(),
        state,
        task: TASK,
        effectiveTask: TASK,
        partialEvents: [],
      })

      expect(result).toBeDefined()
      if (result && !result.success) {
        expect((result as { cancelled?: boolean }).cancelled).toBe(true)
      }
      expect(emitter.calls).toContain('cancelled')
    })
  })

  // -------------------------------------------------------------------------
  // handleFailure — max attempts exhausted
  // -------------------------------------------------------------------------

  describe('handleFailure — exhausted', () => {
    it('returns a failure result and emits exhausted when attempt >= maxAttempts', async () => {
      const config: RecoveryAttemptHandlerConfig = { ...DEFAULT_CONFIG, maxAttempts: 2 }
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, config)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER
      const err = new Error('final')

      const result = await sut.handleFailure({
        traceId: TRACE_ID,
        error: err,
        rawError: err,
        attempt: 2,
        attemptStart: Date.now(),
        overallStart: Date.now(),
        state,
        task: TASK,
        effectiveTask: TASK,
        partialEvents: [],
      })

      expect(result).toBeDefined()
      expect(result?.success).toBe(false)
      expect(emitter.calls).toContain('exhausted')
    })
  })

  // -------------------------------------------------------------------------
  // handleFailure — strategy = abort
  // -------------------------------------------------------------------------

  describe('handleFailure — strategy abort', () => {
    it('returns a failure result immediately when strategy resolves to abort', async () => {
      // Force abort strategy by injecting a custom strategySelector
      const config: RecoveryAttemptHandlerConfig = {
        ...DEFAULT_CONFIG,
        maxAttempts: 5,
        strategySelector: () => 'abort',
      }
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, config)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER
      const err = new Error('bad')

      const result = await sut.handleFailure({
        traceId: TRACE_ID,
        error: err,
        rawError: err,
        attempt: 1,
        attemptStart: Date.now(),
        overallStart: Date.now(),
        state,
        task: TASK,
        effectiveTask: TASK,
        partialEvents: [],
      })

      expect(result).toBeDefined()
      expect(result?.success).toBe(false)
      if (result && !result.success) {
        expect(result.strategy).toBe('abort')
      }
    })
  })

  // -------------------------------------------------------------------------
  // handleFailure — loop continues (returns undefined)
  // -------------------------------------------------------------------------

  describe('handleFailure — continue loop', () => {
    it('returns undefined when below maxAttempts and strategy is not abort/escalate-human', async () => {
      const config: RecoveryAttemptHandlerConfig = {
        ...DEFAULT_CONFIG,
        maxAttempts: 3,
        strategySelector: () => 'retry-same-provider',
      }
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, config)
      const state = makeLoopState()
      state.lastProviderId = PROVIDER
      const err = new Error('transient')

      const result = await sut.handleFailure({
        traceId: TRACE_ID,
        error: err,
        rawError: err,
        attempt: 1,
        attemptStart: Date.now(),
        overallStart: Date.now(),
        state,
        task: TASK,
        effectiveTask: TASK,
        partialEvents: [],
      })

      expect(result).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // throwStreamExhausted
  // -------------------------------------------------------------------------

  describe('throwStreamExhausted', () => {
    it('throws ALL_ADAPTERS_EXHAUSTED ForgeError with attempt context', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const err = new Error('done')

      expect(() => {
        sut.throwStreamExhausted(TRACE_ID, PROVIDER, 3, err, err)
      }).toThrow(ForgeError)

      try {
        sut.throwStreamExhausted(TRACE_ID, PROVIDER, 3, err, err)
      } catch (e) {
        if (ForgeError.is(e)) {
          expect(e.code).toBe('ALL_ADAPTERS_EXHAUSTED')
          expect(e.context?.['attempts']).toBe(3)
          expect(e.recoverable).toBe(false)
        }
      }
    })

    it('records abort decision and completes trace before throwing', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const err = new Error('x')

      expect(() => sut.throwStreamExhausted(TRACE_ID, PROVIDER, 2, err, err)).toThrow()

      const abortDecision = traceCapture.decisions.find((d) => d.type === 'abort')
      expect(abortDecision).toBeDefined()
      expect(traceCapture.completed).toContain(TRACE_ID)
    })
  })

  // -------------------------------------------------------------------------
  // throwStreamStopped — strategy = abort
  // -------------------------------------------------------------------------

  describe('throwStreamStopped', () => {
    it('throws ALL_ADAPTERS_EXHAUSTED when nextStrategy is abort', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      const failure = {
        input: INPUT,
        failedProvider: PROVIDER,
        error: 'x',
        attemptNumber: 1,
        exhaustedProviders: [],
        durationMs: 0,
      }
      const err = new Error('x')

      expect(() => {
        sut.throwStreamStopped(TRACE_ID, state, failure, PROVIDER, 1, err, 'abort')
      }).toThrow(ForgeError)
    })

    it('emits approvalRequested when nextStrategy is escalate-human', () => {
      const sut = new RecoveryAttemptHandler(makeRegistry(makeSuccessAdapter(PROVIDER)), traceCapture, emitter, DEFAULT_CONFIG)
      const state = makeLoopState()
      const failure = {
        input: INPUT,
        failedProvider: PROVIDER,
        error: 'x',
        attemptNumber: 1,
        exhaustedProviders: [],
        durationMs: 0,
      }
      const err = new Error('x')

      expect(() => {
        sut.throwStreamStopped(TRACE_ID, state, failure, PROVIDER, 1, err, 'escalate-human')
      }).toThrow(ForgeError)

      expect(emitter.calls).toContain('approvalRequested')
    })
  })

  // -------------------------------------------------------------------------
  // resolveAvailableProvider
  // -------------------------------------------------------------------------

  describe('resolveAvailableProvider', () => {
    it('returns a provider not in the excluded list', () => {
      const OTHER: AdapterProviderId = 'openai' as AdapterProviderId
      const registry = {
        getForTask: () => ({ adapter: makeSuccessAdapter(OTHER), decision: { provider: OTHER, reason: '', confidence: 1 } }),
        listAdapters: () => [PROVIDER, OTHER],
        recordSuccess: () => {},
        recordFailure: () => {},
      } as unknown as ProviderAdapterRegistry
      const sut = new RecoveryAttemptHandler(registry, traceCapture, emitter, DEFAULT_CONFIG)

      const result = sut.resolveAvailableProvider([PROVIDER])
      expect(result).toBe(OTHER)
    })

    it('returns undefined when all providers are excluded', () => {
      const registry = {
        listAdapters: () => [PROVIDER],
        recordSuccess: () => {},
        recordFailure: () => {},
      } as unknown as ProviderAdapterRegistry
      const sut = new RecoveryAttemptHandler(registry, traceCapture, emitter, DEFAULT_CONFIG)

      const result = sut.resolveAvailableProvider([PROVIDER])
      expect(result).toBeUndefined()
    })
  })
})
