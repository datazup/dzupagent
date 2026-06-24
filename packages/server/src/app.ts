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
import { Hono } from "hono";

import { ComplianceAuditLogger } from "@dzupagent/core/security";
import type { AppEnv } from "./types.js";
import type {
  ForgeServerConfig,
  ForgeHostRuntimeConfig,
} from "./composition/types.js";
import {
  registerShutdownDrainHook,
  warnIfUnboundedInMemoryRetention,
} from "./composition/utils.js";
import { attachSafetyMonitor } from "./composition/safety.js";
import {
  buildRuntimeBootstrap,
  type RuntimeBootstrap,
} from "./composition/runtime-config.js";
import {
  applyMiddleware,
  assertExplicitFrameworkApiAuth,
} from "./composition/middleware.js";
import { mountCoreRoutes } from "./composition/core-routes.js";
import {
  mountOptionalRoutes,
  mountPrometheusMetricsRoute,
} from "./composition/optional-routes.js";
import { mountAllRoutePlugins } from "./composition/route-plugins.js";
import {
  maybeStartRunWorker,
  maybeStartNodeLedgerReclaimer,
  maybeStartScheduleTickWorker,
  mountConsolidationHealthRoute,
  startConsolidationScheduler,
  startClosedLoopSubscribers,
} from "./composition/workers.js";
import { registerEnvNotificationChannels } from "./composition/notifications.js";

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
} from "./composition/types.js";
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
} from "./composition/types.js";
export type { HttpConnectorProfile } from "./runtime/tool-resolver.js";

/**
 * Handle returned by {@link startForgeRuntime}. Owns the lifecycle of all
 * background work (run worker, reclaimers, schedulers, event-bus subscribers).
 *
 * `stop()` is idempotent: calling it more than once is safe and resolves
 * without error. Hosts that wire a {@link GracefulShutdown} handler get the same
 * drains registered automatically; `stop()` is the explicit lever for hosts
 * that manage lifecycle directly (e.g. tests, embedding the app in another
 * process).
 */
export interface RuntimeHandle {
  /** Idempotently tear down all background work started by `startForgeRuntime`. */
  stop(): Promise<void>;
}

// Associates the runtime bootstrap (defaulted executor/resolver/gateway) with
// the app `buildForgeApp` produced, so a following `startForgeRuntime(config,
// app)` reuses the SAME bootstrap instead of allocating a second event gateway
// (which would double-subscribe to the event bus) or a second run executor.
// Keyed on the app instance — not the config — so a fresh `buildForgeApp` call
// (even with a mutated, reused config object) always gets a fresh bootstrap.
const appBootstraps = new WeakMap<Hono<AppEnv>, RuntimeBootstrap>();

/**
 * ARCH-M-01/M-02 — pure app construction.
 *
 * Builds the configured Hono app (middleware + routes) WITHOUT starting any
 * background work: no run worker, no reclaimers, no schedulers, and no
 * event-bus subscribers (safety monitor, audit logger, closed-loop loops) are
 * started here. The returned app is fully routed and has zero side effects on
 * timers or the event bus.
 *
 * Call {@link startForgeRuntime} with the same `config` and the returned `app`
 * to start the background runtime. For a single call that does both (legacy
 * behaviour), use {@link createForgeApp}.
 */
export function buildForgeApp(config: ForgeHostRuntimeConfig): Hono<AppEnv> {
  assertExplicitFrameworkApiAuth(config);
  warnIfUnboundedInMemoryRetention(config);

  const app = new Hono<AppEnv>();

  // Resolve runtime defaults: executor, executable agent resolver, gateway.
  // Stashed on the app so a subsequent `startForgeRuntime(config, app)` reuses
  // the same singletons (one event gateway, one executor) rather than
  // re-bootstrapping.
  const bootstrap = buildRuntimeBootstrap(config);
  appBootstraps.set(app, bootstrap);
  const { runtimeConfig, eventGateway } = bootstrap;

  // Middleware: CORS, auth, RBAC, rate limit, shutdown guard, metrics, error.
  const { effectiveAuth } = applyMiddleware(app, runtimeConfig);

  // Always-mounted routes are generic framework primitives or compatibility
  // aliases. New product-control-plane routes should be owned by consuming apps
  // and mounted through `routePlugins` or app-level Hono composition.
  mountCoreRoutes(app, runtimeConfig);

  // Conditional routes are existing compatibility/maintenance surfaces or
  // generic framework primitives gated on injected capability config.
  mountOptionalRoutes(app, { runtimeConfig, effectiveAuth, eventGateway });

  // Built-in route plugin seams plus host-supplied plugins. This is the
  // forward-path extension point for app-owned product routes.
  mountAllRoutePlugins(app, runtimeConfig, eventGateway);

  // Prometheus `/metrics` endpoint (only when collector is Prometheus).
  mountPrometheusMetricsRoute(app, runtimeConfig);

  // Consolidation status route must be mounted during construction (Hono freezes
  // its router after the first request). The route reports live status once
  // `startForgeRuntime` starts the scheduler.
  mountConsolidationHealthRoute(app, runtimeConfig);

  return app;
}

/**
 * ARCH-M-01/M-02 — background runtime lifecycle.
 *
 * Starts every piece of background work for an app produced by
 * {@link buildForgeApp}: event-bus subscribers (safety monitor, compliance
 * audit logger, closed-loop self-improvement loops), the run-queue worker, the
 * node-ledger reclaimer, the schedule-tick worker, env-driven notification
 * channels, and the memory consolidation scheduler (which mounts its status
 * route onto the supplied app).
 *
 * Returns a {@link RuntimeHandle} whose `stop()` is idempotent — safe to call
 * multiple times. When a {@link GracefulShutdown} handler is configured the same
 * drains are also registered with it; `stop()` is the explicit alternative for
 * hosts that own the lifecycle directly.
 *
 * Each `maybeStart*` worker is internally guarded against double-start per
 * underlying queue/ledger/store instance, so invoking `startForgeRuntime` twice
 * with the same config does not start duplicate workers.
 */
export function startForgeRuntime(
  config: ForgeHostRuntimeConfig,
  app: Hono<AppEnv>
): RuntimeHandle {
  const disposers: Array<() => Promise<void> | void> = [];
  let stopped = false;

  // --- Runtime SafetyMonitor ---
  // Attach the built-in safety monitor to the shared event bus so that
  // tool errors and memory writes are scanned for prompt-injection and
  // other policy violations. Hosts can opt out via `disableSafetyMonitor`.
  attachSafetyMonitor(config);

  // --- Compliance Audit Logger (RF-36) ---
  // When an auditStore is provided, attach a ComplianceAuditLogger to the
  // event bus so security-relevant events are durably recorded.
  if (config.auditStore) {
    const auditLogger = new ComplianceAuditLogger({ store: config.auditStore });
    auditLogger.attach(config.eventBus);

    // Drain pending fire-and-forget audit writes before teardown so a
    // SIGTERM/SIGINT (or explicit stop) does not lose in-flight compliance
    // records. Sink errors surfaced by `flush()` are intentionally swallowed
    // here because the shutdown path itself is best-effort.
    const drainAuditLogger = async (): Promise<void> => {
      try {
        await auditLogger.flush();
      } catch (err) {
        // Best-effort: surface but do not block shutdown.
        // eslint-disable-next-line no-console
        console.warn(
          "[ForgeServer] audit logger flush surfaced error during shutdown",
          err
        );
      } finally {
        auditLogger.dispose();
      }
    };
    disposers.push(drainAuditLogger);

    if (config.shutdown) {
      registerShutdownDrainHook(config.shutdown, drainAuditLogger);
    }
  }

  // Reuse the bootstrap `buildForgeApp` produced for this app (so the worker
  // and the mounted routes share one runtimeConfig/executor/gateway). Fall back
  // to a fresh bootstrap only if this app was not produced by `buildForgeApp`
  // (e.g. an external caller passing a hand-built Hono instance).
  const { runtimeConfig, effectiveRunExecutor } =
    appBootstraps.get(app) ?? buildRuntimeBootstrap(config);

  // Start the queue worker (no-op when no `runQueue` is supplied or the
  // worker has already been started for this queue instance).
  maybeStartRunWorker(runtimeConfig, effectiveRunExecutor);
  // Start the P2 node-ledger reclaimer (no-op unless both a durable
  // node ledger and a run queue are configured).
  maybeStartNodeLedgerReclaimer(runtimeConfig);
  // Start the P4 HA schedule-tick worker (no-op unless both scheduleStore
  // and scheduleTickWorker config are present).
  maybeStartScheduleTickWorker(runtimeConfig);

  // --- Auto-register notification channels from env vars ---
  registerEnvNotificationChannels(runtimeConfig);

  // Background scheduler (memory consolidation). Mounts its status route onto
  // the supplied app when a shutdown handler is configured.
  startConsolidationScheduler(app, runtimeConfig);

  // Closed-loop self-improvement: prompt feedback loop + learning processor.
  startClosedLoopSubscribers(runtimeConfig);

  return {
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      // Drain in reverse registration order; swallow per-disposer errors so a
      // single failing drain cannot abort the rest of teardown.
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[ForgeServer] runtime stop disposer failed", err);
        }
      }
    },
  };
}

/**
 * Thin backwards-compatible wrapper: builds the app AND starts the background
 * runtime in one call (the historical behaviour). New code that needs to
 * construct the app without side effects, or to control the background runtime
 * lifecycle explicitly, should prefer {@link buildForgeApp} +
 * {@link startForgeRuntime}.
 *
 * {@link ForgeServerConfig} is retained as the parameter type for source
 * compatibility; it is structurally a superset-compatible alias of
 * {@link ForgeHostRuntimeConfig} for the purposes of this factory.
 */
export function createForgeApp(config: ForgeServerConfig): Hono<AppEnv> {
  const app = buildForgeApp(config);
  startForgeRuntime(config, app);
  return app;
}
