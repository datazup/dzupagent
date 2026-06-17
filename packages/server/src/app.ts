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
 *   auth: { mode: 'none' }, // local development or legacy compatibility only
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

import { ComplianceAuditLogger } from '@dzupagent/core/security'
import type { AppEnv } from './types.js'
import type { ForgeServerConfig } from './composition/types.js'
import {
  registerShutdownDrainHook,
  warnIfUnboundedInMemoryRetention,
} from './composition/utils.js'
import { attachSafetyMonitor } from './composition/safety.js'
import { buildRuntimeBootstrap } from './composition/runtime-config.js'
import { applyMiddleware, assertExplicitFrameworkApiAuth } from './composition/middleware.js'
import { mountCoreRoutes } from './composition/core-routes.js'
import {
  mountOptionalRoutes,
  mountPrometheusMetricsRoute,
} from './composition/optional-routes.js'
import { mountAllRoutePlugins } from './composition/route-plugins.js'
import {
  maybeStartRunWorker,
  maybeStartNodeLedgerReclaimer,
  startConsolidationScheduler,
  startClosedLoopSubscribers,
} from './composition/workers.js'
import { registerEnvNotificationChannels } from './composition/notifications.js'

// Re-export the public composition types so legacy `import { ... } from
// '@dzupagent/server/app'` paths continue to resolve. The aggregate type
// `ForgeServerConfig` is the canonical surface; the route-family
// sub-interfaces are exposed here (and at the package root) for callers that
// prefer narrower types.
//
// The package-root public surface is `@dzupagent/server` (see `index.ts`).
// The seven `Forge{Core,Transport,Runtime,Integrations,Security}Config` and
// `{PromptFeedbackLoop,LearningEventProcessor}Like` re-exports below are
// `@deprecated` legacy compatibility aliases for the `@dzupagent/server/app`
// loose import path; they have zero workspace consumers and are not promoted
// to the package root.
export type {
  ForgeServerConfig,
  ForgeHostRuntimeConfig,
  ForgeRouteFamiliesConfig,
  ForgeMemoryRouteFamilyConfig,
  ForgeCompatibilityRouteFamilyConfig,
  ForgeEvaluationRouteFamilyConfig,
  ForgeAdapterRouteFamilyConfig,
  ForgeAutomationRouteFamilyConfig,
  ForgeControlPlaneRouteFamilyConfig,
  ConsolidationConfig,
  MailDeliveryConfig,
} from './composition/types.js'
// Legacy `@dzupagent/server/app` compatibility aliases — see notice above.
// These are internal composition building blocks; prefer `ForgeServerConfig`
// or `ForgeHostRuntimeConfig` for new code.
export type {
  /** @deprecated Use `ForgeServerConfig`. Internal composition building block re-exported only for the `@dzupagent/server/app` legacy path. */
  ForgeCoreConfig,
  /** @deprecated Use `ForgeServerConfig`. Internal composition building block re-exported only for the `@dzupagent/server/app` legacy path. */
  ForgeTransportConfig,
  /** @deprecated Use `ForgeServerConfig`. Internal composition building block re-exported only for the `@dzupagent/server/app` legacy path. */
  ForgeRuntimeConfig,
  /** @deprecated Use `ForgeServerConfig` or `ForgeRouteFamiliesConfig`. Internal composition building block re-exported only for the `@dzupagent/server/app` legacy path. */
  ForgeIntegrationsConfig,
  /** @deprecated Use `ForgeServerConfig` or `ForgeHostRuntimeConfig`. Internal composition building block re-exported only for the `@dzupagent/server/app` legacy path. */
  ForgeSecurityConfig,
  /** @deprecated Inline the `{ start(): void; stop(): void }` shape, or import `PromptFeedbackLoop` directly. Re-exported only for the `@dzupagent/server/app` legacy path. */
  PromptFeedbackLoopLike,
  /** @deprecated Inline the `{ start(): void; stop(): void }` shape, or import `LearningEventProcessor` directly. Re-exported only for the `@dzupagent/server/app` legacy path. */
  LearningEventProcessorLike,
} from './composition/types.js'
export type { HttpConnectorProfile } from './runtime/tool-resolver.js'

export function createForgeApp(config: ForgeServerConfig): Hono<AppEnv> {
  assertExplicitFrameworkApiAuth(config)
  warnIfUnboundedInMemoryRetention(config)

  const app = new Hono<AppEnv>()

  // --- Runtime SafetyMonitor ---
  // Attach the built-in safety monitor to the shared event bus so that
  // tool errors and memory writes are scanned for prompt-injection and
  // other policy violations. Hosts can opt out via `disableSafetyMonitor`.
  attachSafetyMonitor(config)

  // --- Compliance Audit Logger (RF-36) ---
  // When an auditStore is provided, attach a ComplianceAuditLogger to the
  // event bus so security-relevant events are durably recorded.
  if (config.auditStore) {
    const auditLogger = new ComplianceAuditLogger({ store: config.auditStore })
    auditLogger.attach(config.eventBus)

    // Drain pending fire-and-forget audit writes before process exit so
    // SIGTERM/SIGINT do not lose in-flight compliance records. Sink errors
    // surfaced by `flush()` are intentionally swallowed here because the
    // shutdown path itself is best-effort — but the logger's `onError` (if
    // configured) and console fallback below ensure visibility.
    if (config.shutdown) {
      registerShutdownDrainHook(config.shutdown, async () => {
        try {
          await auditLogger.flush()
        } catch (err) {
          // Best-effort: surface but do not block shutdown.
          // eslint-disable-next-line no-console
          console.warn('[ForgeServer] audit logger flush surfaced error during shutdown', err)
        } finally {
          auditLogger.dispose()
        }
      })
    }
  }

  // Resolve runtime defaults: executor, executable agent resolver, gateway.
  const { runtimeConfig, effectiveRunExecutor, eventGateway } = buildRuntimeBootstrap(config)

  // Start the queue worker (no-op when no `runQueue` is supplied or the
  // worker has already been started for this queue instance).
  maybeStartRunWorker(runtimeConfig, effectiveRunExecutor)
  // Start the P2 node-ledger reclaimer (no-op unless both a durable
  // node ledger and a run queue are configured).
  maybeStartNodeLedgerReclaimer(runtimeConfig)

  // Middleware: CORS, auth, RBAC, rate limit, shutdown guard, metrics, error.
  const { effectiveAuth } = applyMiddleware(app, runtimeConfig)

  // Always-mounted routes are generic framework primitives or compatibility
  // aliases. New product-control-plane routes should be owned by consuming apps
  // and mounted through `routePlugins` or app-level Hono composition.
  mountCoreRoutes(app, runtimeConfig)

  // Conditional routes are existing compatibility/maintenance surfaces or
  // generic framework primitives gated on injected capability config.
  mountOptionalRoutes(app, { runtimeConfig, effectiveAuth, eventGateway })

  // --- Auto-register notification channels from env vars ---
  registerEnvNotificationChannels(runtimeConfig)

  // Built-in route plugin seams plus host-supplied plugins. This is the
  // forward-path extension point for app-owned product routes.
  mountAllRoutePlugins(app, runtimeConfig, eventGateway)

  // Prometheus `/metrics` endpoint (only when collector is Prometheus).
  mountPrometheusMetricsRoute(app, runtimeConfig)

  // Background scheduler (memory consolidation).
  startConsolidationScheduler(app, runtimeConfig)

  // Closed-loop self-improvement: prompt feedback loop + learning processor.
  startClosedLoopSubscribers(runtimeConfig)

  return app
}
