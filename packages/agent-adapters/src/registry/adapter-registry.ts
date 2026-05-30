/**
 * ProviderAdapterRegistry — backward-compatible facade for adapter management.
 *
 * Delegates to three focused sub-modules:
 *  - {@link AdapterRegistryCore} — pure CRUD (register, get, enable/disable, list).
 *  - {@link AdapterHealthMonitor} — circuit-breaker bookkeeping and health.
 *    Reuses the `CircuitBreaker` primitive from `@dzupagent/core`.
 *  - {@link AdapterRegistryRouter} — routing strategy and fallback execution.
 *
 * Productization note:
 *   The `goose`, `crush`, and `gemini-sdk` providers are core-only and
 *   NOT productized. They may be registered here for framework use but
 *   are excluded from product-facing surfaces — see `provider-catalog.ts`
 *   (`productIntegrated: false`) for the authoritative policy.
 */

import type { CircuitBreakerConfig, DzupEventBus } from '@dzupagent/core/advanced'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  HealthStatus,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

import { AdapterHealthMonitor } from './health-monitor.js'
import type {
  ProviderAdapterHealthDetail,
  ProviderAdapterRegistryHealthStatus,
} from './health-monitor.js'
import { AdapterRegistryCore } from './registry-core.js'
import { AdapterRegistryRouter } from './registry-router.js'

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

export type { ProviderAdapterHealthDetail, ProviderAdapterRegistryHealthStatus }

export class ProviderAdapterRegistry {
  private readonly core: AdapterRegistryCore
  private readonly health: AdapterHealthMonitor
  private readonly router: AdapterRegistryRouter

  constructor(config?: ProviderAdapterRegistryConfig) {
    this.health = new AdapterHealthMonitor(config?.circuitBreaker)
    this.core = new AdapterRegistryCore(this.health)
    this.router = new AdapterRegistryRouter(this.core, this.health, config?.executionTimeoutMs)
  }

  // --- CRUD (delegates to core) ---

  register(adapter: AgentCLIAdapter): this {
    this.core.register(adapter)
    return this
  }

  registerProductionAdapters(adapters: AgentCLIAdapter[]): this {
    this.core.registerProductionAdapters(adapters)
    return this
  }

  registerExperimentalAdapters(adapters: AgentCLIAdapter[], flag: string): this {
    this.core.registerExperimentalAdapters(adapters, flag)
    return this
  }

  unregister(providerId: AdapterProviderId): boolean {
    return this.core.unregister(providerId)
  }

  disable(providerId: AdapterProviderId): boolean {
    return this.core.disable(providerId)
  }

  enable(providerId: AdapterProviderId): boolean {
    return this.core.enable(providerId)
  }

  isEnabled(providerId: AdapterProviderId): boolean {
    return this.core.isEnabled(providerId)
  }

  get(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    return this.core.get(providerId)
  }

  getHealthy(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    return this.core.getHealthy(providerId)
  }

  listAdapters(): AdapterProviderId[] {
    return this.core.listAdapters()
  }

  async respondInteraction(
    providerId: AdapterProviderId,
    interactionId: string,
    answer: string,
  ): Promise<boolean> {
    return await this.core.respondInteraction(providerId, interactionId, answer)
  }

  async warmupAll(): Promise<void> {
    await this.core.warmupAll()
  }

  setEventBus(bus: DzupEventBus): this {
    this.core.setEventBus(bus)
    return this
  }

  // --- Routing (delegates to router) ---

  setRouter(strategy: TaskRoutingStrategy): this {
    this.router.setStrategy(strategy)
    return this
  }

  getForTask(task: TaskDescriptor): { adapter: AgentCLIAdapter; decision: RoutingDecision } {
    return this.router.getForTask(task)
  }

  /**
   * Execute with automatic fallback.
   *
   * Tries the primary adapter selected by the router, then falls back
   * through alternatives on failure. Emits lifecycle events throughout.
   */
  executeWithFallback(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    return this.router.executeWithFallback(input, task)
  }

  executeWithFallbackWithRaw(
    input: AgentInput,
    task: TaskDescriptor,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    return this.router.executeWithFallbackWithRaw(input, task)
  }

  // --- Health (delegates to health monitor) ---

  /** Record a successful execution for the adapter's circuit breaker. */
  recordSuccess(providerId: AdapterProviderId): void {
    const transition = this.health.recordSuccess(providerId)
    if (transition.closed) {
      this.core.getEventBus()?.emit({ type: 'provider:circuit_closed', provider: providerId })
    }
  }

  /** Record a failure for the adapter's circuit breaker. */
  recordFailure(providerId: AdapterProviderId, error: Error): void {
    const transition = this.health.recordFailure(providerId)
    const bus = this.core.getEventBus()
    if (transition.opened) {
      bus?.emit({ type: 'provider:circuit_opened', provider: providerId })
    }
    bus?.emit({
      type: 'provider:failed',
      tier: 'adapter',
      provider: providerId,
      message: error.message,
    })
  }

  async getHealthStatus(): Promise<Record<string, HealthStatus>> {
    return await this.health.getHealthStatus(this.core.getAdaptersMap(), this.core.getDisabledSet())
  }

  async getDetailedHealth(): Promise<ProviderAdapterRegistryHealthStatus> {
    return await this.health.getDetailedHealth(this.core.getAdaptersMap(), this.core.getDisabledSet())
  }
}
