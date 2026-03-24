import type { ForgeEventBus } from '../events/event-bus.js'
import type { ForgeEvent } from '../events/event-types.js'
import type { AgentHooks } from '../hooks/hook-types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { ModelRegistry } from '../llm/model-registry.js'
import type { MemoryService } from '../memory/memory-service.js'

/**
 * Context available to plugins during registration.
 */
export interface PluginContext {
  eventBus: ForgeEventBus
  modelRegistry: ModelRegistry
  memoryService?: MemoryService
}

/**
 * ForgeAgent plugin interface.
 *
 * Plugins extend ForgeAgent's capabilities by contributing tools, middleware,
 * hooks, event handlers, and configuration. They are registered via
 * `PluginRegistry.register()` and resolved at agent creation time.
 *
 * @example
 * ```ts
 * const sentryPlugin: ForgePlugin = {
 *   name: 'sentry',
 *   version: '1.0.0',
 *   eventHandlers: {
 *     'agent:failed': (e) => Sentry.captureException(e),
 *   },
 * }
 * ```
 */
export interface ForgePlugin {
  /** Unique plugin name */
  name: string
  /** Semver version */
  version: string

  /** Called when the plugin is registered */
  onRegister?(ctx: PluginContext): void | Promise<void>

  /** Middleware to inject into agents */
  middleware?: AgentMiddleware[]

  /** Lifecycle hooks to merge with agent hooks */
  hooks?: Partial<AgentHooks>

  /** Event handlers to subscribe to the event bus */
  eventHandlers?: Partial<Record<ForgeEvent['type'], (event: ForgeEvent) => void | Promise<void>>>
}
