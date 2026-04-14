/**
 * AdapterRecoveryCopilot — recovery strategies and trace capture for
 * multi-agent orchestration failures.
 *
 * When an adapter execution fails, the copilot applies a configurable
 * sequence of recovery strategies (retry, fallback provider, increase
 * budget, simplify task, escalate to human, or abort) and records a
 * full execution trace for post-mortem analysis.
 *
 * @module recovery/adapter-recovery
 */

import { ForgeError } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'
import type { EscalationHandler } from './escalation-handler.js'
import { CrossProviderHandoff } from './cross-provider-handoff.js'

// ---------------------------------------------------------------------------
// Recovery strategy type
// ---------------------------------------------------------------------------

export type RecoveryStrategy =
  | 'retry-same-provider'
  | 'retry-different-provider'
  | 'increase-budget'
  | 'simplify-task'
  | 'escalate-human'
  | 'abort'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TraceEvictionConfig {
  /** Max number of traces. Default: 1000 */
  maxTraces?: number | undefined
  /** TTL per trace in ms. Default: 3_600_000 (1 hour) */
  ttlMs?: number | undefined
  /** Sweep interval in ms. Default: 300_000 (5 min) */
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

// ---------------------------------------------------------------------------
// Failure context
// ---------------------------------------------------------------------------

export interface FailureContext {
  /** Original input */
  input: AgentInput
  /** Task descriptor */
  task?: TaskDescriptor | undefined
  /** Which provider failed */
  failedProvider: AdapterProviderId
  /** Error message */
  error: string
  /** Error code */
  errorCode?: string | undefined
  /** Attempt number (1-based) */
  attemptNumber: number
  /** All providers that have failed so far */
  exhaustedProviders: AdapterProviderId[]
  /** Duration of the failed attempt */
  durationMs: number
}

// ---------------------------------------------------------------------------
// Recovery result
// ---------------------------------------------------------------------------

export interface RecoverySuccessResult {
  success: true
  strategy: RecoveryStrategy
  result: string
  providerId?: AdapterProviderId | undefined
  totalAttempts: number
  totalDurationMs: number
}

export interface RecoveryFailureResult {
  success: false
  strategy: RecoveryStrategy
  totalAttempts: number
  totalDurationMs: number
  error: string
  providerId?: AdapterProviderId | undefined
  cancelled?: false | undefined
}

export interface RecoveryCancelledResult {
  success: false
  cancelled: true
  strategy: 'abort'
  totalAttempts: number
  totalDurationMs: number
  error: string
  providerId?: AdapterProviderId | undefined
}

export type RecoveryResult =
  | RecoverySuccessResult
  | RecoveryFailureResult
  | RecoveryCancelledResult

function createCancelledRecoveryResult(
  strategy: 'abort',
  providerId: AdapterProviderId | undefined,
  totalAttempts: number,
  totalDurationMs: number,
  error: string,
): RecoveryCancelledResult {
  return {
    success: false,
    cancelled: true,
    strategy,
    providerId,
    totalAttempts,
    totalDurationMs,
    error,
  }
}

function createRecoveryCancelledEvent(
  providerId: AdapterProviderId | undefined,
  totalAttempts: number,
  totalDurationMs: number,
  error: string,
): AgentEvent {
  return {
    type: 'recovery:cancelled',
    providerId: providerId ?? ('unknown' as AdapterProviderId),
    strategy: 'abort',
    error,
    totalAttempts,
    totalDurationMs,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------

/** Trace capture for post-mortem analysis */
export interface ExecutionTrace {
  traceId: string
  startedAt: Date
  completedAt?: Date | undefined
  input: AgentInput
  decisions: TraceDecision[]
  events: TracedEvent[]
}

export interface TraceDecision {
  timestamp: Date
  type: 'route' | 'fallback' | 'recovery' | 'abort'
  providerId: AdapterProviderId
  reason: string
}

export interface TracedEvent {
  timestamp: Date
  event: AgentEvent
}

// ---------------------------------------------------------------------------
// Default strategy order
// ---------------------------------------------------------------------------

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
// ExecutionTraceCapture
// ---------------------------------------------------------------------------

export class ExecutionTraceCapture {
  private readonly traces = new Map<string, ExecutionTrace>()
  private readonly createdAt = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private readonly maxTraces: number
  private readonly ttlMs: number

  constructor(config?: TraceEvictionConfig) {
    this.maxTraces = config?.maxTraces ?? 1000
    this.ttlMs = config?.ttlMs ?? 3_600_000
    const sweepMs = config?.sweepIntervalMs ?? 300_000
    this.sweepTimer = setInterval(() => this.evictExpired(), sweepMs)
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref()
    }
  }

  /** Start capturing a trace */
  startTrace(input: AgentInput): ExecutionTrace {
    const traceId = crypto.randomUUID()
    const trace: ExecutionTrace = {
      traceId,
      startedAt: new Date(),
      input,
      decisions: [],
      events: [],
    }
    this.traces.set(traceId, trace)
    this.createdAt.set(traceId, Date.now())
    this.enforceMaxSize()
    return trace
  }

  /** Record a routing/recovery decision */
  recordDecision(traceId: string, decision: Omit<TraceDecision, 'timestamp'>): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.decisions.push({ ...decision, timestamp: new Date() })
  }

  /** Record an event */
  recordEvent(traceId: string, event: AgentEvent): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.events.push({ timestamp: new Date(), event })
  }

  /** Complete the trace */
  completeTrace(traceId: string): ExecutionTrace | undefined {
    const trace = this.traces.get(traceId)
    if (!trace) return undefined
    trace.completedAt = new Date()
    return trace
  }

  /** Get a trace by ID */
  getTrace(traceId: string): ExecutionTrace | undefined {
    return this.traces.get(traceId)
  }

  /** Get all traces */
  getAllTraces(): ExecutionTrace[] {
    return [...this.traces.values()]
  }

  /** Clear all traces */
  clear(): void {
    this.traces.clear()
    this.createdAt.clear()
  }

  /** Stop the sweep timer and release resources */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [id, created] of this.createdAt) {
      if (now - created > this.ttlMs) {
        this.traces.delete(id)
        this.createdAt.delete(id)
      }
    }
  }

  private enforceMaxSize(): void {
    if (this.traces.size <= this.maxTraces) return
    const sorted = [...this.createdAt.entries()].sort((a, b) => a[1] - b[1])
    const toRemove = sorted.slice(0, this.traces.size - this.maxTraces)
    for (const [id] of toRemove) {
      this.traces.delete(id)
      this.createdAt.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// AdapterRecoveryCopilot
// ---------------------------------------------------------------------------

export class AdapterRecoveryCopilot {
  private readonly _traceCapture: ExecutionTraceCapture
  private readonly config: RecoveryConfig
  private readonly maxAttempts: number
  private readonly strategyOrder: RecoveryStrategy[]
  private readonly budgetMultiplier: number
  private readonly eventBus: DzupEventBus | undefined
  private readonly strategySelector:
    | ((failure: FailureContext) => RecoveryStrategy)
    | undefined

  constructor(
    private readonly registry: AdapterRegistry,
    config?: RecoveryConfig,
  ) {
    this.config = config ?? {}
    this._traceCapture = new ExecutionTraceCapture(config?.traceEviction)
    this.maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.strategyOrder = config?.strategyOrder ?? DEFAULT_STRATEGY_ORDER
    this.budgetMultiplier = config?.budgetMultiplier ?? DEFAULT_BUDGET_MULTIPLIER
    this.eventBus = config?.eventBus
    this.strategySelector = config?.strategySelector
  }

  /** Get the trace capture instance for inspection */
  get traceCapture(): ExecutionTraceCapture {
    return this._traceCapture
  }

  /**
   * Execute with automatic recovery on failure.
   * Tries the primary execution, and on failure applies recovery strategies.
   */
  async executeWithRecovery(
    input: AgentInput,
    task?: TaskDescriptor,
  ): Promise<RecoveryResult> {
    const overallStart = Date.now()
    const trace = this._traceCapture.startTrace(input)

    const effectiveTask: TaskDescriptor = task ?? {
      prompt: input.prompt,
      tags: [],
    }

    const exhaustedProviders: AdapterProviderId[] = []
    let lastStrategy: RecoveryStrategy = 'retry-different-provider'
    let lastProviderId: AdapterProviderId | undefined
    let currentInput = { ...input }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Exponential backoff between retry attempts
      if (attempt > 1) {
        await this.delayBeforeRetry(attempt, input.signal)
      }

      const attemptStart = Date.now()
      const partialEvents: AgentEvent[] = []

      try {
        // Determine which provider to use for this attempt
        const { adapter, decision } = this.registry.getForTask(effectiveTask)
        lastProviderId = adapter.providerId

        this._traceCapture.recordDecision(trace.traceId, {
          type: attempt === 1 ? 'route' : 'recovery',
          providerId: adapter.providerId,
          reason:
            attempt === 1
              ? `Initial routing: ${decision.reason}`
              : `Recovery attempt ${attempt} via strategy "${lastStrategy}"`,
        })

        this.emitRecoveryAttemptStarted(
          trace.traceId,
          attempt,
          this.maxAttempts,
          lastStrategy,
          adapter.providerId,
        )

        // Collect output from streaming execution
        let result = ''
        let didComplete = false
        let didFail = false
        const gen = adapter.execute(currentInput)
        for await (const event of gen) {
          partialEvents.push(event)
          this._traceCapture.recordEvent(trace.traceId, event)
          if (event.type === 'adapter:completed') {
            result = event.result
            didComplete = true
          }
          if (event.type === 'adapter:message' && event.role === 'assistant') {
            result += event.content
            didComplete = true
          }
          if (event.type === 'adapter:failed') {
            // Record the failure event. The adapter is expected to throw after
            // emitting this; that throw will be caught by the surrounding try/catch.
            // We track it so we can guard against adapters that silently emit
            // adapter:failed without throwing (see guard below).
            didFail = true
          }
        }

        // Guard against adapters that complete the generator without any terminal
        // signal. This prevents false-positive success results that mask real failures.
        // - If adapter:failed was emitted but no throw followed, treat as failure.
        // - If neither adapter:completed nor any assistant message was seen, also fail.
        if (didFail || !didComplete) {
          throw new Error(
            didFail
              ? 'Adapter emitted adapter:failed without throwing — treating as failure'
              : 'Adapter completed without emitting a terminal event (adapter:completed or assistant message)',
          )
        }

        // Success
        this.registry.recordSuccess(adapter.providerId)
        this._traceCapture.completeTrace(trace.traceId)

        this.emitRecoverySucceeded(
          trace.traceId,
          attempt,
          lastStrategy,
          Date.now() - overallStart,
        )

        return {
          success: true,
          strategy: lastStrategy,
          result,
          providerId: adapter.providerId,
          totalAttempts: attempt,
          totalDurationMs: Date.now() - overallStart,
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const durationMs = Date.now() - attemptStart

        if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
          const resolvedProviderId =
            lastProviderId ?? this.resolveAvailableProvider(exhaustedProviders)
          const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: effectiveProviderId,
            reason: `Execution aborted: ${error.message}`,
          })
          this._traceCapture.completeTrace(trace.traceId)
          this.emitRecoveryCancelledEvent(
            trace.traceId,
            resolvedProviderId,
            attempt,
            Date.now() - overallStart,
            error.message,
          )
          return createCancelledRecoveryResult(
            'abort',
            resolvedProviderId,
            attempt,
            Date.now() - overallStart,
            error.message,
          )
        }

        if (lastProviderId && !exhaustedProviders.includes(lastProviderId)) {
          exhaustedProviders.push(lastProviderId)
        }

        const failureCtx: FailureContext = {
          input: currentInput,
          task,
          failedProvider:
            lastProviderId ??
            this.resolveAvailableProvider(exhaustedProviders) ??
            ('unknown' as AdapterProviderId),
          error: error.message,
          errorCode:
            err instanceof ForgeError ? err.code : undefined,
          attemptNumber: attempt,
          exhaustedProviders: [...exhaustedProviders],
          durationMs,
        }
        const failedProviderId = failureCtx.failedProvider

        this._traceCapture.recordDecision(trace.traceId, {
          type: 'fallback',
          providerId: failedProviderId,
          reason: `Attempt ${attempt} failed: ${error.message}`,
        })

        // Note: no dedicated 'recovery:attempt_failed' event type exists.
        // The failure is recorded in the trace decision above and will be
        // surfaced via 'recovery:exhausted' if all attempts fail.

        // If we have exhausted all attempts, break
        if (attempt >= this.maxAttempts) {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: failedProviderId,
            reason: `Max attempts (${this.maxAttempts}) exhausted`,
          })
          this._traceCapture.completeTrace(trace.traceId)

          this.emitRecoveryExhausted(
            trace.traceId,
            attempt,
            this.strategyOrder,
            Date.now() - overallStart,
            error.message,
          )

          return {
            success: false,
            strategy: lastStrategy,
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: error.message,
            providerId: lastProviderId ?? failedProviderId,
          }
        }

        // Select next strategy
        lastStrategy = this.selectStrategy(failureCtx)

        // Enrich input with partial progress when handing off to a different provider
        if (lastStrategy === 'retry-different-provider') {
          currentInput = CrossProviderHandoff.enrichInput(currentInput, partialEvents)
        }

        // Apply the strategy for the next attempt
        currentInput = this.applyStrategy(
          lastStrategy,
          currentInput,
          effectiveTask,
          failureCtx,
          new Set(exhaustedProviders),
        )

        // If strategy is abort, stop immediately
        if (lastStrategy === 'abort') {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: failedProviderId,
            reason: 'Strategy selected abort',
          })
          this._traceCapture.completeTrace(trace.traceId)

          return {
            success: false,
            strategy: 'abort',
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: error.message,
            providerId: lastProviderId ?? failedProviderId,
          }
        }

        // If strategy is escalate-human, try escalation handler if available,
        // otherwise emit approval event and abort.
        if (lastStrategy === 'escalate-human') {
          if (this.config.escalationHandler) {
            const escalationResult = await this.handleEscalation(
              trace.traceId,
              failureCtx,
              currentInput,
              overallStart,
              attempt,
              lastProviderId,
              failedProviderId,
              exhaustedProviders,
              effectiveTask,
            )
            if (escalationResult) return escalationResult
            // If handleEscalation returns undefined, the resolution was to
            // retry — fall through to next iteration.
            continue
          }

          this.emitApprovalRequest(trace.traceId, currentInput, failureCtx)

          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: failedProviderId,
            reason: 'Escalated to human — awaiting approval',
          })
          this._traceCapture.completeTrace(trace.traceId)

          return {
            success: false,
            strategy: 'escalate-human',
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: `Escalated to human after ${attempt} failed attempts: ${error.message}`,
            providerId: lastProviderId ?? failedProviderId,
          }
        }
      }
    }

    // Should not reach here, but satisfy TypeScript
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
   * Wrap an async generator with recovery — if the source fails,
   * retry with a different strategy.
   */
  async *executeWithRecoveryStream(
    input: AgentInput,
    task?: TaskDescriptor,
  ): AsyncGenerator<AgentEvent> {
    const trace = this._traceCapture.startTrace(input)

    const effectiveTask: TaskDescriptor = task ?? {
      prompt: input.prompt,
      tags: [],
    }

    const exhaustedProviders: AdapterProviderId[] = []
    let currentInput = { ...input }
    let lastStrategy: RecoveryStrategy = 'retry-different-provider'
    let lastProviderId: AdapterProviderId | undefined

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Exponential backoff between retry attempts
      if (attempt > 1) {
        await this.delayBeforeRetry(attempt, input.signal)
      }

      const partialEvents: AgentEvent[] = []

      try {
        const { adapter, decision } = this.registry.getForTask(effectiveTask)
        lastProviderId = adapter.providerId

        this._traceCapture.recordDecision(trace.traceId, {
          type: attempt === 1 ? 'route' : 'recovery',
          providerId: adapter.providerId,
          reason:
            attempt === 1
              ? `Initial routing: ${decision.reason}`
              : `Recovery attempt ${attempt} via strategy "${lastStrategy}"`,
        })

        const gen = adapter.execute(currentInput)

        for await (const event of gen) {
          partialEvents.push(event)
          this._traceCapture.recordEvent(trace.traceId, event)
          yield event
        }

        // If we got here, execution succeeded
        this.registry.recordSuccess(adapter.providerId)
        this._traceCapture.completeTrace(trace.traceId)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
          const resolvedProviderId =
            lastProviderId ?? this.resolveAvailableProvider(exhaustedProviders)
          const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: effectiveProviderId,
            reason: `Execution aborted: ${error.message}`,
          })
          this._traceCapture.completeTrace(trace.traceId)
          this.emitRecoveryCancelledEvent(
            trace.traceId,
            resolvedProviderId,
            attempt,
            Date.now() - trace.startedAt.getTime(),
            error.message,
          )
          yield createRecoveryCancelledEvent(
            resolvedProviderId,
            attempt,
            Date.now() - trace.startedAt.getTime(),
            error.message,
          )
          return
        }

        // Find which provider just failed
        const failedProvider =
          lastProviderId ?? this.resolveAvailableProvider(exhaustedProviders)
        const effectiveProviderId = failedProvider ?? ('unknown' as AdapterProviderId)

        if (
          failedProvider &&
          !exhaustedProviders.includes(failedProvider)
        ) {
          exhaustedProviders.push(failedProvider)
        }

        const failureCtx: FailureContext = {
          input: currentInput,
          task,
          failedProvider: effectiveProviderId,
          error: error.message,
          errorCode:
            err instanceof ForgeError ? err.code : undefined,
          attemptNumber: attempt,
          exhaustedProviders: [...exhaustedProviders],
          durationMs: 0,
        }

        // Yield a failed event so consumers can observe the failure
        yield {
          type: 'adapter:failed',
          providerId: effectiveProviderId,
          error: error.message,
          code: 'RECOVERY_ATTEMPT_FAILED',
          timestamp: Date.now(),
        }

        if (attempt >= this.maxAttempts) {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: effectiveProviderId,
            reason: `Max attempts (${this.maxAttempts}) exhausted`,
          })
          this._traceCapture.completeTrace(trace.traceId)

          throw new ForgeError({
            code: 'ALL_ADAPTERS_EXHAUSTED',
            message: `Recovery exhausted after ${attempt} attempts: ${error.message}`,
            recoverable: false,
            cause: err instanceof Error ? err : undefined,
            context: {
              providerId: effectiveProviderId,
              attempts: attempt,
              maxAttempts: this.maxAttempts,
            },
          })
        }

        lastStrategy = this.selectStrategy(failureCtx)

        // Enrich input with partial progress when handing off to a different provider
        if (lastStrategy === 'retry-different-provider') {
          currentInput = CrossProviderHandoff.enrichInput(currentInput, partialEvents)
        }

        if (lastStrategy === 'abort' || lastStrategy === 'escalate-human') {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: effectiveProviderId,
            reason:
              lastStrategy === 'abort'
                ? 'Strategy selected abort'
                : 'Escalated to human',
          })
          this._traceCapture.completeTrace(trace.traceId)

          if (lastStrategy === 'escalate-human') {
            this.emitApprovalRequest(trace.traceId, currentInput, failureCtx)
          }

          throw new ForgeError({
            code: 'ALL_ADAPTERS_EXHAUSTED',
            message: `Recovery stopped (${lastStrategy}): ${error.message}`,
            recoverable: lastStrategy === 'escalate-human',
            context: {
              providerId: effectiveProviderId,
              strategy: lastStrategy,
              attempts: attempt,
            },
          })
        }

        currentInput = this.applyStrategy(
          lastStrategy,
          currentInput,
          effectiveTask,
          failureCtx,
          new Set(exhaustedProviders),
        )
      }
    }

    this._traceCapture.completeTrace(trace.traceId)
  }

  // ---------------------------------------------------------------------------
  // Escalation handler
  // ---------------------------------------------------------------------------

  /**
   * Delegate to the configured EscalationHandler, wait for a human resolution,
   * and translate the decision into a RecoveryResult or `undefined` (meaning
   * "continue retrying").
   */
  private async handleEscalation(
    traceId: string,
    failure: FailureContext,
    _currentInput: AgentInput,
    overallStart: number,
    attempt: number,
    lastProviderId: AdapterProviderId | undefined,
    failedProviderId: AdapterProviderId,
    _exhaustedProviders: AdapterProviderId[],
    _task: TaskDescriptor,
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
          // Let the main loop continue with another attempt
          this._traceCapture.recordDecision(traceId, {
            type: 'recovery',
            providerId: failedProviderId,
            reason: `Human resolved escalation: ${resolution.action}${resolution.reason ? ` — ${resolution.reason}` : ''}`,
          })
          return undefined

        case 'override':
          // Override also retries — the caller can inspect resolution details
          this._traceCapture.recordDecision(traceId, {
            type: 'recovery',
            providerId: resolution.providerId ?? failedProviderId,
            reason: `Human override${resolution.reason ? `: ${resolution.reason}` : ''}`,
          })
          return undefined

        case 'abort':
        default: {
          this._traceCapture.recordDecision(traceId, {
            type: 'abort',
            providerId: failedProviderId,
            reason: `Human aborted escalation${resolution.reason ? `: ${resolution.reason}` : ''}`,
          })
          this._traceCapture.completeTrace(traceId)

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
      // Timeout — fall through to abort
      this._traceCapture.recordDecision(traceId, {
        type: 'abort',
        providerId: failedProviderId,
        reason: 'Escalation timed out — aborting',
      })
      this._traceCapture.completeTrace(traceId)

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

  // ---------------------------------------------------------------------------
  // Backoff
  // ---------------------------------------------------------------------------

  private async delayBeforeRetry(attemptNumber: number, signal?: AbortSignal): Promise<void> {
    const base = this.config.backoffMs ?? 1000
    const multiplier = this.config.backoffMultiplier ?? 2
    const max = this.config.maxBackoffMs ?? 30_000

    let delay = base * Math.pow(multiplier, attemptNumber - 1)
    delay = Math.min(delay, max)

    if (this.config.backoffJitter !== false) {
      delay += Math.random() * delay * 0.25
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay)
      if (typeof timer.unref === 'function') timer.unref()
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Aborted during backoff'))
        },
        { once: true },
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Strategy selection
  // ---------------------------------------------------------------------------

  private selectStrategy(failure: FailureContext): RecoveryStrategy {
    // Use custom selector if provided
    if (this.strategySelector) {
      return this.strategySelector(failure)
    }

    // Walk through the strategy order and pick the first applicable one
    const attemptIndex = failure.attemptNumber - 1 // 0-based

    for (let i = attemptIndex; i < this.strategyOrder.length; i++) {
      const strategy = this.strategyOrder[i]
      if (strategy === undefined) continue

      // Skip retry-different-provider if all providers have been exhausted
      if (strategy === 'retry-different-provider') {
        const healthyProviders = this.registry.listAdapters()
        const available = healthyProviders.filter(
          (id) => !failure.exhaustedProviders.includes(id),
        )
        if (available.length === 0) continue
      }

      return strategy
    }

    // Fall back to abort if nothing else is applicable
    return 'abort'
  }

  // ---------------------------------------------------------------------------
  // Strategy application
  // ---------------------------------------------------------------------------

  private applyStrategy(
    strategy: RecoveryStrategy,
    input: AgentInput,
    _task: TaskDescriptor,
    _failure: FailureContext,
    exhaustedProviders?: Set<AdapterProviderId>,
  ): AgentInput {
    switch (strategy) {
      case 'retry-same-provider':
        // Retry with the same input — no modifications needed.
        // The registry may still route to the same provider.
        return { ...input }

      case 'retry-different-provider': {
        // Find an alternative that hasn't been exhausted
        const alternative = this.resolveAvailableProvider(
          exhaustedProviders ? [...exhaustedProviders] : [],
        )
        if (alternative) {
          // Route to this specific provider by adding preference
          return {
            ...input,
            options: { ...input.options, preferredProvider: alternative },
          }
        }
        // If no alternatives, fall through with unmodified input
        return { ...input }
      }

      case 'increase-budget': {
        const newMaxTurns = input.maxTurns
          ? Math.ceil(input.maxTurns * this.budgetMultiplier)
          : undefined
        const newMaxBudget = input.maxBudgetUsd
          ? input.maxBudgetUsd * this.budgetMultiplier
          : undefined
        return {
          ...input,
          ...(newMaxTurns !== undefined && { maxTurns: newMaxTurns }),
          ...(newMaxBudget !== undefined && { maxBudgetUsd: newMaxBudget }),
        }
      }

      case 'simplify-task':
        // Prepend a simplification directive to the prompt
        return {
          ...input,
          prompt: `[SIMPLIFIED] Please provide a simpler, more direct solution. Avoid complex approaches.\n\n${input.prompt}`,
          systemPrompt: input.systemPrompt
            ? `${input.systemPrompt}\n\nIMPORTANT: Simplify your approach. Use the most straightforward solution available.`
            : 'IMPORTANT: Simplify your approach. Use the most straightforward solution available.',
        }

      case 'escalate-human':
      case 'abort':
        // These are handled in the main loop — no input modification needed.
        return input

      default: {
        // Exhaustive check
        const _exhaustive: never = strategy
        return _exhaustive
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event emission helpers
  // ---------------------------------------------------------------------------

  private emitRecoveryAttemptStarted(
    runId: string,
    attempt: number,
    maxAttempts: number,
    strategy: RecoveryStrategy,
    providerId: AdapterProviderId,
  ): void {
    if (!this.eventBus) return
    this.eventBus.emit({
      type: 'recovery:attempt_started',
      agentId: providerId,
      runId,
      attempt,
      maxAttempts,
      strategy,
      timestamp: Date.now(),
    })
  }

  private emitRecoverySucceeded(
    runId: string,
    attempt: number,
    strategy: RecoveryStrategy,
    durationMs: number,
  ): void {
    if (!this.eventBus) return
    this.eventBus.emit({
      type: 'recovery:succeeded',
      agentId: 'adapter-recovery',
      runId,
      attempt,
      strategy,
      durationMs,
    })
  }

  private emitRecoveryExhausted(
    runId: string,
    attempts: number,
    strategies: RecoveryStrategy[],
    durationMs: number,
    lastError?: string,
  ): void {
    if (!this.eventBus) return
    this.eventBus.emit({
      type: 'recovery:exhausted',
      agentId: 'adapter-recovery',
      runId,
      attempts,
      strategies,
      durationMs,
      lastError,
    })
  }

  private emitRecoveryCancelledEvent(
    runId: string,
    providerId: AdapterProviderId | undefined,
    attempts: number,
    durationMs: number,
    reason: string,
  ): void {
    if (!this.eventBus) return

    this.eventBus.emit({
      type: 'recovery:cancelled',
      agentId: providerId ?? 'adapter-recovery',
      runId,
      attempts,
      durationMs,
      reason,
    })
  }

  private emitApprovalRequest(
    traceId: string,
    input: AgentInput,
    failure: FailureContext,
  ): void {
    if (!this.eventBus) return

    this.eventBus.emit({
      type: 'approval:requested',
      runId: traceId,
      plan: {
        type: 'adapter-recovery-escalation',
        prompt: input.prompt,
        failedProvider: failure.failedProvider,
        error: failure.error,
        attemptNumber: failure.attemptNumber,
        exhaustedProviders: failure.exhaustedProviders,
      },
    })
  }

  private resolveAvailableProvider(
    excludedProviders: AdapterProviderId[] = [],
  ): AdapterProviderId | undefined {
    return resolveFallbackProviderId(this.registry.listAdapters(), excludedProviders)
  }
}
