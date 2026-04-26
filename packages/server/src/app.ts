/**
 * Hono app factory for DzupAgent server.
 *
 * Creates a configured Hono application with REST API routes, middleware,
 * and optional WebSocket support.
 *
 * @example
 * ```ts
 * import { createForgeApp } from '@dzupagent/server'
 *
 * const app = createForgeApp({
 *   eventBus: createEventBus(),
 *   modelRegistry: registry,
 *   runStore: new InMemoryRunStore(),
 *   agentStore: new InMemoryAgentStore(),
 * })
 *
 * export default { port: 4000, fetch: app.fetch }
 * ```
 *
 * Implementation notes:
 *
 * The composition is split across `src/composition/*` helpers so this file can
 * stay focused on orchestration. Each helper owns one concern (middleware,
 * core routes, optional routes, route plugins, workers, notifications,
 * safety monitor). The public surface is unchanged: `createForgeApp` is the
 * sole entry point and {@link ForgeServerConfig} remains the aggregate
 * config type.
 */
import { Hono } from 'hono'

import type { ForgeServerConfig } from './composition/types.js'
import {
  warnIfUnboundedInMemoryRetention,
} from './composition/utils.js'
import { attachSafetyMonitor } from './composition/safety.js'
import { buildRuntimeBootstrap } from './composition/runtime-config.js'
import { applyMiddleware } from './composition/middleware.js'
import { mountCoreRoutes } from './composition/core-routes.js'
import {
  mountOptionalRoutes,
  mountPrometheusMetricsRoute,
} from './composition/optional-routes.js'
import { mountAllRoutePlugins } from './composition/route-plugins.js'
import {
  maybeStartRunWorker,
  startConsolidationScheduler,
  startClosedLoopSubscribers,
} from './composition/workers.js'
import { registerEnvNotificationChannels } from './composition/notifications.js'

// Re-export the public composition types so legacy `import { ... } from
// '@dzupagent/server/app'` paths continue to resolve. The aggregate type
// `ForgeServerConfig` is the canonical surface; the focused sub-interfaces
// are exposed here for callers that prefer narrower types.
export type {
  ForgeServerConfig,
  ForgeCoreConfig,
  ForgeTransportConfig,
  ForgeRuntimeConfig,
  ForgeIntegrationsConfig,
  ForgeSecurityConfig,
  ConsolidationConfig,
  MailDeliveryConfig,
  PromptFeedbackLoopLike,
  LearningEventProcessorLike,
} from './composition/types.js'

export function createForgeApp(config: ForgeServerConfig): Hono {
  warnIfUnboundedInMemoryRetention(config)

  const app = new Hono()

  // --- Runtime SafetyMonitor ---
  // Attach the built-in safety monitor to the shared event bus so that
  // tool errors and memory writes are scanned for prompt-injection and
  // other policy violations. Hosts can opt out via `disableSafetyMonitor`.
  attachSafetyMonitor(config)

  // Resolve runtime defaults: executor, executable agent resolver, gateway.
  const { runtimeConfig, effectiveRunExecutor, eventGateway } = buildRuntimeBootstrap(config)

  // Start the queue worker (no-op when no `runQueue` is supplied or the
  // worker has already been started for this queue instance).
  maybeStartRunWorker(runtimeConfig, effectiveRunExecutor)

  // Middleware: CORS, auth, RBAC, rate limit, shutdown guard, metrics, error.
  const { effectiveAuth } = applyMiddleware(app, runtimeConfig)

  // Always-mounted routes (health, runs, agents, approvals, etc.).
  mountCoreRoutes(app, runtimeConfig)

  // Conditional routes gated on capability config (memory, deploy, evals,
  // A2A, triggers, schedules, prompts, personas, presets, marketplace,
  // reflections, mailbox+clusters, OpenAI compat, etc.).
  mountOptionalRoutes(app, { runtimeConfig, effectiveAuth, eventGateway })

  // --- Auto-register notification channels from env vars ---
  registerEnvNotificationChannels(runtimeConfig)

  // Built-in route plugins + host-supplied plugins.
  mountAllRoutePlugins(app, runtimeConfig, eventGateway)

  // Prometheus `/metrics` endpoint (only when collector is Prometheus).
  mountPrometheusMetricsRoute(app, runtimeConfig)

  // Background scheduler (memory consolidation).
  startConsolidationScheduler(app, runtimeConfig)

  // Closed-loop self-improvement: prompt feedback loop + learning processor.
  startClosedLoopSubscribers(runtimeConfig)

  return app
}
