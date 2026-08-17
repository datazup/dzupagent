import type {
  DzupPlugin,
  PluginContext,
  PluginDisposeResult,
  PluginRegistrationConflictDiagnostic,
  PluginRegistrationOptions,
  PluginSource,
} from './plugin-types.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { AgentHooks } from '../hooks/hook-types.js'
import { composeAgentHooks } from './plugin-hooks.js'

interface RegisteredPlugin {
  plugin: DzupPlugin
  source: PluginSource
  path: string
  eventDisposers: Array<() => void>
}

export class PluginRegistrationConflictError extends Error {
  readonly diagnostic: PluginRegistrationConflictDiagnostic

  constructor(diagnostic: PluginRegistrationConflictDiagnostic) {
    super(
      `Plugin "${diagnostic.name}" is already registered ` +
      `(new: ${diagnostic.source}:${diagnostic.path}; existing: ${diagnostic.previousSource}:${diagnostic.previousPath})`,
    )
    this.name = 'PluginRegistrationConflictError'
    this.diagnostic = diagnostic
  }
}

/**
 * Registry for DzupAgent plugins.
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
  private plugins = new Map<string, RegisteredPlugin>()
  private eventBus: DzupEventBus

  constructor(eventBus: DzupEventBus) {
    this.eventBus = eventBus
  }

  /** Register a plugin. Throws on duplicate name unless override is explicit. */
  async register(
    plugin: DzupPlugin,
    ctx: PluginContext,
    options?: PluginRegistrationOptions,
  ): Promise<void> {
    const existing = this.plugins.get(plugin.name)
    const source = options?.source ?? 'unknown'
    const path = options?.path ?? '<runtime>'
    const overrideExisting = options?.overrideExisting ?? false

    if (existing && !overrideExisting) {
      throw new PluginRegistrationConflictError({
        signal: 'plugin_registration_conflict_count',
        name: plugin.name,
        source,
        path,
        previousSource: existing.source,
        previousPath: existing.path,
      })
    }

    if (existing && overrideExisting) {
      this.unregisterPlugin(plugin.name)
    }

    // Run onRegister callback.
    //
    // `onRegister` is declared `=> void` so that expression-bodied callbacks
    // stay assignable (see DzupPlugin). The registry still has to await a
    // promise the plugin actually returned, so the result is widened to
    // `unknown` — `void` is assignable to `unknown`, and awaiting `unknown`
    // resolves a thenable and passes anything else straight through. The call
    // stays in method position so `this` is still bound to the plugin object.
    if (plugin.onRegister) {
      const registered: unknown = plugin.onRegister(ctx)
      await registered
    }

    const eventDisposers: Array<() => void> = []

    // Subscribe event handlers
    if (plugin.eventHandlers) {
      for (const [eventType, handler] of Object.entries(plugin.eventHandlers)) {
        if (typeof handler === 'function') {
          const dispose = this.eventBus.on(
            eventType as DzupEvent['type'],
            handler as (event: DzupEvent) => void,
          )
          eventDisposers.push(dispose)
        }
      }
    }

    this.plugins.set(plugin.name, {
      plugin,
      source,
      path,
      eventDisposers,
    })

    this.eventBus.emit({ type: 'plugin:registered', pluginName: plugin.name })
  }

  /** Dispose event subscriptions for a plugin, preserving registration metadata. */
  disposePlugin(name: string): PluginDisposeResult {
    const registered = this.plugins.get(name)
    if (!registered) {
      return {
        disposed: false,
        disposerCount: 0,
        telemetry: {
          signal: 'plugin_disposer_cleanup_count',
          pluginName: name,
          disposerCount: 0,
        },
      }
    }

    const disposerCount = registered.eventDisposers.length
    for (const dispose of registered.eventDisposers) {
      try {
        dispose()
      } catch {
        // disposal is best-effort; isolate plugin teardown failures
      }
    }
    registered.eventDisposers = []

    return {
      disposed: true,
      disposerCount,
      telemetry: {
        signal: 'plugin_disposer_cleanup_count',
        pluginName: name,
        disposerCount,
      },
    }
  }

  /** Dispose handlers and remove plugin registration. */
  unregisterPlugin(name: string): PluginDisposeResult {
    const disposed = this.disposePlugin(name)
    this.plugins.delete(name)
    return disposed
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
      if (plugin.plugin.middleware) result.push(...plugin.plugin.middleware)
    }
    return result
  }

  /** Aggregate all hooks from all plugins */
  getHooks(): Partial<AgentHooks>[] {
    const result: Partial<AgentHooks>[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.plugin.hooks) result.push(plugin.plugin.hooks)
    }
    return result
  }

  /**
   * Collapse every registered plugin's hooks — plus the agent's own — into a
   * SINGLE `AgentHooks` object suitable for `DzupAgentConfig.hooks`.
   *
   * This is the consumer `getHooks()` never had. `getHooks()` returns an
   * ARRAY of partial hook sets while `AgentHooks` declares each key as one
   * optional function, so a plugin's `hooks` could be registered and
   * aggregated but never handed to an agent — and therefore never dispatched.
   * Feed the result to the agent config and the existing run-boundary dispatch
   * runs plugin hooks with no further wiring:
   *
   * ```ts
   * const agent = new DzupAgent({
   *   hooks: registry.toAgentHooks(myOwnHooks),
   *   eventBus,
   * })
   * ```
   *
   * Order is **plugins in registration order, then `agentHooks` last**, so for
   * the value-returning hooks the application's own hook has the final say
   * over any ambient plugin. See {@link composeAgentHooks}.
   *
   * Hook errors are isolated and reported on the registry's own event bus by
   * default — the same bus that receives `plugin:registered`. Pass
   * `options.eventBus` when the agent runs on a different bus.
   *
   * Keys nothing contributed are OMITTED rather than set to a no-op, so an
   * unregistered hook stays observably distinct from a registered one.
   */
  toAgentHooks(
    agentHooks?: Partial<AgentHooks>,
    options?: { eventBus?: DzupEventBus },
  ): AgentHooks {
    return composeAgentHooks([...this.getHooks(), agentHooks], {
      eventBus: options?.eventBus ?? this.eventBus,
    })
  }

  /** Get a specific plugin by name */
  get(name: string): DzupPlugin | undefined {
    return this.plugins.get(name)?.plugin
  }
}

