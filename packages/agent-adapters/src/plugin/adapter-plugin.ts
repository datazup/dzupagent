/**
 * AdapterPlugin — a DzipPlugin-compatible factory that auto-wires the full
 * adapter orchestration stack (registry, event bridge, cost tracking, sessions)
 * into the DzipAgent plugin system.
 *
 * This module does NOT import DzipPlugin directly to avoid pulling in
 * `@dzipagent/memory` as a transitive dependency. Instead it exports a
 * structurally-compatible object via `createAdapterPlugin()`.
 */

import type { DzipEventBus } from '@dzipagent/core'

import type { AgentCLIAdapter, TaskRoutingStrategy } from '../types.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import type { AdapterRegistryConfig } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import type { CostTrackingConfig } from '../middleware/cost-tracking.js'
import { SessionRegistry } from '../session/session-registry.js'
import type { SessionRegistryConfig } from '../session/session-registry.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AdapterPluginConfig {
  /** Adapters to register. If not provided, none are registered automatically. */
  adapters?: AgentCLIAdapter[]
  /** Registry config (circuit breaker settings) */
  registryConfig?: AdapterRegistryConfig
  /** Cost tracking config */
  costTracking?: CostTrackingConfig
  /** Session registry config */
  sessionConfig?: SessionRegistryConfig
  /** Routing strategy to use. Default: TagBasedRouter */
  router?: TaskRoutingStrategy
  /** Whether to enable event bus bridge. Default true */
  enableEventBridge?: boolean
  /** Whether to enable cost tracking. Default true */
  enableCostTracking?: boolean
  /** Whether to enable session registry. Default true */
  enableSessionRegistry?: boolean
}

// ---------------------------------------------------------------------------
// Plugin instance interface
// ---------------------------------------------------------------------------

export interface AdapterPluginInstance {
  /** Plugin name */
  readonly name: string
  /** Plugin version */
  readonly version: string
  /** Called when registered with PluginRegistry */
  onRegister(ctx: { eventBus: DzipEventBus; modelRegistry?: unknown }): void
  /** Event handlers wired up by the plugin */
  eventHandlers: Record<string, (event: unknown) => void | Promise<void>>

  /** Access the adapter registry */
  getRegistry(): AdapterRegistry
  /** Access the session registry (if enabled) */
  getSessionRegistry(): SessionRegistry | undefined
  /** Access the cost tracking middleware (if enabled) */
  getCostTracking(): CostTrackingMiddleware | undefined
  /** Access the event bus bridge (if enabled) */
  getEventBridge(): EventBusBridge | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'adapter-orchestration'
const PLUGIN_VERSION = '0.1.0'

/**
 * Creates a DzipPlugin-compatible object that wires up the full adapter
 * orchestration stack.
 *
 * @example
 * ```ts
 * const plugin = createAdapterPlugin({
 *   adapters: [new ClaudeAgentAdapter(), new CodexAdapter()],
 *   enableCostTracking: true,
 * })
 * pluginRegistry.register(plugin, ctx)
 * ```
 */
export function createAdapterPlugin(config: AdapterPluginConfig = {}): AdapterPluginInstance {
  // Subsystems — initialised lazily in onRegister
  let registry: AdapterRegistry | undefined
  let eventBridge: EventBusBridge | undefined
  let costTracking: CostTrackingMiddleware | undefined
  let sessionRegistry: SessionRegistry | undefined

  // Resolved feature flags (default true)
  const enableEventBridge = config.enableEventBridge ?? true
  const enableCostTracking = config.enableCostTracking ?? true
  const enableSessionRegistry = config.enableSessionRegistry ?? true

  // Build event handlers map — populated once during onRegister so that
  // consumers who read `plugin.eventHandlers` before registration still
  // get a stable reference.
  const eventHandlers: Record<string, (event: unknown) => void | Promise<void>> = {}

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,

    onRegister(ctx: { eventBus: DzipEventBus; modelRegistry?: unknown }): void {
      const { eventBus } = ctx

      // 1. Create AdapterRegistry
      registry = new AdapterRegistry(config.registryConfig)

      // 2. Register provided adapters
      if (config.adapters) {
        for (const adapter of config.adapters) {
          registry.register(adapter)
        }
      }

      // 3. Set routing strategy (if provided)
      if (config.router) {
        registry.setRouter(config.router)
      }

      // 4. Wire event bus on the registry
      registry.setEventBus(eventBus)

      // 5. Event bus bridge
      if (enableEventBridge) {
        eventBridge = new EventBusBridge(eventBus)
      }

      // 6. Cost tracking middleware
      if (enableCostTracking) {
        const costConfig: CostTrackingConfig = {
          ...config.costTracking,
          eventBus,
        }
        costTracking = new CostTrackingMiddleware(costConfig)
      }

      // 7. Session registry
      if (enableSessionRegistry) {
        const sessionConfig: SessionRegistryConfig = {
          ...config.sessionConfig,
          eventBus,
        }
        sessionRegistry = new SessionRegistry(sessionConfig)
      }

      // 8. Subscribe to events for observability
      wireEventHandlers(eventBus)
    },

    eventHandlers,

    getRegistry(): AdapterRegistry {
      if (!registry) {
        throw new Error(
          `AdapterPlugin "${PLUGIN_NAME}" has not been registered yet. ` +
            'Call onRegister() first.',
        )
      }
      return registry
    },

    getSessionRegistry(): SessionRegistry | undefined {
      return sessionRegistry
    },

    getCostTracking(): CostTrackingMiddleware | undefined {
      return costTracking
    },

    getEventBridge(): EventBusBridge | undefined {
      return eventBridge
    },
  }

  // -------------------------------------------------------------------------
  // Internal: wire event handlers onto the bus and into the eventHandlers map
  // -------------------------------------------------------------------------

  function wireEventHandlers(eventBus: DzipEventBus): void {
    // agent:failed — record failure in circuit breaker via registry
    const handleAgentFailed = (event: unknown): void => {
      const e = event as { type: string; agentId?: string; message?: string }
      if (registry && e.agentId) {
        // The registry's recordFailure expects an AdapterProviderId.
        // Only record if the agentId matches a registered adapter.
        const adapters = registry.listAdapters()
        const providerId = e.agentId
        if (adapters.includes(providerId as Parameters<typeof adapters.includes>[0])) {
          registry.recordFailure(
            providerId as Parameters<typeof registry.recordFailure>[0],
            new Error(typeof e.message === 'string' ? e.message : 'Agent failed'),
          )
        }
      }
    }

    // provider:circuit_opened — log warning
    const handleCircuitOpened = (event: unknown): void => {
      const e = event as { type: string; provider?: string }
      // eslint-disable-next-line no-console
      console.warn(
        `[${PLUGIN_NAME}] Circuit breaker OPENED for provider "${e.provider ?? 'unknown'}". ` +
          'Requests will be routed to fallback adapters.',
      )
    }

    // provider:circuit_closed — log recovery
    const handleCircuitClosed = (event: unknown): void => {
      const e = event as { type: string; provider?: string }
      // eslint-disable-next-line no-console
      console.info(
        `[${PLUGIN_NAME}] Circuit breaker CLOSED for provider "${e.provider ?? 'unknown'}". ` +
          'Provider has recovered.',
      )
    }

    // Subscribe on the event bus
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.on('agent:failed' as any, handleAgentFailed as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.on('provider:circuit_opened' as any, handleCircuitOpened as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.on('provider:circuit_closed' as any, handleCircuitClosed as any)

    // Expose on the eventHandlers record so PluginRegistry can introspect
    eventHandlers['agent:failed'] = handleAgentFailed
    eventHandlers['provider:circuit_opened'] = handleCircuitOpened
    eventHandlers['provider:circuit_closed'] = handleCircuitClosed
  }
}
