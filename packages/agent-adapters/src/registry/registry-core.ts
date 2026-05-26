/**
 * AdapterRegistryCore — pure CRUD for adapter registration and lookup.
 *
 * Owns:
 *  - the `adapters` map keyed by provider id.
 *  - the `disabledAdapters` set.
 *  - the optional event bus reference (for emit helpers shared with the
 *    facade and router).
 *
 * Knows nothing about routing or fallback orchestration.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { AdapterProviderId, AgentCLIAdapter } from '../types.js'
import { getProviderCapabilities } from '../provider-catalog.js'

import type { AdapterHealthMonitor } from './health-monitor.js'

/**
 * Event payloads emitted by the registry. These mirror the shape used
 * throughout the agent-adapters package so tests and observers don't
 * need a separate bus contract for registry-only events.
 */
export type RegistryEvent =
  | { type: 'adapter_registry:provider_registered'; providerId: string; name: string }
  | { type: 'adapter_registry:provider_deregistered'; providerId: string; reason: string }

export class AdapterRegistryCore {
  private readonly adapters = new Map<AdapterProviderId, AgentCLIAdapter>()
  private readonly disabled = new Set<AdapterProviderId>()
  private eventBus: DzupEventBus | undefined

  constructor(private readonly health: AdapterHealthMonitor) {}

  /** Register an adapter. Creates a circuit breaker for it via the health monitor. */
  register(adapter: AgentCLIAdapter): this {
    this.adapters.set(adapter.providerId, adapter)
    this.health.ensureBreaker(adapter.providerId)
    this.emit({
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
      if (caps?.productIntegrated) this.register(adapter)
    }
    return this
  }

  /**
   * Register experimental (productIntegrated: false) adapters, gated by an
   * explicit non-empty opt-in flag string. Production adapters in the
   * array are silently skipped — use `registerProductionAdapters` for those.
   */
  registerExperimentalAdapters(adapters: AgentCLIAdapter[], flag: string): this {
    if (!flag || flag.trim() === '') {
      throw new Error('registerExperimentalAdapters requires a non-empty flag string opt-in')
    }
    for (const adapter of adapters) {
      const caps = getProviderCapabilities(adapter.providerId)
      if (caps && !caps.productIntegrated) this.register(adapter)
    }
    return this
  }

  /** Unregister an adapter by provider ID. Returns true if it existed. */
  unregister(providerId: AdapterProviderId): boolean {
    const existed = this.adapters.has(providerId)
    this.adapters.delete(providerId)
    this.health.forget(providerId)
    this.disabled.delete(providerId)
    if (existed) {
      this.emit({
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
    this.disabled.add(providerId)
    return true
  }

  /** Re-enable a disabled adapter. */
  enable(providerId: AdapterProviderId): boolean {
    return this.disabled.delete(providerId)
  }

  /** Check if an adapter is registered and enabled. */
  isEnabled(providerId: AdapterProviderId): boolean {
    return this.adapters.has(providerId) && !this.disabled.has(providerId)
  }

  /** Get an adapter by provider ID (no health check). */
  get(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    return this.adapters.get(providerId)
  }

  /** Get adapter only if registered, enabled, and its circuit breaker allows execution. */
  getHealthy(providerId: AdapterProviderId): AgentCLIAdapter | undefined {
    const adapter = this.adapters.get(providerId)
    if (!adapter) return undefined
    if (this.disabled.has(providerId)) return undefined
    if (!this.health.canExecute(providerId)) return undefined
    return adapter
  }

  /** All provider ids currently passing both `isEnabled` and circuit-breaker checks. */
  getHealthyProviderIds(): AdapterProviderId[] {
    const ids: AdapterProviderId[] = []
    for (const [id] of this.adapters) {
      if (this.disabled.has(id)) continue
      if (this.health.canExecute(id)) ids.push(id)
    }
    return ids
  }

  /** List all registered adapter provider IDs. */
  listAdapters(): AdapterProviderId[] {
    return [...this.adapters.keys()]
  }

  /** Read-only handle to the internal adapters map (for the health monitor / router). */
  getAdaptersMap(): ReadonlyMap<AdapterProviderId, AgentCLIAdapter> {
    return this.adapters
  }

  /** Read-only handle to the disabled set. */
  getDisabledSet(): ReadonlySet<AdapterProviderId> {
    return this.disabled
  }

  async respondInteraction(
    providerId: AdapterProviderId,
    interactionId: string,
    answer: string,
  ): Promise<boolean> {
    const adapter = this.adapters.get(providerId)
    if (!adapter || typeof adapter.respondInteraction !== 'function') return false
    return await adapter.respondInteraction(interactionId, answer)
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

  /** Set the event bus for emitting registry events. */
  setEventBus(bus: DzupEventBus): this {
    this.eventBus = bus
    return this
  }

  /** Returns the current event bus (for the router so its emissions go to the same bus). */
  getEventBus(): DzupEventBus | undefined {
    return this.eventBus
  }

  private emit(event: RegistryEvent): void {
    this.eventBus?.emit(event)
  }
}
