/**
 * ProviderAdapterRegistry — manages provider adapters with circuit breaker integration,
 * event bus observability, and automatic fallback execution.
 *
 * Each adapter is tracked by its AdapterProviderId. Circuit breakers prevent
 * routing to unhealthy adapters, and the event bus provides unified
 * observability across all adapter operations.
 *
 * Productization note:
 *   The `goose`, `crush`, and `gemini-sdk` providers are core-only and
 *   NOT productized. They may be registered here for framework use but
 *   are excluded from product-facing surfaces — see
 *   `provider-catalog.ts` (`productIntegrated: false`) for the
 *   authoritative policy and `getProductProviders()` helper. This
 *   decision can be revisited to promote them to experimental / opt-in
 *   later by flipping the `productIntegrated` flag.
 */

import { CircuitBreaker, ForgeError } from '@dzupagent/core/advanced'
import type { CircuitBreakerConfig, DzupEventBus } from '@dzupagent/core/advanced'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  HealthStatus,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
  TokenUsage,
} from '../types.js'
import { getDefaultMonitorStatus, getProviderCapabilities } from '../provider-catalog.js'

import { TagBasedRouter } from './task-router.js'

function isProviderRawStreamEvent(event: AgentStreamEvent): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

export interface ProviderAdapterRegistryConfig {
  /** Circuit breaker config applied to all adapters */
  circuitBreaker?: Partial<CircuitBreakerConfig> | undefined
  /**
   * Default per-execution timeout in milliseconds for
   * {@link ProviderAdapterRegistry.executeWithFallback}.
   *
   * If a single adapter attempt does not emit a terminal `adapter:completed`
   * event within this window, the registry aborts (via `input.signal`) and
   * proceeds to the next fallback provider.
   *
   * Per-call overrides may be supplied via `input.options.timeoutMs`.
   * Set to `0` or omit to disable the registry-level timeout (the adapter
   * may still enforce its own internal timeout — see `AdapterConfig.timeoutMs`).
   */
  executionTimeoutMs?: number | undefined
}

/** Detailed per-adapter health including circuit breaker diagnostics. */
export interface ProviderAdapterHealthDetail {
  healthy: boolean
  providerId: string
  sdkInstalled: boolean
  cliAvailable: boolean
  lastError?: string | undefined
  /** Circuit breaker state */
  circuitState: 'closed' | 'open' | 'half-open'
  /** Number of consecutive failures */
  consecutiveFailures: number
  /** Last successful execution timestamp */
  lastSuccessAt?: number | undefined
  /** Last failure timestamp */
  lastFailureAt?: number | undefined
  /** Optional artifact/config monitor status for this provider. */
  monitorStatus?: HealthStatus['monitorStatus'] | undefined
}

/** Aggregated detailed health status for all registered adapters. */
export interface ProviderAdapterRegistryHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  adapters: Record<string, ProviderAdapterHealthDetail>
  timestamp: number
}

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<AdapterProviderId, AgentCLIAdapter>()
  private readonly breakers = new Map<AdapterProviderId, CircuitBreaker>()
  private readonly cbConfig: Partial<CircuitBreakerConfig> | undefined
  private readonly defaultExecutionTimeoutMs: number | undefined
  private readonly lastSuccess = new Map<AdapterProviderId, number>()
  private readonly lastFailure = new Map<AdapterProviderId, number>()
  private readonly consecutiveFailures = new Map<AdapterProviderId, number>()
  private readonly disabledAdapters = new Set<AdapterProviderId>()
  private router: TaskRoutingStrategy = new TagBasedRouter()
  private eventBus: DzupEventBus | undefined

  constructor(config?: ProviderAdapterRegistryConfig) {
    this.cbConfig = config?.circuitBreaker
    this.defaultExecutionTimeoutMs = config?.executionTimeoutMs
  }

  /** Register an adapter. Creates a circuit breaker for it. */
  register(adapter: AgentCLIAdapter): this {
    this.adapters.set(adapter.providerId, adapter)
    if (!this.breakers.has(adapter.providerId)) {
      this.breakers.set(adapter.providerId, new CircuitBreaker(this.cbConfig))
    }
    this.emitEvent({
      type: 'adapter_registry:provider_registered',
      providerId: adapter.providerId,
      name: `adapter:${adapter.providerId}`,
    })
    return this
  }

  /**
   * Register only production (productIntegrated: true) adapters from the
   * given array. Experimental adapters are silently skipped — use
   * `registerExperimentalAdapters` with an explicit opt-in flag for those.
   */
  registerProductionAdapters(adapters: AgentCLIAdapter[]): this {
    for (const adapter of adapters) {
      const caps = getProviderCapabilities(adapter.providerId)
      if (caps?.productIntegrated) {
        this.register(adapter)
      }
    }
    return this
  }

  /**
   * Register experimental (productIntegrated: false) adapters, gated by an
   * explicit non-empty opt-in flag string. Production adapters in the
   * array are silently skipped — use `registerProductionAdapters` for those.
   *
   * Throws if the flag is missing or empty to prevent accidental
   * registration of experimental providers in product surfaces.
   */
  registerExperimentalAdapters(adapters: AgentCLIAdapter[], flag: string): this {
    if (!flag || flag.trim() === '') {
      throw new Error('registerExperimentalAdapters requires a non-empty flag string opt-in')
    }
    for (const adapter of adapters) {
      const caps = getProviderCapabilities(adapter.providerId)
      if (caps && !caps.productIntegrated) {
        this.register(adapter)
      }
    }
    return this
  }

  /** Unregister an adapter by provider ID. Returns true if it existed. */
  unregister(providerId: AdapterProviderId): boolean {
    const existed = this.adapters.has(providerId)
    this.adapters.delete(providerId)
    this.breakers.delete(providerId)
    this.lastSuccess.delete(providerId)
    this.lastFailure.delete(providerId)
    this.consecutiveFailures.delete(providerId)
    this.disabledAdapters.delete(providerId)
    if (existed) {
      this.emitEvent({
        type: 'adapter_registry:provider_deregistered',
        providerId,
        reason: 'unregistered',
      })
    }
    return existed
  }

  /** Disable an adapter (keeps registration but excludes from routing). */
  disable(providerId: AdapterProviderId): boolean {
    if (!this.adapters.has(providerId)) return false
    this.disabledAdapters.add(providerId)
    return true
  }

  /** Re-enable a disabled adapter. */
  enable(providerId: AdapterProviderId): boolean {
    return this.disabledAdapters.delete(providerId)
  }

  /** Check if an adapter is registered and enabled. */
  isEnabled(providerId: AdapterProviderId): boolean {
    return this.adapters.has(providerId) && !this.disabledAdapters.has(providerId)
  }

  /** Get an adapter by provider ID (no health check). */
  get(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    return this.adapters.get(providerId)
  }

  /** Get adapter only if its circuit breaker allows execution. */
  getHealthy(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    const adapter = this.adapters.get(providerId)
    if (!adapter) return undefined
    if (this.disabledAdapters.has(providerId)) return undefined
    const breaker = this.breakers.get(providerId)
    if (breaker && !breaker.canExecute()) return undefined
    return adapter
  }

  async respondInteraction(
    providerId: AdapterProviderId,
    interactionId: string,
    answer: string,
  ): Promise<boolean> {
    const adapter = this.adapters.get(providerId)
    if (!adapter || typeof adapter.respondInteraction !== 'function') {
      return false
    }
    return await adapter.respondInteraction(interactionId, answer)
  }

  /** Get the best available adapter for a task using the active routing strategy. */
  getForTask(task: TaskDescriptor): { adapter: AgentCLIAdapter; decision: RoutingDecision } {
    const healthyIds = this.getHealthyProviderIds()
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No healthy adapters available for routing',
        recoverable: false,
        suggestion: 'Wait for circuit breakers to reset or register additional adapters',
      })
    }

    const decision = this.router.route(task, healthyIds)
    const targetId = decision.provider === 'auto' ? healthyIds[0] : decision.provider
    // targetId is guaranteed to be a valid AdapterProviderId since it came from healthyIds
    // or from the router which only returns values from availableProviders
    const adapter = targetId !== undefined ? this.adapters.get(targetId as AdapterProviderId) : undefined

    if (!adapter) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: `Router selected provider "${String(targetId)}" but adapter was not found`,
        recoverable: false,
      })
    }

    return { adapter, decision }
  }

  /**
   * Execute with automatic fallback.
   *
   * Tries the primary adapter selected by the router, then falls back
   * through alternatives on failure. Emits lifecycle events throughout.
   */
  async *executeWithFallback(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithFallbackWithRaw(input, task)) {
      if (!isProviderRawStreamEvent(event)) {
        yield event
      }
    }
  }

  async *executeWithFallbackWithRaw(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const healthyIds = this.getHealthyProviderIds()
    if (healthyIds.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No healthy adapters available',
        recoverable: false,
      })
    }

    const decision = this.router.route(task, healthyIds)
    const ordered = this.buildFallbackOrder(decision, healthyIds)

    // Resolve per-execution timeout: per-call > registry default > none
    const perCallTimeout = typeof input.options?.['timeoutMs'] === 'number'
      ? (input.options['timeoutMs'] as number)
      : undefined
    const effectiveTimeoutMs = perCallTimeout ?? this.defaultExecutionTimeoutMs
    const timeoutEnabled = typeof effectiveTimeoutMs === 'number' && effectiveTimeoutMs > 0

    // Emit a routing-decision progress event so callers (NDJSON tail-f, etc.)
    // can observe which adapter the registry picked and what fallbacks remain.
    yield this.buildRoutingProgressEvent({
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
      const adapter = this.adapters.get(providerId)
      const breaker = this.breakers.get(providerId)
      if (!adapter || (breaker && !breaker.canExecute())) continue

      const startMs = Date.now()
      const attemptRunId = `${providerId}-${startMs}`

      // Emit a per-attempt progress event (helps distinguish primary vs fallback).
      yield this.buildAttemptProgressEvent({
        providerId,
        attemptIdx,
        totalAttempts: ordered.length,
        input,
        message: attemptIdx === 0
          ? `Executing primary provider ${providerId}`
          : `Falling back to ${providerId} (attempt ${attemptIdx + 1}/${ordered.length})`,
      })

      // Per-attempt abort controller for the registry-level timeout.
      // We forward the caller's abort signal through, then layer our own
      // timeout on top so a stalled adapter cannot block the fallback chain.
      const attemptAbort = new AbortController()
      if (input.signal) {
        if (input.signal.aborted) attemptAbort.abort()
        else input.signal.addEventListener('abort', () => attemptAbort.abort(), { once: true })
      }
      let didTimeout = false
      const timeoutHandle = timeoutEnabled
        ? setTimeout(() => {
            didTimeout = true
            attemptAbort.abort()
          }, effectiveTimeoutMs as number)
        : null

      const attemptInput: AgentInput = { ...input, signal: attemptAbort.signal }

      try {
        let sawCompleted = false
        let sawFailed = false
        let lastFailedEvent: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined
        let completedUsage: TokenUsage | undefined

        this.emitEvent({
          type: 'agent:started',
          agentId: providerId,
          runId: attemptRunId,
        })

        const gen = adapter.executeWithRaw?.(attemptInput) ?? adapter.execute(attemptInput)

        for await (const event of gen) {
          if (isProviderRawStreamEvent(event)) {
            yield event
            continue
          }
          if (event.type === 'adapter:completed') {
            sawCompleted = true
            // Preserve token usage surfaced by the adapter so downstream
            // bus listeners (metrics, cost attribution, relay aggregators)
            // can observe real token counts instead of falling back to zero.
            if (event.usage) completedUsage = event.usage
          } else if (event.type === 'adapter:failed') {
            sawFailed = true
            lastFailedEvent = event
          }
          yield event
        }

        // Success is only valid with an explicit terminal completion event.
        if (sawCompleted) {
          this.recordSuccess(providerId)
          this.emitEvent({
            type: 'agent:completed',
            agentId: providerId,
            runId: attemptRunId,
            durationMs: Date.now() - startMs,
            // `usage` is optional — omit when the adapter didn't surface
            // token counts so the wire shape stays clean.
            ...(completedUsage ? { usage: completedUsage } : {}),
          })
          return // successfully completed
        }

        const failureMessage = didTimeout
          ? `Adapter ${providerId} exceeded registry timeout of ${effectiveTimeoutMs}ms`
          : sawFailed
            ? (lastFailedEvent?.error ?? 'Adapter emitted failure event without details')
            : 'Adapter stream ended without terminal adapter:completed event'
        const failureCode = didTimeout
          ? 'ADAPTER_TIMEOUT'
          : sawFailed
            ? (lastFailedEvent?.code ?? 'ADAPTER_EXECUTION_FAILED')
            : 'MISSING_TERMINAL_COMPLETION'
        const terminalError = new Error(failureMessage)
        lastError = terminalError
        this.recordFailure(providerId, terminalError)

        this.emitEvent({
          type: 'agent:failed',
          agentId: providerId,
          runId: attemptRunId,
          errorCode: failureCode,
          message: failureMessage,
        })

        // If the adapter never emitted a failed event, synthesize one so
        // downstream observers receive a terminal failure signal for this provider.
        if (!sawFailed) {
          yield {
            type: 'adapter:failed',
            providerId,
            error: failureMessage,
            code: failureCode,
            timestamp: Date.now(),
          }
        }

      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (ForgeError.is(err) && err.code === 'AGENT_ABORTED' && !didTimeout) {
          throw err
        }

        lastError = error
        this.recordFailure(providerId, error)

        const errorCode = didTimeout ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED'
        const errorMessage = didTimeout
          ? `Adapter ${providerId} exceeded registry timeout of ${effectiveTimeoutMs}ms`
          : error.message

        this.emitEvent({
          type: 'agent:failed',
          agentId: providerId,
          runId: attemptRunId,
          errorCode,
          message: errorMessage,
        })

        // Yield a failed event for this adapter so consumers can observe
        yield {
          type: 'adapter:failed',
          providerId,
          error: errorMessage,
          code: errorCode,
          timestamp: Date.now(),
        }

        // Continue to next adapter in fallback chain
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    }

    // All adapters exhausted
    throw new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: `All adapters failed. Last error: ${lastError?.message ?? 'unknown'}`,
      recoverable: false,
      cause: lastError,
      suggestion: 'Check adapter health and circuit breaker states',
      context: {
        attemptedProviders: ordered,
        taskTags: task.tags,
      },
    })
  }

  /** Record a successful execution for the adapter's circuit breaker. */
  recordSuccess(providerId: AdapterProviderId): void {
    const breaker = this.breakers.get(providerId)
    if (!breaker) return

    const wasClosed = breaker.getState() === 'closed'
    breaker.recordSuccess()
    this.lastSuccess.set(providerId, Date.now())
    this.consecutiveFailures.set(providerId, 0)

    if (!wasClosed) {
      this.emitEvent({
        type: 'provider:circuit_closed',
        provider: providerId,
      })
    }
  }

  /** Record a failure for the adapter's circuit breaker. */
  recordFailure(providerId: AdapterProviderId, error: Error): void {
    const breaker = this.breakers.get(providerId)
    if (!breaker) return

    const wasOpen = breaker.getState() === 'open'
    breaker.recordFailure()
    this.lastFailure.set(providerId, Date.now())
    this.consecutiveFailures.set(providerId, (this.consecutiveFailures.get(providerId) ?? 0) + 1)

    if (!wasOpen && breaker.getState() === 'open') {
      this.emitEvent({
        type: 'provider:circuit_opened',
        provider: providerId,
      })
    }

    this.emitEvent({
      type: 'provider:failed',
      tier: 'adapter',
      provider: providerId,
      message: error.message,
    })
  }

  /** Get health status for all registered adapters. */
  async getHealthStatus(): Promise<Record<string, HealthStatus>> {
    const result: Record<string, HealthStatus> = {}

    const entries = [...this.adapters.entries()]
    const checks = await Promise.allSettled(
      entries.map(([id, adapter]) => adapter.healthCheck().then((h) => ({ id, health: h }))),
    )

    for (const check of checks) {
      if (check.status === 'fulfilled') {
        const { id, health } = check.value
        const healthWithMonitorStatus = {
          ...health,
          monitorStatus: health.monitorStatus ?? getDefaultMonitorStatus(id),
        }
        if (this.disabledAdapters.has(id)) {
          result[id] = { ...healthWithMonitorStatus, healthy: false, lastError: 'disabled' }
        } else {
          result[id] = healthWithMonitorStatus
        }
      } else {
        // If healthCheck itself throws, synthesize a status
        // We need to figure out which adapter it was — use index correlation
        const idx = checks.indexOf(check)
        const entry = entries[idx]
        if (entry) {
          const [id] = entry
          result[id] = {
            healthy: false,
            providerId: id,
            sdkInstalled: false,
            cliAvailable: false,
            lastError: check.reason instanceof Error ? check.reason.message : String(check.reason),
            monitorStatus: getDefaultMonitorStatus(id),
          }
        }
      }
    }

    return result
  }

  /**
   * Get detailed health with circuit breaker state for each adapter.
   * Use for /health/detailed endpoints and Kubernetes readiness probes.
   */
  async getDetailedHealth(): Promise<ProviderAdapterRegistryHealthStatus> {
    const basicHealth = await this.getHealthStatus()
    const adapters: Record<string, ProviderAdapterHealthDetail> = {}

    let allHealthy = true
    let anyHealthy = false

    for (const [id, health] of Object.entries(basicHealth)) {
      const breaker = this.breakers.get(id as AdapterProviderId)
      const lastSuccessAt = this.lastSuccess.get(id as AdapterProviderId)
      const lastFailureAt = this.lastFailure.get(id as AdapterProviderId)
      const { lastError, ...healthWithoutLastError } = health
      adapters[id] = {
        ...healthWithoutLastError,
        ...(lastError !== undefined ? { lastError } : {}),
        circuitState: breaker?.getState() ?? 'closed',
        consecutiveFailures: this.consecutiveFailures.get(id as AdapterProviderId) ?? 0,
        ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      }
      if (health.healthy) anyHealthy = true
      else allHealthy = false
    }

    return {
      status: allHealthy ? 'healthy' : anyHealthy ? 'degraded' : 'unhealthy',
      adapters,
      timestamp: Date.now(),
    }
  }

  /** List all registered adapter provider IDs. */
  listAdapters(): AdapterProviderId[] {
    return [...this.adapters.keys()]
  }

  /** Set the routing strategy. */
  setRouter(strategy: TaskRoutingStrategy): this {
    this.router = strategy
    return this
  }

  /** Warm up all registered adapters by pre-loading their SDKs. */
  async warmupAll(): Promise<void> {
    const warmups = this.listAdapters().map(async (id) => {
      const adapter = this.get(id)
      if (adapter?.warmup) {
        try { await adapter.warmup() } catch { /* non-fatal */ }
      }
    })
    await Promise.all(warmups)
  }

  /** Set the event bus for emitting adapter events. */
  setEventBus(bus: DzupEventBus): this {
    this.eventBus = bus
    return this
  }

  // --- Private helpers ---

  /**
   * Build an adapter:progress event describing the registry's routing decision.
   * Emitted once per executeWithFallback call before the first attempt so callers
   * (NDJSON tail-f, dashboards, audit logs) can observe which provider was
   * selected and the full fallback chain.
   */
  private buildRoutingProgressEvent(args: {
    providerId: AdapterProviderId | undefined
    decision: RoutingDecision
    ordered: AdapterProviderId[]
    input: AgentInput
    message: string
  }): Extract<AgentEvent, { type: 'adapter:progress' }> {
    const providerId = args.providerId ?? (args.ordered[0] as AdapterProviderId)
    return {
      type: 'adapter:progress',
      providerId,
      timestamp: Date.now(),
      phase: 'registry:routing',
      message: args.message,
      total: args.ordered.length,
      current: 0,
      ...(args.input.correlationId ? { correlationId: args.input.correlationId } : {}),
    }
  }

  /**
   * Build an adapter:progress event for a single fallback attempt.
   * `current` is 1-indexed within `total` so progress UIs render correctly.
   */
  private buildAttemptProgressEvent(args: {
    providerId: AdapterProviderId
    attemptIdx: number
    totalAttempts: number
    input: AgentInput
    message: string
  }): Extract<AgentEvent, { type: 'adapter:progress' }> {
    return {
      type: 'adapter:progress',
      providerId: args.providerId,
      timestamp: Date.now(),
      phase: args.attemptIdx === 0 ? 'registry:primary_attempt' : 'registry:fallback_attempt',
      message: args.message,
      current: args.attemptIdx + 1,
      total: args.totalAttempts,
      ...(args.input.correlationId ? { correlationId: args.input.correlationId } : {}),
    }
  }

  private getHealthyProviderIds(): AdapterProviderId[] {
    const ids: AdapterProviderId[] = []
    for (const [id] of this.adapters) {
      if (this.disabledAdapters.has(id)) continue
      const breaker = this.breakers.get(id)
      if (!breaker || breaker.canExecute()) {
        ids.push(id)
      }
    }
    return ids
  }

  /**
   * Build the fallback order: primary first, then fallbacks from the decision,
   * then any remaining healthy adapters not already listed.
   */
  private buildFallbackOrder(
    decision: RoutingDecision,
    healthyIds: AdapterProviderId[],
  ): AdapterProviderId[] {
    const ordered: AdapterProviderId[] = []
    const seen = new Set<AdapterProviderId>()

    const addUnique = (id: AdapterProviderId): void => {
      if (!seen.has(id) && healthyIds.includes(id)) {
        seen.add(id)
        ordered.push(id)
      }
    }

    // Primary
    if (decision.provider !== 'auto') {
      addUnique(decision.provider)
    }

    // Explicit fallbacks from the routing decision
    if (decision.fallbackProviders) {
      for (const fb of decision.fallbackProviders) {
        addUnique(fb)
      }
    }

    // Remaining healthy adapters
    for (const id of healthyIds) {
      addUnique(id)
    }

    return ordered
  }

  private emitEvent(
    event:
      | { type: 'agent:started'; agentId: string; runId: string }
      | {
          type: 'agent:completed'
          agentId: string
          runId: string
          durationMs: number
          /**
           * Optional token usage surfaced by the underlying adapter.
           * Forwarded verbatim to the event bus so downstream consumers
           * (cost attribution, relay aggregators) can reason about real
           * token counts. Omitted when the adapter didn't return usage.
           */
          usage?: TokenUsage
        }
      | { type: 'agent:failed'; agentId: string; runId: string; errorCode: string; message: string }
      | { type: 'provider:failed'; tier: string; provider: string; message: string }
      | { type: 'provider:circuit_opened'; provider: string }
      | { type: 'provider:circuit_closed'; provider: string }
      | { type: 'adapter_registry:provider_registered'; providerId: string; name: string }
      | { type: 'adapter_registry:provider_deregistered'; providerId: string; reason: string },
  ): void {
    if (this.eventBus) {
      // The event types are a subset of DzupEvent. `usage` on agent:completed
      // is an additive extension not yet declared on the core DzupEvent
      // union — receivers read JSON, not the compile-time type, so the
      // extra field is safe on the wire (same pattern used by
      // `pipeline:run_completed` in relay-orchestrator).
      this.eventBus.emit(event as Parameters<DzupEventBus['emit']>[0])
    }
  }
}
