import type { ForgePlugin, PluginContext } from './plugin-types.js'
import type { ForgeEventBus } from '../events/event-bus.js'
import type { ForgeEvent } from '../events/event-types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { AgentHooks } from '../hooks/hook-types.js'

/**
 * Registry for ForgeAgent plugins.
 *
 * Manages plugin registration, validates for conflicts, and provides
 * aggregated middleware/hooks/event handlers for agent creation.
 *
 * @example
 * ```ts
 * const registry = new PluginRegistry(eventBus)
 * await registry.register(sentryPlugin, { eventBus, modelRegistry })
 * await registry.register(mcpPlugin, { eventBus, modelRegistry })
 *
 * // At agent creation:
 * const allMiddleware = registry.getMiddleware()
 * const allHooks = registry.getHooks()
 * ```
 */
export class PluginRegistry {
  private plugins = new Map<string, ForgePlugin>()
  private eventBus: ForgeEventBus

  constructor(eventBus: ForgeEventBus) {
    this.eventBus = eventBus
  }

  /** Register a plugin. Throws on duplicate name. */
  async register(plugin: ForgePlugin, ctx: PluginContext): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`)
    }

    // Run onRegister callback
    if (plugin.onRegister) {
      await plugin.onRegister(ctx)
    }

    // Subscribe event handlers
    if (plugin.eventHandlers) {
      for (const [eventType, handler] of Object.entries(plugin.eventHandlers)) {
        if (typeof handler === 'function') {
          this.eventBus.on(
            eventType as ForgeEvent['type'],
            handler as (event: ForgeEvent) => void,
          )
        }
      }
    }

    this.plugins.set(plugin.name, plugin)
    this.eventBus.emit({ type: 'plugin:registered', pluginName: plugin.name })
  }

  /** Check if a plugin is registered */
  has(name: string): boolean {
    return this.plugins.has(name)
  }

  /** Get all registered plugin names */
  listPlugins(): string[] {
    return [...this.plugins.keys()]
  }

  /** Aggregate all middleware from all plugins */
  getMiddleware(): AgentMiddleware[] {
    const result: AgentMiddleware[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.middleware) result.push(...plugin.middleware)
    }
    return result
  }

  /** Aggregate all hooks from all plugins */
  getHooks(): Partial<AgentHooks>[] {
    const result: Partial<AgentHooks>[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks) result.push(plugin.hooks)
    }
    return result
  }

  /** Get a specific plugin by name */
  get(name: string): ForgePlugin | undefined {
    return this.plugins.get(name)
  }
}
