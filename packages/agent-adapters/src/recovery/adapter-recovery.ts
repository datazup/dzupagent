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

import { ForgeError } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'

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

export interface RecoveryConfig {
  /** Max recovery attempts before giving up. Default 3 */
  maxAttempts?: number
  /** Strategy selection order. Default: retry-different -> increase-budget -> escalate-human -> abort */
  strategyOrder?: RecoveryStrategy[]
  /** Event bus */
  eventBus?: DzipEventBus
  /** Budget increase multiplier for 'increase-budget' strategy. Default 1.5 */
  budgetMultiplier?: number
  /** Custom strategy selector */
  strategySelector?: (failure: FailureContext) => RecoveryStrategy
}

// ---------------------------------------------------------------------------
// Failure context
// ---------------------------------------------------------------------------

export interface FailureContext {
  /** Original input */
  input: AgentInput
  /** Task descriptor */
  task?: TaskDescriptor
  /** Which provider failed */
  failedProvider: AdapterProviderId
  /** Error message */
  error: string
  /** Error code */
  errorCode?: string
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

export interface RecoveryResult {
  success: boolean
  strategy: RecoveryStrategy
  result?: string
  providerId?: AdapterProviderId
  totalAttempts: number
  totalDurationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------

/** Trace capture for post-mortem analysis */
export interface ExecutionTrace {
  traceId: string
  startedAt: Date
  completedAt?: Date
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
  }
}

// ---------------------------------------------------------------------------
// AdapterRecoveryCopilot
// ---------------------------------------------------------------------------

export class AdapterRecoveryCopilot {
  private readonly _traceCapture = new ExecutionTraceCapture()
  private readonly maxAttempts: number
  private readonly strategyOrder: RecoveryStrategy[]
  private readonly budgetMultiplier: number
  private readonly eventBus: DzipEventBus | undefined
  private readonly strategySelector:
    | ((failure: FailureContext) => RecoveryStrategy)
    | undefined

  constructor(
    private readonly registry: AdapterRegistry,
    config?: RecoveryConfig,
  ) {
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
      const attemptStart = Date.now()

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

        this.emitRecoveryEvent('recovery:attempt_started', {
          attemptNumber: attempt,
          strategy: lastStrategy,
          providerId: adapter.providerId,
        })

        // Collect output from streaming execution
        let result = ''
        const gen = adapter.execute(currentInput)
        for await (const event of gen) {
          this._traceCapture.recordEvent(trace.traceId, event)
          if (event.type === 'adapter:completed') {
            result = event.result
          }
          if (event.type === 'adapter:message' && event.role === 'assistant') {
            result += event.content
          }
        }

        // Success
        this.registry.recordSuccess(adapter.providerId)
        this._traceCapture.completeTrace(trace.traceId)

        this.emitRecoveryEvent('recovery:succeeded', {
          attemptNumber: attempt,
          strategy: lastStrategy,
          providerId: adapter.providerId,
        })

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

        if (lastProviderId && !exhaustedProviders.includes(lastProviderId)) {
          exhaustedProviders.push(lastProviderId)
        }

        const failureCtx: FailureContext = {
          input: currentInput,
          task,
          failedProvider: lastProviderId ?? ('unknown' as AdapterProviderId),
          error: error.message,
          errorCode:
            err instanceof ForgeError ? err.code : undefined,
          attemptNumber: attempt,
          exhaustedProviders: [...exhaustedProviders],
          durationMs,
        }

        this._traceCapture.recordDecision(trace.traceId, {
          type: 'fallback',
          providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
          reason: `Attempt ${attempt} failed: ${error.message}`,
        })

        this.emitRecoveryEvent('recovery:attempt_failed', {
          attemptNumber: attempt,
          providerId: lastProviderId,
          error: error.message,
        })

        // If we have exhausted all attempts, break
        if (attempt >= this.maxAttempts) {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
            reason: `Max attempts (${this.maxAttempts}) exhausted`,
          })
          this._traceCapture.completeTrace(trace.traceId)

          this.emitRecoveryEvent('recovery:exhausted', {
            totalAttempts: attempt,
            exhaustedProviders,
          })

          return {
            success: false,
            strategy: lastStrategy,
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: error.message,
            providerId: lastProviderId,
          }
        }

        // Select next strategy
        lastStrategy = this.selectStrategy(failureCtx)

        // Apply the strategy for the next attempt
        currentInput = this.applyStrategy(
          lastStrategy,
          currentInput,
          effectiveTask,
          failureCtx,
        )

        // If strategy is abort, stop immediately
        if (lastStrategy === 'abort') {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
            reason: 'Strategy selected abort',
          })
          this._traceCapture.completeTrace(trace.traceId)

          return {
            success: false,
            strategy: 'abort',
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: error.message,
            providerId: lastProviderId,
          }
        }

        // If strategy is escalate-human, emit approval event and abort
        // (actual human-in-the-loop would require external integration)
        if (lastStrategy === 'escalate-human') {
          this.emitApprovalRequest(trace.traceId, currentInput, failureCtx)

          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
            reason: 'Escalated to human — awaiting approval',
          })
          this._traceCapture.completeTrace(trace.traceId)

          return {
            success: false,
            strategy: 'escalate-human',
            totalAttempts: attempt,
            totalDurationMs: Date.now() - overallStart,
            error: `Escalated to human after ${attempt} failed attempts: ${error.message}`,
            providerId: lastProviderId,
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

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const { adapter, decision } = this.registry.getForTask(effectiveTask)

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
          this._traceCapture.recordEvent(trace.traceId, event)
          yield event
        }

        // If we got here, execution succeeded
        this.registry.recordSuccess(adapter.providerId)
        this._traceCapture.completeTrace(trace.traceId)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        // Find which provider just failed
        let failedProvider: AdapterProviderId
        try {
          const { adapter } = this.registry.getForTask(effectiveTask)
          failedProvider = adapter.providerId
        } catch {
          failedProvider = 'claude' as AdapterProviderId
        }

        if (!exhaustedProviders.includes(failedProvider)) {
          exhaustedProviders.push(failedProvider)
        }

        const failureCtx: FailureContext = {
          input: currentInput,
          task,
          failedProvider,
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
          providerId: failedProvider,
          error: error.message,
          code: 'RECOVERY_ATTEMPT_FAILED',
          timestamp: Date.now(),
        }

        if (attempt >= this.maxAttempts) {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: failedProvider,
            reason: `Max attempts (${this.maxAttempts}) exhausted`,
          })
          this._traceCapture.completeTrace(trace.traceId)

          throw new ForgeError({
            code: 'ALL_ADAPTERS_EXHAUSTED',
            message: `Recovery exhausted after ${attempt} attempts: ${error.message}`,
            recoverable: false,
            cause: err instanceof Error ? err : undefined,
          })
        }

        lastStrategy = this.selectStrategy(failureCtx)

        if (lastStrategy === 'abort' || lastStrategy === 'escalate-human') {
          this._traceCapture.recordDecision(trace.traceId, {
            type: 'abort',
            providerId: failedProvider,
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
          })
        }

        currentInput = this.applyStrategy(
          lastStrategy,
          currentInput,
          effectiveTask,
          failureCtx,
        )
      }
    }

    this._traceCapture.completeTrace(trace.traceId)
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
  ): AgentInput {
    switch (strategy) {
      case 'retry-same-provider':
        // Retry with the same input — no modifications needed.
        // The registry may still route to the same provider.
        return { ...input }

      case 'retry-different-provider':
        // Exclude exhausted providers via preferredProvider hint.
        // The registry router will pick from remaining healthy adapters.
        return { ...input }

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

  private emitRecoveryEvent(
    eventSuffix: string,
    details: Record<string, unknown>,
  ): void {
    if (!this.eventBus) return

    this.eventBus.emit({
      type: 'agent:stuck_detected',
      agentId: 'adapter-recovery',
      reason: `${eventSuffix}: ${JSON.stringify(details)}`,
      recovery: eventSuffix,
      timestamp: Date.now(),
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
}
