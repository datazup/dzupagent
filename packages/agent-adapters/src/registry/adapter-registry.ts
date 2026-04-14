/**
 * AdapterRegistry — manages agent adapters with circuit breaker integration,
 * event bus observability, and automatic fallback execution.
 *
 * Each adapter is tracked by its AdapterProviderId. Circuit breakers prevent
 * routing to unhealthy adapters, and the event bus provides unified
 * observability across all adapter operations.
 */

import { CircuitBreaker, ForgeError } from '@dzupagent/core'
import type { CircuitBreakerConfig, DzupEventBus } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

import { TagBasedRouter } from './task-router.js'

export interface AdapterRegistryConfig {
  /** Circuit breaker config applied to all adapters */
  circuitBreaker?: Partial<CircuitBreakerConfig> | undefined
}

/** Detailed per-adapter health including circuit breaker diagnostics. */
export interface AdapterHealthDetail {
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
}

/** Aggregated detailed health status for all registered adapters. */
export interface DetailedHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  adapters: Record<string, AdapterHealthDetail>
  timestamp: number
}

export class AdapterRegistry {
  private readonly adapters = new Map<AdapterProviderId, AgentCLIAdapter>()
  private readonly breakers = new Map<AdapterProviderId, CircuitBreaker>()
  private readonly cbConfig: Partial<CircuitBreakerConfig> | undefined
  private readonly lastSuccess = new Map<AdapterProviderId, number>()
  private readonly lastFailure = new Map<AdapterProviderId, number>()
  private readonly consecutiveFailures = new Map<AdapterProviderId, number>()
  private readonly disabledAdapters = new Set<AdapterProviderId>()
  private router: TaskRoutingStrategy = new TagBasedRouter()
  private eventBus: DzupEventBus | undefined

  constructor(config?: AdapterRegistryConfig) {
    this.cbConfig = config?.circuitBreaker
  }

  /** Register an adapter. Creates a circuit breaker for it. */
  register(adapter: AgentCLIAdapter): this {
    this.adapters.set(adapter.providerId, adapter)
    if (!this.breakers.has(adapter.providerId)) {
      this.breakers.set(adapter.providerId, new CircuitBreaker(this.cbConfig))
    }
    this.emitEvent({
      type: 'registry:agent_registered',
      agentId: adapter.providerId,
      name: `adapter:${adapter.providerId}`,
    })
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
        type: 'registry:agent_deregistered',
        agentId: providerId,
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
    const breaker = this.breakers.get(providerId)
    if (breaker && !breaker.canExecute()) return undefined
    return adapter
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

    let lastError: Error | undefined

    for (const providerId of ordered) {
      const adapter = this.adapters.get(providerId)
      const breaker = this.breakers.get(providerId)
      if (!adapter || (breaker && !breaker.canExecute())) continue

      try {
        let sawCompleted = false
        let sawFailed = false
        let lastFailedEvent: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

        this.emitEvent({
          type: 'agent:started',
          agentId: providerId,
          runId: `${providerId}-${Date.now()}`,
        })

        const startMs = Date.now()
        const gen = adapter.execute(input)

        for await (const event of gen) {
          if (event.type === 'adapter:completed') {
            sawCompleted = true
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
            runId: `${providerId}-${startMs}`,
            durationMs: Date.now() - startMs,
          })
          return // successfully completed
        }

        const failureMessage = sawFailed
          ? (lastFailedEvent?.error ?? 'Adapter emitted failure event without details')
          : 'Adapter stream ended without terminal adapter:completed event'
        const failureCode = sawFailed
          ? (lastFailedEvent?.code ?? 'ADAPTER_EXECUTION_FAILED')
          : 'MISSING_TERMINAL_COMPLETION'
        const terminalError = new Error(failureMessage)
        lastError = terminalError
        this.recordFailure(providerId, terminalError)

        this.emitEvent({
          type: 'agent:failed',
          agentId: providerId,
          runId: `${providerId}-fallback`,
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
        if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
          throw err
        }

        lastError = error
        this.recordFailure(providerId, error)

        this.emitEvent({
          type: 'agent:failed',
          agentId: providerId,
          runId: `${providerId}-fallback`,
          errorCode: 'ADAPTER_EXECUTION_FAILED',
          message: error.message,
        })

        // Yield a failed event for this adapter so consumers can observe
        yield {
          type: 'adapter:failed',
          providerId,
          error: error.message,
          code: 'ADAPTER_EXECUTION_FAILED',
          timestamp: Date.now(),
        }

        // Continue to next adapter in fallback chain
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
        if (this.disabledAdapters.has(id)) {
          result[id] = { ...health, healthy: false, lastError: 'disabled' }
        } else {
          result[id] = health
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
  async getDetailedHealth(): Promise<DetailedHealthStatus> {
    const basicHealth = await this.getHealthStatus()
    const adapters: Record<string, AdapterHealthDetail> = {}

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
      | { type: 'agent:completed'; agentId: string; runId: string; durationMs: number }
      | { type: 'agent:failed'; agentId: string; runId: string; errorCode: string; message: string }
      | { type: 'provider:failed'; tier: string; provider: string; message: string }
      | { type: 'provider:circuit_opened'; provider: string }
      | { type: 'provider:circuit_closed'; provider: string }
      | { type: 'registry:agent_registered'; agentId: string; name: string }
      | { type: 'registry:agent_deregistered'; agentId: string; reason: string },
  ): void {
    if (this.eventBus) {
      // The event types are a subset of DzupEvent, safe to emit
      this.eventBus.emit(event as Parameters<DzupEventBus['emit']>[0])
    }
  }
}
