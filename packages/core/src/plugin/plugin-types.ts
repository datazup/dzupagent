import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { AgentHooks } from '../hooks/hook-types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { ModelRegistry } from '../llm/model-registry.js'

/**
 * Context available to plugins during registration.
 */
export interface PluginContext {
  eventBus: DzupEventBus
  modelRegistry: ModelRegistry
  /**
   * Optional memory-service reference.
   *
   * Typed as `unknown` to avoid a layer inversion (core -> memory).
   * Plugins that need the real `MemoryService` should import it from
   * `@dzupagent/memory` and cast: `context.memoryService as MemoryService`.
   */
  memoryService?: unknown
}

/**
 * DzupAgent plugin interface.
 *
 * Plugins extend DzupAgent's capabilities by contributing tools, middleware,
 * hooks, event handlers, and configuration. They are registered via
 * `PluginRegistry.register()` and resolved at agent creation time.
 *
 * Plugin-supplied callbacks below return plain `void`, deliberately — not
 * `void | Promise<void>`. TypeScript's void-returning-function leniency lets a
 * callback that returns a value satisfy a `=> void` position, so
 * `onRegister: (ctx) => ctx.eventBus.emit(e)` type-checks. That leniency does
 * not survive a union: under `=> void | Promise<void>` the same expression is
 * rejected with TS2322 ("Type 'number' is not assignable to type
 * 'void | Promise<void>'"), so the union a plugin author reads as *more*
 * permissive is strictly *less* permissive. `void` still accepts `async`
 * callbacks — `Promise<void>` is assignable to a `void` return position — and
 * `PluginRegistry.register()` widens the returned value to `unknown` so it can
 * still await what the plugin actually returned.
 *
 * @example
 * ```ts
 * const sentryPlugin: DzupPlugin = {
 *   name: 'sentry',
 *   version: '1.0.0',
 *   eventHandlers: {
 *     'agent:failed': (e) => Sentry.captureException(e),
 *   },
 * }
 * ```
 */
export interface DzupPlugin {
  /** Unique plugin name */
  name: string
  /** Semver version */
  version: string

  /** Called when the plugin is registered. Async callbacks are awaited. */
  onRegister?(ctx: PluginContext): void

  /** Middleware to inject into agents */
  middleware?: AgentMiddleware[]

  /**
   * Lifecycle hooks to merge with agent hooks.
   *
   * The merge is performed by `PluginRegistry.toAgentHooks()`, whose result
   * goes on the agent config as `hooks`. Registering a plugin alone does NOT
   * dispatch these — nothing reads `getHooks()` implicitly.
   */
  hooks?: Partial<AgentHooks>

  /** Event handlers to subscribe to the event bus */
  eventHandlers?: Partial<Record<DzupEvent['type'], (event: DzupEvent) => void>>
}

export type PluginSource = 'local' | 'npm' | 'builtin' | 'unknown'

export interface PluginRegistrationOptions {
  source?: PluginSource
  path?: string
  overrideExisting?: boolean
}

export interface PluginRegistrationConflictDiagnostic {
  signal: 'plugin_registration_conflict_count'
  name: string
  source: PluginSource
  path: string
  previousSource: PluginSource
  previousPath: string
}

export interface PluginDisposeResult {
  disposed: boolean
  disposerCount: number
  telemetry: {
    signal: 'plugin_disposer_cleanup_count'
    pluginName: string
    disposerCount: number
  }
}
