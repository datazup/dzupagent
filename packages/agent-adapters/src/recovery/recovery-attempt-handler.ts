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

import { ForgeError } from '@dzupagent/core/events'

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
import { applyRecoveryStrategy } from './recovery-strategy-application.js'
import type { RecoveryEventEmitter } from './recovery-event-emitter.js'
import { selectRecoveryStrategy } from './recovery-strategy.js'
import type {
  AttemptFailureContext,
  AttemptOutcome,
  RecoveryAttemptHandlerConfig,
  RecoveryLoopState,
  TraceCaptureLike,
} from './recovery-attempt-types.js'
import {
  completeAbort,
  completeCancelled,
  completeEscalateHuman,
  completeExhausted,
  type TerminalsDeps,
} from './recovery-attempt-terminals.js'
import {
  emitStreamCancellation,
  throwStreamExhausted,
  throwStreamStopped,
} from './recovery-attempt-stream.js'
import type {
  FailureContext,
  RecoveryResult,
  RecoveryStrategy,
} from './recovery-types.js'

// Re-export the type surface so existing import sites (including
// `adapter-recovery.ts` and the unit tests under `__tests__/`) continue to
// resolve `TraceCaptureLike`, `RecoveryLoopState`, `AttemptOutcome`,
// `AttemptFailureContext`, and `RecoveryAttemptHandlerConfig` from this
// module. The canonical declarations now live in `recovery-attempt-types.ts`.
export type {
  AttemptFailureContext,
  AttemptOutcome,
  RecoveryAttemptHandlerConfig,
  RecoveryLoopState,
  TraceCaptureLike,
} from './recovery-attempt-types.js'

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
    const deps = this.terminalsDeps()

    if (ForgeError.is(rawError) && rawError.code === 'AGENT_ABORTED') {
      return completeCancelled(deps, traceId, state, attempt, overallStart, error.message)
    }

    const failureCtx = this.buildFailureContext(state, error, rawError, attempt, durationMs, task)
    const failedProviderId = failureCtx.failedProvider

    this.traceCapture.recordDecision(traceId, {
      type: 'fallback',
      providerId: failedProviderId,
      reason: `Attempt ${attempt} failed: ${error.message}`,
    })

    if (attempt >= this.config.maxAttempts) {
      return completeExhausted(deps, traceId, state, failedProviderId, attempt, overallStart, error.message)
    }

    this.advanceStrategy(state, failureCtx, effectiveTask, partialEvents)

    if (state.lastStrategy === 'abort') {
      return completeAbort(deps, traceId, state, failedProviderId, attempt, overallStart, error.message)
    }

    if (state.lastStrategy === 'escalate-human') {
      return completeEscalateHuman(
        deps,
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

  /** Build the dependency bundle passed to terminal-path helpers. */
  private terminalsDeps(): TerminalsDeps {
    return {
      traceCapture: this.traceCapture,
      emitter: this.emitter,
      config: this.config,
      resolveAvailableProvider: (excluded) => this.resolveAvailableProvider(excluded),
    }
  }

  /** Stream-mode counterpart of `completeCancelled`. Delegates to the
   * extracted helper while preserving the public surface. */
  emitStreamCancellation(
    traceId: string,
    state: RecoveryLoopState,
    attempt: number,
    durationMs: number,
    errorMessage: string,
  ): AsyncGenerator<AgentEvent> {
    return emitStreamCancellation(this.terminalsDeps(), traceId, state, attempt, durationMs, errorMessage)
  }

  emitApprovalRequested(traceId: string, input: AgentInput, failure: FailureContext): void {
    this.emitter.approvalRequested(traceId, input, failure)
  }

  /**
   * Stream-mode terminal: max attempts exhausted. Delegates to the extracted
   * helper which records the abort, completes the trace, and throws an
   * `ALL_ADAPTERS_EXHAUSTED` ForgeError with the surrounding error attached
   * as `cause`.
   */
  throwStreamExhausted(
    traceId: string,
    failedProviderId: AdapterProviderId,
    attempt: number,
    error: Error,
    rawError: unknown,
  ): never {
    throwStreamExhausted(this.terminalsDeps(), traceId, failedProviderId, attempt, error, rawError)
  }

  /**
   * Stream-mode terminal: strategy chose `abort` or `escalate-human`.
   * Delegates to the extracted helper which records the decision, optionally
   * emits the approval request, and throws an `ALL_ADAPTERS_EXHAUSTED`
   * ForgeError.
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
    throwStreamStopped(
      this.terminalsDeps(),
      traceId,
      state,
      failureCtx,
      failedProviderId,
      attempt,
      error,
      nextStrategy,
    )
  }

  resolveAvailableProvider(
    excludedProviders: AdapterProviderId[] = [],
  ): AdapterProviderId | undefined {
    return resolveFallbackProviderId(this.registry.listAdapters(), excludedProviders)
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
