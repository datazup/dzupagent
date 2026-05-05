/**
 * AdapterRegistryRouter — routing strategy ownership and fallback execution.
 *
 * Responsible for:
 *  - Selecting the best adapter for a given task via the active strategy.
 *  - Building the fallback chain.
 *  - Driving the per-attempt execution loop and emitting the lifecycle
 *    events expected by downstream observers.
 *
 * Reads CRUD state from {@link AdapterRegistryCore} and circuit-breaker /
 * bookkeeping state from {@link AdapterHealthMonitor}.
 */

import { ForgeError } from '@dzupagent/core/advanced'
import type { DzupEventBus, ForgeErrorCode } from '@dzupagent/core/advanced'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
  TokenUsage,
} from '../types.js'
import {
  buildAttemptProgressEvent,
  buildFallbackOrder,
  buildRoutingProgressEvent,
  classifyAttemptError,
  resolveTimeoutMs,
  runOneAttempt,
  setupAttemptTimeout,
  synthesizeFailureEvents,
} from './adapter-registry-helpers.js'
import type { AdapterHealthMonitor } from './health-monitor.js'
import type { AdapterRegistryCore } from './registry-core.js'
import { TagBasedRouter } from './task-router.js'

function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

/** Internal lifecycle events forwarded to the host event bus. */
type RouterBusEvent =
  | { type: 'agent:started'; agentId: string; runId: string }
  | { type: 'agent:completed'; agentId: string; runId: string; durationMs: number; usage?: TokenUsage }
  | { type: 'agent:failed'; agentId: string; runId: string; errorCode: ForgeErrorCode; message: string }
  | { type: 'provider:failed'; tier: string; provider: string; message: string }
  | { type: 'provider:circuit_opened'; provider: string }
  | { type: 'provider:circuit_closed'; provider: string }

export class AdapterRegistryRouter {
  private strategy: TaskRoutingStrategy = new TagBasedRouter()

  constructor(
    private readonly core: AdapterRegistryCore,
    private readonly health: AdapterHealthMonitor,
    private readonly defaultExecutionTimeoutMs: number | undefined,
  ) {}

  /** Replace the active routing strategy. */
  setStrategy(strategy: TaskRoutingStrategy): void {
    this.strategy = strategy
  }

  /** Get the best available adapter for a task using the active routing strategy. */
  getForTask(task: TaskDescriptor): { adapter: AgentCLIAdapter; decision: RoutingDecision } {
    const healthyIds = this.core.getHealthyProviderIds()
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No healthy adapters available for routing',
        recoverable: false,
        suggestion: 'Wait for circuit breakers to reset or register additional adapters',
      })
    }

    const decision = this.strategy.route(task, healthyIds)
    const targetId = decision.provider === 'auto' ? healthyIds[0] : decision.provider
    const adapter = targetId !== undefined
      ? this.core.get(targetId as AdapterProviderId)
      : undefined

    if (!adapter) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: `Router selected provider "${String(targetId)}" but adapter was not found`,
        recoverable: false,
      })
    }

    return { adapter, decision }
  }

  async *executeWithFallback(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithFallbackWithRaw(input, task)) {
      if (!isProviderRawStreamEvent(event)) yield event
    }
  }

  async *executeWithFallbackWithRaw(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const healthyIds = this.core.getHealthyProviderIds()
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No healthy adapters available',
        recoverable: false,
      })
    }

    const decision = this.strategy.route(task, healthyIds)
    const ordered = buildFallbackOrder(decision, healthyIds)
    const effectiveTimeoutMs = resolveTimeoutMs(input, this.defaultExecutionTimeoutMs)

    yield buildRoutingProgressEvent({
      providerId: ordered[0] ?? (decision.provider !== 'auto' ? decision.provider : healthyIds[0]),
      decision,
      ordered,
      input,
      message: `Registry routing → primary=${decision.provider !== 'auto' ? decision.provider : (ordered[0] ?? 'auto')} fallbacks=${ordered.slice(1).join(',') || 'none'}`,
    })

    let lastError: Error | undefined

    for (let attemptIdx = 0; attemptIdx < ordered.length; attemptIdx++) {
      const providerId = ordered[attemptIdx]
      if (providerId === undefined) continue
      const adapter = this.core.get(providerId)
      if (!adapter || !this.health.canExecute(providerId)) continue

      const attemptError = yield* this.runAttempt(adapter, providerId, attemptIdx, ordered, input, effectiveTimeoutMs)
      if (attemptError === undefined) return // success returns early
      lastError = attemptError
    }

    throw synthesizeFailureEvents(ordered, lastError, task)
  }

  /**
   * Execute a single attempt and return the resulting `lastError` (or
   * `undefined` on success — caller treats that as a successful return).
   */
  private async *runAttempt(
    adapter: AgentCLIAdapter,
    providerId: AdapterProviderId,
    attemptIdx: number,
    ordered: AdapterProviderId[],
    input: AgentInput,
    effectiveTimeoutMs: number | undefined,
  ): AsyncGenerator<AgentStreamEvent, Error | undefined, undefined> {
    const startMs = Date.now()
    const attemptRunId = `${providerId}-${startMs}`

    yield buildAttemptProgressEvent({
      providerId,
      attemptIdx,
      totalAttempts: ordered.length,
      input,
      message: attemptIdx === 0
        ? `Executing primary provider ${providerId}`
        : `Falling back to ${providerId} (attempt ${attemptIdx + 1}/${ordered.length})`,
    })

    const { controller: attemptAbort, timeoutHandle, getDidTimeout } = setupAttemptTimeout(
      effectiveTimeoutMs,
      input.signal,
    )
    const attemptInput: AgentInput = { ...input, signal: attemptAbort.signal }

    try {
      this.emit({ type: 'agent:started', agentId: providerId, runId: attemptRunId })

      const outcome = yield* runOneAttempt(adapter, attemptInput, providerId, effectiveTimeoutMs, getDidTimeout)

      if (outcome.kind === 'success') {
        this.recordSuccessAndEmit(providerId)
        this.emit({
          type: 'agent:completed',
          agentId: providerId,
          runId: attemptRunId,
          durationMs: Date.now() - startMs,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        })
        return undefined
      }

      const terminalError = new Error(outcome.message)
      this.recordFailureAndEmit(providerId, terminalError)
      this.emit({
        type: 'agent:failed',
        agentId: providerId,
        runId: attemptRunId,
        errorCode: outcome.code as ForgeErrorCode,
        message: outcome.message,
      })
      return terminalError
    } catch (err) {
      const classification = classifyAttemptError(err, providerId, effectiveTimeoutMs, getDidTimeout())
      if (classification.kind === 'propagate') throw classification.error

      this.recordFailureAndEmit(providerId, classification.error)
      this.emit({
        type: 'agent:failed',
        agentId: providerId,
        runId: attemptRunId,
        errorCode: classification.code as ForgeErrorCode,
        message: classification.message,
      })
      yield classification.failedEvent
      return classification.error
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private recordSuccessAndEmit(providerId: AdapterProviderId): void {
    const transition = this.health.recordSuccess(providerId)
    if (transition.closed) this.emit({ type: 'provider:circuit_closed', provider: providerId })
  }

  private recordFailureAndEmit(providerId: AdapterProviderId, error: Error): void {
    const transition = this.health.recordFailure(providerId)
    if (transition.opened) this.emit({ type: 'provider:circuit_opened', provider: providerId })
    this.emit({ type: 'provider:failed', tier: 'adapter', provider: providerId, message: error.message })
  }

  private emit(event: RouterBusEvent): void {
    const bus: DzupEventBus | undefined = this.core.getEventBus()
    bus?.emit(event)
  }
}
