/**
 * AdapterRegistry — manages agent adapters with circuit breaker integration,
 * event bus observability, and automatic fallback execution.
 *
 * Each adapter is tracked by its AdapterProviderId. Circuit breakers prevent
 * routing to unhealthy adapters, and the event bus provides unified
 * observability across all adapter operations.
 */

import { CircuitBreaker, ForgeError } from '@dzipagent/core'
import type { CircuitBreakerConfig, DzipEventBus } from '@dzipagent/core'

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
  circuitBreaker?: Partial<CircuitBreakerConfig>
}

export class AdapterRegistry {
  private readonly adapters = new Map<AdapterProviderId, AgentCLIAdapter>()
  private readonly breakers = new Map<AdapterProviderId, CircuitBreaker>()
  private readonly cbConfig: Partial<CircuitBreakerConfig> | undefined
  private router: TaskRoutingStrategy = new TagBasedRouter()
  private eventBus: DzipEventBus | undefined

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
        this.emitEvent({
          type: 'agent:started',
          agentId: providerId,
          runId: `${providerId}-${Date.now()}`,
        })

        const startMs = Date.now()
        const gen = adapter.execute(input)

        for await (const event of gen) {
          yield event
        }

        // If we get here without throwing, record success
        this.recordSuccess(providerId)
        this.emitEvent({
          type: 'agent:completed',
          agentId: providerId,
          runId: `${providerId}-${startMs}`,
          durationMs: Date.now() - startMs,
        })
        return // successfully completed

      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
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
    })
  }

  /** Record a successful execution for the adapter's circuit breaker. */
  recordSuccess(providerId: AdapterProviderId): void {
    const breaker = this.breakers.get(providerId)
    if (!breaker) return

    const wasClosed = breaker.getState() === 'closed'
    breaker.recordSuccess()

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
        result[id] = health
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

  /** List all registered adapter provider IDs. */
  listAdapters(): AdapterProviderId[] {
    return [...this.adapters.keys()]
  }

  /** Set the routing strategy. */
  setRouter(strategy: TaskRoutingStrategy): this {
    this.router = strategy
    return this
  }

  /** Set the event bus for emitting adapter events. */
  setEventBus(bus: DzipEventBus): this {
    this.eventBus = bus
    return this
  }

  // --- Private helpers ---

  private getHealthyProviderIds(): AdapterProviderId[] {
    const ids: AdapterProviderId[] = []
    for (const [id] of this.adapters) {
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
      | { type: 'registry:agent_registered'; agentId: string; name: string },
  ): void {
    if (this.eventBus) {
      // The event types are a subset of DzipEvent, safe to emit
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.eventBus.emit(event as Parameters<DzipEventBus['emit']>[0])
    }
  }
}
