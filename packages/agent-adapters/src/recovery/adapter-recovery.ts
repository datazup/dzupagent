/**
 * AdapterRecoveryCopilot — recovery strategies and trace capture for
 * multi-agent orchestration failures.
 *
 * When an adapter execution fails, the copilot applies a configurable
 * sequence of recovery strategies (retry, fallback provider, increase
 * budget, simplify task, escalate to human, or abort) and records a
 * full execution trace for post-mortem analysis.
 *
 * The implementation is split across several collaborator modules so
 * the main copilot stays focused on the loop scaffolding:
 *
 *   - `recovery-types.ts`             — shared public types
 *   - `execution-trace-types.ts`      — trace payload shape
 *   - `execution-trace-store.ts`      — TTL-bounded per-entry store
 *   - `recovery-loop-runner.ts`       — backoff + cooperative cancellation
 *   - `recovery-event-emitter.ts`     — DzupEventBus emission
 *   - `recovery-attempt-handler.ts`   — per-attempt routing + failure dispatch
 *
 * @module recovery/adapter-recovery
 */

import { ForgeError } from '@dzupagent/core/events'

import type { DzupEventBus } from '@dzupagent/core/events'

import type { AgentEvent, AgentInput, TaskDescriptor } from '../types.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { EscalationHandler } from './escalation-handler.js'
import {
  ExecutionTraceStore,
  type ExecutionTraceStoreConfig,
} from './execution-trace-store.js'
import type {
  ExecutionTrace,
  TraceDecision,
} from './execution-trace-types.js'
import { RecoveryAttemptHandler } from './recovery-attempt-handler.js'
import { RecoveryEventEmitter } from './recovery-event-emitter.js'
import { computeBackoffDelay, delayWithSignal } from './recovery-loop-runner.js'
import type {
  FailureContext,
  RecoveryResult,
  RecoveryStrategy,
} from './recovery-types.js'

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public surface
// ---------------------------------------------------------------------------

export type {
  ExecutionTrace,
  TraceDecision,
  TracedEvent,
} from './execution-trace-types.js'
export type {
  FailureContext,
  RecoveryStrategy,
  RecoverySuccessResult,
  RecoveryFailureResult,
  RecoveryCancelledResult,
  RecoveryResult,
} from './recovery-types.js'
export type {
  RecoveryLoopState,
  AttemptOutcome,
  AttemptFailureContext,
} from './recovery-attempt-handler.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TraceEvictionConfig {
  /** Max number of traces. Default: 1000 */
  maxTraces?: number | undefined
  /** TTL per trace in ms. Default: 3_600_000 (1 hour) */
  ttlMs?: number | undefined
  /**
   * Sweep interval in ms. Retained for API compatibility — eviction now
   * uses per-entry `setTimeout` so this option is ignored.
   */
  sweepIntervalMs?: number | undefined
}

export interface RecoveryConfig {
  /** Max recovery attempts before giving up. Default 3 */
  maxAttempts?: number | undefined
  /** Strategy selection order. Default: retry-different -> increase-budget -> escalate-human -> abort */
  strategyOrder?: RecoveryStrategy[] | undefined
  /** Event bus */
  eventBus?: DzupEventBus | undefined
  /** Budget increase multiplier for 'increase-budget' strategy. Default 1.5 */
  budgetMultiplier?: number | undefined
  /** Custom strategy selector */
  strategySelector?: (failure: FailureContext) => RecoveryStrategy
  /** Trace eviction configuration */
  traceEviction?: TraceEvictionConfig | undefined
  /** Base backoff delay in ms between recovery attempts. Default: 1000 */
  backoffMs?: number | undefined
  /** Exponential multiplier. Default: 2 */
  backoffMultiplier?: number | undefined
  /** Maximum backoff delay in ms. Default: 30_000 */
  maxBackoffMs?: number | undefined
  /** Add jitter to prevent thundering herd. Default: true */
  backoffJitter?: boolean | undefined
  /** Escalation handler for human-in-the-loop workflows */
  escalationHandler?: EscalationHandler | undefined
  /** Timeout in ms for escalation resolution. Default: 300_000 (5 min) */
  escalationTimeoutMs?: number | undefined
}

const DEFAULT_STRATEGY_ORDER: RecoveryStrategy[] = [
  'retry-different-provider',
  'retry-same-provider',
  'increase-budget',
  'escalate-human',
  'abort',
]

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BUDGET_MULTIPLIER = 1.5

// ---------------------------------------------------------------------------
// ExecutionTraceCapture — wrapper around ExecutionTraceStore that preserves
// the legacy startTrace/recordDecision/recordEvent API used by the copilot
// and by external consumers.
// ---------------------------------------------------------------------------

export class ExecutionTraceCapture {
  private readonly store: ExecutionTraceStore<ExecutionTrace>

  constructor(config?: TraceEvictionConfig) {
    const storeConfig: ExecutionTraceStoreConfig = {
      ttlMs: config?.ttlMs ?? 3_600_000,
      maxSize: config?.maxTraces ?? 1000,
    }
    this.store = new ExecutionTraceStore<ExecutionTrace>(storeConfig)
  }

  startTrace(input: AgentInput): ExecutionTrace {
    const trace: ExecutionTrace = {
      traceId: crypto.randomUUID(),
      startedAt: new Date(),
      input,
      decisions: [],
      events: [],
    }
    this.store.store(trace.traceId, trace)
    return trace
  }

  recordDecision(traceId: string, decision: Omit<TraceDecision, 'timestamp'>): void {
    const trace = this.store.get(traceId)
    if (!trace) return
    trace.decisions.push({ ...decision, timestamp: new Date() })
  }

  recordEvent(traceId: string, event: AgentEvent): void {
    const trace = this.store.get(traceId)
    if (!trace) return
    trace.events.push({ timestamp: new Date(), event })
  }

  completeTrace(traceId: string): ExecutionTrace | undefined {
    const trace = this.store.get(traceId)
    if (!trace) return undefined
    trace.completedAt = new Date()
    return trace
  }

  getTrace(traceId: string): ExecutionTrace | undefined {
    return this.store.get(traceId)
  }

  getAllTraces(): ExecutionTrace[] {
    return this.store.values()
  }

  clear(): void {
    this.store.clear()
  }

  /** Stop all TTL timers and release resources. */
  dispose(): void {
    this.store.dispose()
  }
}

// ---------------------------------------------------------------------------
// AdapterRecoveryCopilot
// ---------------------------------------------------------------------------

export class AdapterRecoveryCopilot {
  private readonly _traceCapture: ExecutionTraceCapture
  private readonly handler: RecoveryAttemptHandler
  private readonly config: RecoveryConfig
  private readonly maxAttempts: number

  constructor(
    private readonly registry: ProviderAdapterRegistry,
    config?: RecoveryConfig,
  ) {
    this.config = config ?? {}
    this.maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this._traceCapture = new ExecutionTraceCapture(config?.traceEviction)
    const emitter = new RecoveryEventEmitter(config?.eventBus)
    this.handler = new RecoveryAttemptHandler(registry, this._traceCapture, emitter, {
      maxAttempts: this.maxAttempts,
      strategyOrder: config?.strategyOrder ?? DEFAULT_STRATEGY_ORDER,
      budgetMultiplier: config?.budgetMultiplier ?? DEFAULT_BUDGET_MULTIPLIER,
      strategySelector: config?.strategySelector,
      escalationHandler: config?.escalationHandler,
      escalationTimeoutMs: config?.escalationTimeoutMs,
    })
  }

  /** Get the trace capture instance for inspection. */
  get traceCapture(): ExecutionTraceCapture {
    return this._traceCapture
  }

  /** Stop background timers and release resources. */
  dispose(): void {
    this._traceCapture.dispose()
  }

  /**
   * Execute with automatic recovery on failure. Tries the primary
   * execution, and on failure applies recovery strategies.
   */
  async executeWithRecovery(
    input: AgentInput,
    task?: TaskDescriptor,
  ): Promise<RecoveryResult> {
    const overallStart = Date.now()
    const trace = this._traceCapture.startTrace(input)
    const effectiveTask = this.handler.resolveEffectiveTask(input, task)
    const state = this.handler.createInitialLoopState(input)

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) await this.delayBeforeRetry(attempt, input.signal)

      const attemptStart = Date.now()
      const partialEvents: AgentEvent[] = []
      const outcome = await this.handler.runAttempt(
        trace.traceId,
        attempt,
        state,
        effectiveTask,
        overallStart,
        partialEvents,
      )
      if (outcome.kind === 'success') return outcome.result

      const terminal = await this.handler.handleFailure({
        traceId: trace.traceId,
        error: outcome.error,
        rawError: outcome.rawError,
        attempt,
        attemptStart,
        overallStart,
        state,
        task,
        effectiveTask,
        partialEvents,
      })
      if (terminal) return terminal
    }

    this._traceCapture.completeTrace(trace.traceId)
    return {
      success: false,
      strategy: 'abort',
      totalAttempts: this.maxAttempts,
      totalDurationMs: Date.now() - overallStart,
      error: 'Max attempts exhausted',
    }
  }

  /**
   * Wrap an async generator with recovery — if the source fails, retry
   * with a different strategy.
   */
  async *executeWithRecoveryStream(
    input: AgentInput,
    task?: TaskDescriptor,
  ): AsyncGenerator<AgentEvent> {
    const trace = this._traceCapture.startTrace(input)
    const effectiveTask = this.handler.resolveEffectiveTask(input, task)
    const state = this.handler.createInitialLoopState(input)

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) await this.delayBeforeRetry(attempt, input.signal)

      const partialEvents: AgentEvent[] = []
      try {
        const { adapter } = this.handler.routeForAttempt(trace.traceId, attempt, state, effectiveTask)
        // Mirror the non-stream guard in `collectAdapterOutput`: a generator that
        // completes without throwing is NOT necessarily a success. Track whether a
        // terminal event (adapter:completed / assistant message) was seen and
        // whether the adapter emitted `adapter:failed` mid-stream.
        let didComplete = false
        let didFail = false
        for await (const event of adapter.execute(state.currentInput)) {
          partialEvents.push(event)
          this._traceCapture.recordEvent(trace.traceId, event)
          if (event.type === 'adapter:completed') didComplete = true
          if (event.type === 'adapter:message' && event.role === 'assistant') didComplete = true
          if (event.type === 'adapter:failed') didFail = true
          yield event
        }

        // A generator that signalled failure (or never produced a terminal event)
        // must NOT record provider success — that corrupts the circuit-breaker/
        // health EMA and routes future traffic to a broken provider. Throw so the
        // failure path below advances the recovery strategy / throws
        // ALL_ADAPTERS_EXHAUSTED, exactly as a thrown adapter error would.
        if (didFail || !didComplete) {
          throw new Error(
            didFail
              ? 'Adapter emitted adapter:failed without throwing — treating as failure'
              : 'Adapter completed without emitting a terminal event (adapter:completed or assistant message)',
          )
        }

        this.registry.recordSuccess(adapter.providerId)
        this._traceCapture.completeTrace(trace.traceId)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
          yield* this.handler.emitStreamCancellation(
            trace.traceId,
            state,
            attempt,
            Date.now() - trace.startedAt.getTime(),
            error.message,
          )
          return
        }

        const failureCtx = this.handler.buildFailureContext(state, error, err, attempt, 0, task)
        const failedProviderId = failureCtx.failedProvider

        yield {
          type: 'adapter:failed',
          providerId: failedProviderId,
          error: error.message,
          code: 'RECOVERY_ATTEMPT_FAILED',
          timestamp: Date.now(),
        }

        if (attempt >= this.maxAttempts) {
          this.handler.throwStreamExhausted(trace.traceId, failedProviderId, attempt, error, err)
        }

        const nextStrategy = this.handler.advanceStrategy(state, failureCtx, effectiveTask, partialEvents)

        if (nextStrategy === 'abort' || nextStrategy === 'escalate-human') {
          this.handler.throwStreamStopped(
            trace.traceId,
            state,
            failureCtx,
            failedProviderId,
            attempt,
            error,
            nextStrategy,
          )
        }
      }
    }

    this._traceCapture.completeTrace(trace.traceId)
  }

  private delayBeforeRetry(attemptNumber: number, signal?: AbortSignal): Promise<void> {
    const delay = computeBackoffDelay(attemptNumber, {
      maxAttempts: this.maxAttempts,
      backoffMs: this.config.backoffMs,
      backoffMultiplier: this.config.backoffMultiplier,
      maxBackoffMs: this.config.maxBackoffMs,
      backoffJitter: this.config.backoffJitter,
    })
    return delayWithSignal(delay, signal)
  }
}
