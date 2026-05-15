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
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import { compilePolicyForProvider } from '../policy/policy-compiler.js'
import {
  PolicyConformanceChecker,
  type PolicyViolation,
} from '../policy/policy-conformance.js'
import {
  POLICY_ACTIVE_OPTION_KEY,
  POLICY_CONFORMANCE_MODE_OPTION_KEY,
  POLICY_GUARDRAILS_OPTION_KEY,
  type PolicyConformanceMode,
} from '../pipeline/policy-enforcement-pipeline.js'
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
  | {
      type: 'policy:conformance_violation'
      providerId: string
      field: string
      reason: string
      severity: 'error' | 'warning'
      conformanceMode: 'strict' | 'warn-only'
      fallbackBehavior: 'continue_primary_attempt' | 'continue_fallback_attempt' | 'blocked_attempt'
      correlationId?: string
    }
  | {
      type: 'agent:progress'
      agentId: string
      phase: string
      percentage: number
      message: string
      timestamp: number
      details?: Record<string, unknown>
    }
  | { type: 'provider:failed'; tier: string; provider: string; message: string }
  | { type: 'provider:circuit_opened'; provider: string }
  | { type: 'provider:circuit_closed'; provider: string }

type LegacyPolicyTransportResolution<T> = {
  value: T
  usedLegacyOptionKey: boolean
  legacyOptionKey?: typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
}

export class AdapterRegistryRouter {
  private strategy: TaskRoutingStrategy = new TagBasedRouter()
  private readonly policyConformanceChecker = new PolicyConformanceChecker()

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
    const emittedLegacyOptionWarnings = new Set<
      typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY
    >()

    for (let attemptIdx = 0; attemptIdx < ordered.length; attemptIdx++) {
      const providerId = ordered[attemptIdx]
      if (providerId === undefined) continue
      const adapter = this.core.get(providerId)
      if (!adapter || !this.health.canExecute(providerId)) continue

      const attemptError = yield* this.runAttempt(
        adapter,
        providerId,
        attemptIdx,
        ordered,
        input,
        effectiveTimeoutMs,
        emittedLegacyOptionWarnings,
      )
      if (attemptError === undefined) return // success returns early
      lastError = attemptError
    }

    throw synthesizeFailureEvents(ordered, lastError, task)
  }

  /**
   * Execute a single attempt and return the resulting `lastError` (or
   * `undefined` on success — caller treats that as a successful return).
   *
   * Thin orchestrator: emits the start progress event, runs the adapter via
   * {@link runOneAttempt}, then dispatches the outcome to a focused handler.
   */
  private async *runAttempt(
    adapter: AgentCLIAdapter,
    providerId: AdapterProviderId,
    attemptIdx: number,
    ordered: AdapterProviderId[],
    input: AgentInput,
    effectiveTimeoutMs: number | undefined,
    emittedLegacyOptionWarnings: Set<typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY>,
  ): AsyncGenerator<AgentStreamEvent, Error | undefined, undefined> {
    const startMs = Date.now()
    const attemptRunId = `${providerId}-${startMs}`

    yield this.buildStartProgress(providerId, attemptIdx, ordered.length, input)

    const { controller: attemptAbort, timeoutHandle, getDidTimeout } = setupAttemptTimeout(
      effectiveTimeoutMs,
      input.signal,
    )

    try {
      const projected = this.buildAttemptInput(
        input,
        providerId,
        attemptAbort.signal,
        attemptIdx,
        ordered.length,
        emittedLegacyOptionWarnings,
      )
      this.emitWarnOnlyConformanceViolations(
        providerId,
        projected.conformanceMode,
        projected.conformanceViolations,
        attemptIdx,
        input.correlationId,
      )
      for (const warningEvent of projected.warningEvents) {
        yield warningEvent
      }
      for (const warningEvent of projected.legacyOptionWarningEvents) {
        yield warningEvent
      }
      this.emit({ type: 'agent:started', agentId: providerId, runId: attemptRunId })
      const outcome = yield* runOneAttempt(
        adapter,
        projected.attemptInput,
        providerId,
        effectiveTimeoutMs,
        getDidTimeout,
      )

      if (outcome.kind === 'success') {
        this.handleAttemptSuccess(providerId, attemptRunId, startMs, outcome.usage)
        return undefined
      }
      return this.handleAttemptFailure(providerId, attemptRunId, outcome.message, outcome.code)
    } catch (err) {
      return yield* this.handleAttemptException(err, providerId, attemptRunId, effectiveTimeoutMs, getDidTimeout())
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private buildAttemptInput(
    baseInput: AgentInput,
    providerId: AdapterProviderId,
    signal: AbortSignal,
    attemptIdx: number,
    totalAttempts: number,
    emittedLegacyOptionWarnings: Set<typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY>,
  ): {
    attemptInput: AgentInput
    warningEvents: Array<Extract<AgentStreamEvent, { type: 'adapter:progress' }>>
    legacyOptionWarningEvents: Array<Extract<AgentStreamEvent, { type: 'adapter:progress' }>>
    conformanceMode: PolicyConformanceMode
    conformanceViolations: PolicyViolation[]
  } {
    const policyResolution = this.readActivePolicy(baseInput)
    const conformanceModeResolution = this.readConformanceMode(baseInput)
    const policy = policyResolution.value
    const conformanceMode = conformanceModeResolution.value
    const legacyOptionWarningEvents = this.buildLegacyOptionWarningEvents(
      providerId,
      attemptIdx,
      totalAttempts,
      baseInput.correlationId,
      emittedLegacyOptionWarnings,
      [policyResolution, conformanceModeResolution],
    )
    if (!policy) {
      return {
        attemptInput: { ...baseInput, signal },
        warningEvents: [],
        legacyOptionWarningEvents,
        conformanceMode,
        conformanceViolations: [],
      }
    }

    const compiled = compilePolicyForProvider(providerId, policy)
    const result = this.policyConformanceChecker.check(providerId, policy, compiled)
    const blockingViolations = conformanceMode === 'strict'
      ? result.violations
      : result.violations.filter((v) => v.severity === 'error')
    const nonBlockingViolations = result.violations.filter((v) => !blockingViolations.includes(v))

    if (blockingViolations.length > 0) {
      this.emitConformanceViolationEvents(
        providerId,
        conformanceMode,
        blockingViolations,
        baseInput.correlationId,
        'blocked_attempt',
      )
      throw this.createPolicyConformanceError(providerId, blockingViolations, conformanceMode)
    }

    const options = { ...(baseInput.options ?? {}) }
    delete options['sandboxMode']
    delete options['approvalPolicy']
    delete options['permissionMode']
    delete options['networkAccessEnabled']
    delete options['maxBudgetUsd']
    delete options['maxTurns']
    delete options[POLICY_ACTIVE_OPTION_KEY]
    delete options[POLICY_CONFORMANCE_MODE_OPTION_KEY]
    delete options[POLICY_GUARDRAILS_OPTION_KEY]

    const guardrailOverlay = compiled.guardrails.maxIterations !== undefined ||
      compiled.guardrails.maxCostCents !== undefined ||
      (compiled.guardrails.blockedTools?.length ?? 0) > 0

    return {
      attemptInput: {
        ...baseInput,
        signal,
        // Attempt execution should not surface orchestration metadata to adapters.
        policyContext: undefined,
        options: {
          ...options,
          ...compiled.config,
          ...compiled.inputOptions,
          ...(guardrailOverlay
            ? { [POLICY_GUARDRAILS_OPTION_KEY]: { ...compiled.guardrails } }
            : {}),
        },
        maxTurns: baseInput.maxTurns ?? compiled.guardrails.maxIterations,
      },
      warningEvents: this.buildWarnOnlyConformanceEvents(
        providerId,
        conformanceMode,
        nonBlockingViolations,
        attemptIdx,
        totalAttempts,
        baseInput.correlationId,
      ),
      legacyOptionWarningEvents,
      conformanceMode,
      conformanceViolations: nonBlockingViolations,
    }
  }

  private readActivePolicy(input: AgentInput): LegacyPolicyTransportResolution<AdapterPolicy | undefined> {
    const typed = input.policyContext?.activePolicy
    if (typed && typeof typed === 'object') {
      return { value: typed as AdapterPolicy, usedLegacyOptionKey: false }
    }

    // Legacy compatibility path for callers that still write policy metadata into options.
    const raw = input.options?.[POLICY_ACTIVE_OPTION_KEY]
    if (!raw || typeof raw !== 'object') {
      return { value: undefined, usedLegacyOptionKey: false }
    }
    return {
      value: raw as AdapterPolicy,
      usedLegacyOptionKey: true,
      legacyOptionKey: POLICY_ACTIVE_OPTION_KEY,
    }
  }

  private readConformanceMode(input: AgentInput): LegacyPolicyTransportResolution<PolicyConformanceMode> {
    const typed = input.policyContext?.conformanceMode
    if (typed === 'warn-only' || typed === 'strict') {
      return { value: typed, usedLegacyOptionKey: false }
    }

    // Legacy compatibility path for callers that still write policy metadata into options.
    const raw = input.options?.[POLICY_CONFORMANCE_MODE_OPTION_KEY]
    if (raw === 'warn-only' || raw === 'strict') {
      return {
        value: raw,
        usedLegacyOptionKey: true,
        legacyOptionKey: POLICY_CONFORMANCE_MODE_OPTION_KEY,
      }
    }
    return { value: 'strict', usedLegacyOptionKey: false }
  }

  private buildLegacyOptionWarningEvents(
    providerId: AdapterProviderId,
    attemptIdx: number,
    totalAttempts: number,
    correlationId: string | undefined,
    emittedLegacyOptionWarnings: Set<typeof POLICY_ACTIVE_OPTION_KEY | typeof POLICY_CONFORMANCE_MODE_OPTION_KEY>,
    resolutions: Array<LegacyPolicyTransportResolution<unknown>>,
  ): Array<Extract<AgentStreamEvent, { type: 'adapter:progress' }>> {
    const events: Array<Extract<AgentStreamEvent, { type: 'adapter:progress' }>> = []
    for (const resolution of resolutions) {
      if (!resolution.usedLegacyOptionKey || !resolution.legacyOptionKey) continue
      if (emittedLegacyOptionWarnings.has(resolution.legacyOptionKey)) continue
      emittedLegacyOptionWarnings.add(resolution.legacyOptionKey)
      events.push({
        type: 'adapter:progress',
        providerId,
        timestamp: Date.now(),
        phase: 'policy:legacy_option_deprecated',
        message: `Deprecated policy option key '${resolution.legacyOptionKey}' was consumed; use policyContext transport instead`,
        current: attemptIdx + 1,
        total: totalAttempts,
        details: {
          kind: 'policy_legacy_option_deprecated',
          optionKey: resolution.legacyOptionKey,
          replacement: 'policyContext',
        },
        ...(correlationId ? { correlationId } : {}),
      })
    }
    return events
  }

  private buildWarnOnlyConformanceEvents(
    providerId: AdapterProviderId,
    conformanceMode: PolicyConformanceMode,
    violations: PolicyViolation[],
    attemptIdx: number,
    totalAttempts: number,
    correlationId: string | undefined,
  ): Array<Extract<AgentStreamEvent, { type: 'adapter:progress' }>> {
    if (conformanceMode !== 'warn-only' || violations.length === 0) return []

    return violations.map((violation) => ({
      type: 'adapter:progress',
      providerId,
      timestamp: Date.now(),
      phase: 'policy:conformance_warning',
      message: `Policy warning on ${providerId}: ${violation.field} (${violation.reason})`,
      current: attemptIdx + 1,
      total: totalAttempts,
      details: {
        kind: 'policy_conformance_violation',
        providerId,
        field: violation.field,
        reason: violation.reason,
        severity: violation.severity,
        conformanceMode,
        fallbackBehavior: attemptIdx === 0 ? 'continue_primary_attempt' : 'continue_fallback_attempt',
      },
      ...(correlationId ? { correlationId } : {}),
    }))
  }

  private emitWarnOnlyConformanceViolations(
    providerId: AdapterProviderId,
    conformanceMode: PolicyConformanceMode,
    violations: PolicyViolation[],
    attemptIdx: number,
    correlationId: string | undefined,
  ): void {
    if (conformanceMode !== 'warn-only' || violations.length === 0) return

    this.emitConformanceViolationEvents(
      providerId,
      conformanceMode,
      violations,
      correlationId,
      attemptIdx === 0 ? 'continue_primary_attempt' : 'continue_fallback_attempt',
    )
  }

  private emitConformanceViolationEvents(
    providerId: AdapterProviderId,
    conformanceMode: PolicyConformanceMode,
    violations: PolicyViolation[],
    correlationId: string | undefined,
    fallbackBehavior: 'continue_primary_attempt' | 'continue_fallback_attempt' | 'blocked_attempt',
  ): void {
    for (const violation of violations) {
      this.emit({
        type: 'policy:conformance_violation',
        providerId,
        field: violation.field,
        reason: violation.reason,
        severity: violation.severity,
        conformanceMode,
        fallbackBehavior,
        ...(correlationId ? { correlationId } : {}),
      })
    }
  }

  private createPolicyConformanceError(
    providerId: AdapterProviderId,
    violations: PolicyViolation[],
    conformanceMode: PolicyConformanceMode,
  ): ForgeError {
    const details = violations.map((v) => `  - ${v.field}: ${v.reason}`).join('\n')
    return new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: `Policy conformance check failed for provider '${providerId}':\n${details}`,
      recoverable: false,
      context: {
        source: 'AdapterRegistryRouter.buildAttemptInput',
        providerId,
        conformanceMode,
        violationCount: violations.length,
      },
    })
  }

  /** Build the per-attempt `adapter:progress` event with the appropriate fallback message. */
  private buildStartProgress(
    providerId: AdapterProviderId,
    attemptIdx: number,
    totalAttempts: number,
    input: AgentInput,
  ): Extract<AgentStreamEvent, { type: 'adapter:progress' }> {
    return buildAttemptProgressEvent({
      providerId,
      attemptIdx,
      totalAttempts,
      input,
      message: attemptIdx === 0
        ? `Executing primary provider ${providerId}`
        : `Falling back to ${providerId} (attempt ${attemptIdx + 1}/${totalAttempts})`,
    })
  }

  /**
   * Apply success bookkeeping: record on the circuit breaker and emit the
   * `agent:completed` lifecycle event with optional usage attribution.
   */
  private handleAttemptSuccess(
    providerId: AdapterProviderId,
    runId: string,
    startMs: number,
    usage: TokenUsage | undefined,
  ): void {
    this.recordSuccessAndEmit(providerId)
    this.emit({
      type: 'agent:completed',
      agentId: providerId,
      runId,
      durationMs: Date.now() - startMs,
      ...(usage ? { usage } : {}),
    })
  }

  /**
   * Apply terminal-failure bookkeeping for an outcome where the adapter
   * stream ended without `adapter:completed`. Returns the constructed Error
   * so the caller can use it as the loop's `lastError`.
   */
  private handleAttemptFailure(
    providerId: AdapterProviderId,
    runId: string,
    message: string,
    code: string,
  ): Error {
    const terminalError = new Error(message)
    this.recordFailureAndEmit(providerId, terminalError)
    this.emit({
      type: 'agent:failed',
      agentId: providerId,
      runId,
      errorCode: code as ForgeErrorCode,
      message,
    })
    return terminalError
  }

  /**
   * Classify an exception thrown during an attempt; either propagate
   * (caller-initiated abort) or emit a synthesised failure event so the
   * fallback chain can continue with the next provider.
   */
  private async *handleAttemptException(
    err: unknown,
    providerId: AdapterProviderId,
    runId: string,
    effectiveTimeoutMs: number | undefined,
    didTimeout: boolean,
  ): AsyncGenerator<AgentStreamEvent, Error, undefined> {
    const classification = classifyAttemptError(err, providerId, effectiveTimeoutMs, didTimeout)
    if (classification.kind === 'propagate') throw classification.error

    this.recordFailureAndEmit(providerId, classification.error)
    this.emit({
      type: 'agent:failed',
      agentId: providerId,
      runId,
      errorCode: classification.code as ForgeErrorCode,
      message: classification.message,
    })
    yield classification.failedEvent
    return classification.error
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
