/**
 * RecoveryAttemptHandler — encapsulates all the per-attempt machinery that
 * was previously embedded directly in `AdapterRecoveryCopilot`.
 *
 * The handler is collaborator-shaped: it receives the registry, the trace
 * capture, the event emitter, and the recovery configuration once at
 * construction, then exposes a small surface area:
 *
 *   - `runAttempt`        — route + execute + drain output for one attempt
 *   - `handleFailure`     — decide whether the loop terminates after a failure
 *   - `buildFailureContext` / `advanceStrategy` — state-loop primitives that
 *                            the stream entrypoint also needs to reuse
 *
 * Pulling this into its own module keeps the main copilot below 200 LOC
 * while preserving the exact behaviour and event ordering that the existing
 * recovery test-suite asserts on.
 *
 * @module recovery/recovery-attempt-handler
 */

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'
import { CrossProviderHandoff } from './cross-provider-handoff.js'
import type { EscalationHandler } from './escalation-handler.js'
import type {
  ExecutionTrace,
  TraceDecision,
} from './execution-trace-types.js'
import { applyRecoveryStrategy } from './recovery-strategy-application.js'
import {
  createCancelledRecoveryResult,
  createRecoveryCancelledEvent,
} from './recovery-events.js'
import type { RecoveryEventEmitter } from './recovery-event-emitter.js'
import { selectRecoveryStrategy } from './recovery-strategy.js'
import type {
  FailureContext,
  RecoveryCancelledResult,
  RecoveryFailureResult,
  RecoveryResult,
  RecoveryStrategy,
  RecoverySuccessResult,
} from './recovery-types.js'

/**
 * Minimal contract the handler needs from a trace capture. Defined
 * structurally so the concrete `ExecutionTraceCapture` can be passed
 * without creating a cycle through `adapter-recovery.js`.
 */
export interface TraceCaptureLike {
  recordDecision(traceId: string, decision: Omit<TraceDecision, 'timestamp'>): void
  recordEvent(traceId: string, event: AgentEvent): void
  completeTrace(traceId: string): ExecutionTrace | undefined
}

/** Mutable state threaded through the recovery attempt loop. */
export interface RecoveryLoopState {
  exhaustedProviders: AdapterProviderId[]
  lastStrategy: RecoveryStrategy
  lastProviderId: AdapterProviderId | undefined
  currentInput: AgentInput
}

/** Outcome of a single recovery attempt. */
export type AttemptOutcome =
  | { kind: 'success'; result: RecoverySuccessResult }
  | { kind: 'failure'; error: Error; rawError: unknown }

export interface AttemptFailureContext {
  traceId: string
  error: Error
  rawError: unknown
  attempt: number
  attemptStart: number
  overallStart: number
  state: RecoveryLoopState
  task: TaskDescriptor | undefined
  effectiveTask: TaskDescriptor
  partialEvents: AgentEvent[]
}

export interface RecoveryAttemptHandlerConfig {
  maxAttempts: number
  strategyOrder: RecoveryStrategy[]
  budgetMultiplier: number
  strategySelector?: ((failure: FailureContext) => RecoveryStrategy) | undefined
  escalationHandler?: EscalationHandler | undefined
  escalationTimeoutMs?: number | undefined
}

export class RecoveryAttemptHandler {
  constructor(
    private readonly registry: ProviderAdapterRegistry,
    private readonly traceCapture: TraceCaptureLike,
    private readonly emitter: RecoveryEventEmitter,
    private readonly config: RecoveryAttemptHandlerConfig,
  ) {}

  resolveEffectiveTask(input: AgentInput, task: TaskDescriptor | undefined): TaskDescriptor {
    return task ?? { prompt: input.prompt, tags: [] }
  }

  createInitialLoopState(input: AgentInput): RecoveryLoopState {
    return {
      exhaustedProviders: [],
      lastStrategy: 'retry-different-provider',
      lastProviderId: undefined,
      currentInput: { ...input },
    }
  }

  routeForAttempt(
    traceId: string,
    attempt: number,
    state: RecoveryLoopState,
    effectiveTask: TaskDescriptor,
  ): { adapter: AgentCLIAdapter; decision: RoutingDecision } {
    const { adapter, decision } = this.registry.getForTask(effectiveTask)
    state.lastProviderId = adapter.providerId

    this.traceCapture.recordDecision(traceId, {
      type: attempt === 1 ? 'route' : 'recovery',
      providerId: adapter.providerId,
      reason:
        attempt === 1
          ? `Initial routing: ${decision.reason}`
          : `Recovery attempt ${attempt} via strategy "${state.lastStrategy}"`,
    })

    return { adapter, decision }
  }

  buildFailureContext(
    state: RecoveryLoopState,
    error: Error,
    rawError: unknown,
    attempt: number,
    durationMs: number,
    task: TaskDescriptor | undefined,
  ): FailureContext {
    if (state.lastProviderId && !state.exhaustedProviders.includes(state.lastProviderId)) {
      state.exhaustedProviders.push(state.lastProviderId)
    }
    return {
      input: state.currentInput,
      task,
      failedProvider:
        state.lastProviderId ??
        this.resolveAvailableProvider(state.exhaustedProviders) ??
        ('unknown' as AdapterProviderId),
      error: error.message,
      errorCode: rawError instanceof ForgeError ? rawError.code : undefined,
      attemptNumber: attempt,
      exhaustedProviders: [...state.exhaustedProviders],
      durationMs,
    }
  }

  advanceStrategy(
    state: RecoveryLoopState,
    failureCtx: FailureContext,
    _effectiveTask: TaskDescriptor,
    partialEvents: AgentEvent[],
  ): RecoveryStrategy {
    state.lastStrategy = this.selectStrategy(failureCtx)

    if (state.lastStrategy === 'retry-different-provider') {
      state.currentInput = CrossProviderHandoff.enrichInput(state.currentInput, partialEvents)
    }

    state.currentInput = applyRecoveryStrategy({
      strategy: state.lastStrategy,
      input: state.currentInput,
      exhaustedProviders: new Set(state.exhaustedProviders),
      budgetMultiplier: this.config.budgetMultiplier,
      resolveAlternativeProvider: (excluded) => this.resolveAvailableProvider(excluded),
    })

    return state.lastStrategy
  }

  /** Run one attempt: route, execute, and drain the adapter output. */
  async runAttempt(
    traceId: string,
    attempt: number,
    state: RecoveryLoopState,
    effectiveTask: TaskDescriptor,
    overallStart: number,
    partialEvents: AgentEvent[],
  ): Promise<AttemptOutcome> {
    try {
      const { adapter } = this.routeForAttempt(traceId, attempt, state, effectiveTask)

      this.emitter.attemptStarted(
        traceId,
        attempt,
        this.config.maxAttempts,
        state.lastStrategy,
        adapter.providerId,
      )

      const { result, didComplete, didFail } = await this.collectAdapterOutput(
        adapter.execute(state.currentInput),
        traceId,
        partialEvents,
      )

      // Guard against adapters that complete the generator without any
      // terminal signal. This prevents false-positive success results that
      // would otherwise mask real failures.
      if (didFail || !didComplete) {
        throw new Error(
          didFail
            ? 'Adapter emitted adapter:failed without throwing — treating as failure'
            : 'Adapter completed without emitting a terminal event (adapter:completed or assistant message)',
        )
      }

      this.registry.recordSuccess(adapter.providerId)
      this.traceCapture.completeTrace(traceId)

      this.emitter.succeeded(traceId, attempt, state.lastStrategy, Date.now() - overallStart)

      return {
        kind: 'success',
        result: {
          success: true,
          strategy: state.lastStrategy,
          result,
          providerId: adapter.providerId,
          totalAttempts: attempt,
          totalDurationMs: Date.now() - overallStart,
        },
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      return { kind: 'failure', error, rawError: err }
    }
  }

  /** Drain an adapter generator, recording events and collecting the result. */
  private async collectAdapterOutput(
    gen: AsyncGenerator<AgentEvent>,
    traceId: string,
    partialEvents: AgentEvent[],
  ): Promise<{ result: string; didComplete: boolean; didFail: boolean }> {
    let result = ''
    let didComplete = false
    let didFail = false
    for await (const event of gen) {
      partialEvents.push(event)
      this.traceCapture.recordEvent(traceId, event)
      if (event.type === 'adapter:completed') {
        result = event.result
        didComplete = true
      }
      if (event.type === 'adapter:message' && event.role === 'assistant') {
        result += event.content
        didComplete = true
      }
      if (event.type === 'adapter:failed') {
        didFail = true
      }
    }
    return { result, didComplete, didFail }
  }

  /**
   * Decide whether the loop terminates after a failed attempt. Returns a
   * `RecoveryResult` for terminal paths or `undefined` to continue the loop.
   */
  async handleFailure(ctx: AttemptFailureContext): Promise<RecoveryResult | undefined> {
    const {
      traceId,
      error,
      rawError,
      attempt,
      attemptStart,
      overallStart,
      state,
      task,
      effectiveTask,
      partialEvents,
    } = ctx
    const durationMs = Date.now() - attemptStart

    if (ForgeError.is(rawError) && rawError.code === 'AGENT_ABORTED') {
      return this.completeCancelled(traceId, state, attempt, overallStart, error.message)
    }

    const failureCtx = this.buildFailureContext(state, error, rawError, attempt, durationMs, task)
    const failedProviderId = failureCtx.failedProvider

    this.traceCapture.recordDecision(traceId, {
      type: 'fallback',
      providerId: failedProviderId,
      reason: `Attempt ${attempt} failed: ${error.message}`,
    })

    if (attempt >= this.config.maxAttempts) {
      return this.completeExhausted(traceId, state, failedProviderId, attempt, overallStart, error.message)
    }

    this.advanceStrategy(state, failureCtx, effectiveTask, partialEvents)

    if (state.lastStrategy === 'abort') {
      return this.completeAbort(traceId, state, failedProviderId, attempt, overallStart, error.message)
    }

    if (state.lastStrategy === 'escalate-human') {
      return this.completeEscalateHuman(
        traceId,
        state,
        failureCtx,
        failedProviderId,
        attempt,
        overallStart,
        error.message,
      )
    }

    return undefined
  }

  /** Stream-mode counterpart of `completeCancelled`. */
  async *emitStreamCancellation(
    traceId: string,
    state: RecoveryLoopState,
    attempt: number,
    durationMs: number,
    errorMessage: string,
  ): AsyncGenerator<AgentEvent> {
    const resolvedProviderId =
      state.lastProviderId ?? this.resolveAvailableProvider(state.exhaustedProviders)
    const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: effectiveProviderId,
      reason: `Execution aborted: ${errorMessage}`,
    })
    this.traceCapture.completeTrace(traceId)
    this.emitter.cancelled(traceId, resolvedProviderId, attempt, durationMs, errorMessage)
    yield createRecoveryCancelledEvent(resolvedProviderId, attempt, durationMs, errorMessage)
  }

  emitApprovalRequested(traceId: string, input: AgentInput, failure: FailureContext): void {
    this.emitter.approvalRequested(traceId, input, failure)
  }

  /**
   * Stream-mode terminal: max attempts exhausted. Records the abort,
   * completes the trace, and throws an `ALL_ADAPTERS_EXHAUSTED` ForgeError
   * with the surrounding error attached as `cause`.
   */
  throwStreamExhausted(
    traceId: string,
    failedProviderId: AdapterProviderId,
    attempt: number,
    error: Error,
    rawError: unknown,
  ): never {
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: `Max attempts (${this.config.maxAttempts}) exhausted`,
    })
    this.traceCapture.completeTrace(traceId)

    throw new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: `Recovery exhausted after ${attempt} attempts: ${error.message}`,
      recoverable: false,
      cause: rawError instanceof Error ? rawError : undefined,
      context: {
        providerId: failedProviderId,
        attempts: attempt,
        maxAttempts: this.config.maxAttempts,
      },
    })
  }

  /**
   * Stream-mode terminal: strategy chose `abort` or `escalate-human`.
   * Records the decision, optionally emits the approval request, and
   * throws an `ALL_ADAPTERS_EXHAUSTED` ForgeError.
   */
  throwStreamStopped(
    traceId: string,
    state: RecoveryLoopState,
    failureCtx: FailureContext,
    failedProviderId: AdapterProviderId,
    attempt: number,
    error: Error,
    nextStrategy: RecoveryStrategy,
  ): never {
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: nextStrategy === 'abort' ? 'Strategy selected abort' : 'Escalated to human',
    })
    this.traceCapture.completeTrace(traceId)

    if (nextStrategy === 'escalate-human') {
      this.emitter.approvalRequested(traceId, state.currentInput, failureCtx)
    }

    throw new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: `Recovery stopped (${nextStrategy}): ${error.message}`,
      recoverable: nextStrategy === 'escalate-human',
      context: {
        providerId: failedProviderId,
        strategy: nextStrategy,
        attempts: attempt,
      },
    })
  }

  resolveAvailableProvider(
    excludedProviders: AdapterProviderId[] = [],
  ): AdapterProviderId | undefined {
    return resolveFallbackProviderId(this.registry.listAdapters(), excludedProviders)
  }

  // -------------------------------------------------------------------------
  // Terminal-path helpers
  // -------------------------------------------------------------------------

  private completeCancelled(
    traceId: string,
    state: RecoveryLoopState,
    attempt: number,
    overallStart: number,
    errorMessage: string,
  ): RecoveryCancelledResult {
    const resolvedProviderId =
      state.lastProviderId ?? this.resolveAvailableProvider(state.exhaustedProviders)
    const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: effectiveProviderId,
      reason: `Execution aborted: ${errorMessage}`,
    })
    this.traceCapture.completeTrace(traceId)
    this.emitter.cancelled(
      traceId,
      resolvedProviderId,
      attempt,
      Date.now() - overallStart,
      errorMessage,
    )
    return createCancelledRecoveryResult(
      'abort',
      resolvedProviderId,
      attempt,
      Date.now() - overallStart,
      errorMessage,
    )
  }

  private completeExhausted(
    traceId: string,
    state: RecoveryLoopState,
    failedProviderId: AdapterProviderId,
    attempt: number,
    overallStart: number,
    errorMessage: string,
  ): RecoveryFailureResult {
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: `Max attempts (${this.config.maxAttempts}) exhausted`,
    })
    this.traceCapture.completeTrace(traceId)

    this.emitter.exhausted(
      traceId,
      attempt,
      this.config.strategyOrder,
      Date.now() - overallStart,
      errorMessage,
    )

    return {
      success: false,
      strategy: state.lastStrategy,
      totalAttempts: attempt,
      totalDurationMs: Date.now() - overallStart,
      error: errorMessage,
      providerId: state.lastProviderId ?? failedProviderId,
    }
  }

  private completeAbort(
    traceId: string,
    state: RecoveryLoopState,
    failedProviderId: AdapterProviderId,
    attempt: number,
    overallStart: number,
    errorMessage: string,
  ): RecoveryFailureResult {
    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: 'Strategy selected abort',
    })
    this.traceCapture.completeTrace(traceId)

    return {
      success: false,
      strategy: 'abort',
      totalAttempts: attempt,
      totalDurationMs: Date.now() - overallStart,
      error: errorMessage,
      providerId: state.lastProviderId ?? failedProviderId,
    }
  }

  private async completeEscalateHuman(
    traceId: string,
    state: RecoveryLoopState,
    failureCtx: FailureContext,
    failedProviderId: AdapterProviderId,
    attempt: number,
    overallStart: number,
    errorMessage: string,
  ): Promise<RecoveryResult | undefined> {
    if (this.config.escalationHandler) {
      const escalationResult = await this.handleEscalation(
        traceId,
        failureCtx,
        overallStart,
        attempt,
        state.lastProviderId,
        failedProviderId,
      )
      if (escalationResult) return escalationResult
      return undefined
    }

    this.emitter.approvalRequested(traceId, state.currentInput, failureCtx)

    this.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: 'Escalated to human — awaiting approval',
    })
    this.traceCapture.completeTrace(traceId)

    return {
      success: false,
      strategy: 'escalate-human',
      totalAttempts: attempt,
      totalDurationMs: Date.now() - overallStart,
      error: `Escalated to human after ${attempt} failed attempts: ${errorMessage}`,
      providerId: state.lastProviderId ?? failedProviderId,
    }
  }

  private async handleEscalation(
    traceId: string,
    failure: FailureContext,
    overallStart: number,
    attempt: number,
    lastProviderId: AdapterProviderId | undefined,
    failedProviderId: AdapterProviderId,
  ): Promise<RecoveryResult | undefined> {
    const handler = this.config.escalationHandler!
    const requestId = crypto.randomUUID()
    const timeoutMs = this.config.escalationTimeoutMs ?? 300_000

    await handler.notify({
      requestId,
      failedProviderId: failure.failedProvider,
      error: failure.error,
      traceId,
      attempts: [],
      suggestions: ['retry', 'retry-different', 'abort'],
    })

    try {
      const resolution = await handler.waitForResolution(requestId, timeoutMs)

      switch (resolution.action) {
        case 'retry':
        case 'retry-different':
          this.traceCapture.recordDecision(traceId, {
            type: 'recovery',
            providerId: failedProviderId,
            reason: `Human resolved escalation: ${resolution.action}${resolution.reason ? ` — ${resolution.reason}` : ''}`,
          })
          return undefined

        case 'override':
          this.traceCapture.recordDecision(traceId, {
            type: 'recovery',
            providerId: resolution.providerId ?? failedProviderId,
            reason: `Human override${resolution.reason ? `: ${resolution.reason}` : ''}`,
          })
          return undefined

        case 'abort':
        default: {
          this.traceCapture.recordDecision(traceId, {
            type: 'abort',
            providerId: failedProviderId,
            reason: `Human aborted escalation${resolution.reason ? `: ${resolution.reason}` : ''}`,
          })
          this.traceCapture.completeTrace(traceId)

          return {
            success: false,
            strategy: 'escalate-human',
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: `Human aborted after escalation: ${failure.error}`,
            providerId: lastProviderId ?? failedProviderId,
          }
        }
      }
    } catch {
      this.traceCapture.recordDecision(traceId, {
        type: 'abort',
        providerId: failedProviderId,
        reason: 'Escalation timed out — aborting',
      })
      this.traceCapture.completeTrace(traceId)

      return {
        success: false,
        strategy: 'escalate-human',
        totalAttempts: attempt,
        totalDurationMs: Date.now() - overallStart,
        error: `Escalation timed out after ${timeoutMs}ms: ${failure.error}`,
        providerId: lastProviderId ?? failedProviderId,
      }
    }
  }

  private selectStrategy(failure: FailureContext): RecoveryStrategy {
    return selectRecoveryStrategy({
      failure,
      strategyOrder: this.config.strategyOrder,
      availableProviders: this.registry.listAdapters(),
      strategySelector: this.config.strategySelector,
    })
  }
}
