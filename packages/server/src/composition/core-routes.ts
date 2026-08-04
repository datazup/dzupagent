/**
 * Mounts the always-on REST surface: health, runs, agents, approvals,
 * human-contact, enrichment metrics, and (when configured) registry +
 * api-key routes. These are the routes that the legacy `app.ts` mounted
 * unconditionally before any optional integrations were considered.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";

import type { ForgeServerConfig } from "./types.js";
import type { AuthConfig } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  rbacMiddleware,
  DEFAULT_ADMIN_ONLY_PATHS,
} from "../middleware/rbac.js";
import { rateLimiterMiddleware } from "../middleware/rate-limiter.js";
import { createDefaultRbacConfig } from "./middleware/auth.js";
import { DEFAULT_RATE_LIMIT } from "./middleware/rate-limit.js";
import { createHealthRoutes } from "../routes/health.js";
import { createRoutingStatsRoutes } from "../routes/routing-stats.js";
import { createRunRoutes } from "../routes/runs.js";
import { createRunContextRoutes } from "../routes/run-context.js";
import { createAgentDefinitionRoutes } from "../routes/agents.js";
import { createApprovalRoutes } from "../routes/approval.js";
import { createApprovalsRoutes } from "../routes/approvals.js";
import { createHumanContactRoutes } from "../routes/human-contact.js";
import { createEnrichmentMetricsRoute } from "../routes/enrichment-metrics.js";
import { createRunTraceRoutes } from "../routes/run-trace.js";
import { createRegistryRoutes } from "../routes/registry.js";
import { createApiKeyRoutes } from "../routes/api-keys.js";
import { createCostAttributorRoutes } from "../routes/cost-attributor.routes.js";

/**
 * Path prefixes that are intentionally mounted OUTSIDE the `/api/*` middleware
 * chain applied by {@link applyMiddleware}. Every entry here must carry its own
 * explicit auth/authorization gating, and is asserted by the route-mount
 * conformance test (DZUPAGENT-SEC-C-01).
 */
export const CORE_NON_API_MOUNTS: readonly string[] = ["/admin/tenants"];

export function mountCoreRoutes(
  app: Hono<AppEnv>,
  runtimeConfig: ForgeServerConfig,
  effectiveAuth?: AuthConfig,
): void {
  app.route("/api/health", createHealthRoutes(runtimeConfig));
  app.route(
    "/api/runs",
    createRoutingStatsRoutes({ runStore: runtimeConfig.runStore }),
  );
  app.route("/api/runs", createRunRoutes(runtimeConfig));
  app.route("/api/runs", createRunContextRoutes(runtimeConfig));
  app.route(
    "/api/agent-definitions",
    createAgentDefinitionRoutes(runtimeConfig),
  );
  app.route("/api/agents", createAgentDefinitionRoutes(runtimeConfig));

  if (runtimeConfig.registry) {
    app.route(
      "/api/registry",
      createRegistryRoutes({ registry: runtimeConfig.registry }),
    );
  }

  if (runtimeConfig.apiKeyStore) {
    const allowedTiers = runtimeConfig.rateLimit?.tiers
      ? Object.keys(runtimeConfig.rateLimit.tiers)
      : undefined;
    app.route(
      "/api/keys",
      createApiKeyRoutes({ store: runtimeConfig.apiKeyStore, allowedTiers }),
    );
  }

  app.route("/api/runs", createApprovalRoutes(runtimeConfig));

  if (runtimeConfig.approvalStore) {
    app.route(
      "/api/approvals",
      createApprovalsRoutes({
        approvalStore: runtimeConfig.approvalStore,
        eventBus: runtimeConfig.eventBus,
        runStore: runtimeConfig.runStore,
      }),
    );
  }

  if (runtimeConfig.costAttributor) {
    // DZUPAGENT-SEC-C-01: `/admin/tenants/*` exposes per-tenant spend for the
    // whole deployment. It sits outside the `/api/*` prefix that
    // `applyMiddleware` binds auth, RBAC and rate limiting to, so before this
    // fix every route here was reachable anonymously and unthrottled.
    //
    // The mount path is part of the published surface (Stage 4-E showback
    // clients call `/admin/tenants/:tenantId/cost`), so rather than move it
    // under `/api/*` — a breaking change for existing consumers — we apply the
    // same middleware stack explicitly here. This mirrors the established
    // `/a2a` precedent in `optional-routes/messaging-routes.ts`.
    if (effectiveAuth) {
      app.use("/admin/tenants", authMiddleware(effectiveAuth));
      app.use("/admin/tenants/*", authMiddleware(effectiveAuth));
    }

    // Cross-tenant cost data is admin-only. `adminOnlyPaths` is passed
    // explicitly (rather than relying on DEFAULT_ADMIN_ONLY_PATHS, which only
    // lists `/api/*` prefixes) so a non-admin role receives 403 even when the
    // host supplies a custom rbac config.
    if (effectiveAuth && runtimeConfig.rbac !== false) {
      const baseRbac = createDefaultRbacConfig(runtimeConfig);
      const adminRbac = {
        ...baseRbac,
        adminOnlyPaths: [
          ...(baseRbac.adminOnlyPaths ?? DEFAULT_ADMIN_ONLY_PATHS),
          "/admin/tenants",
        ],
      };
      app.use("/admin/tenants", rbacMiddleware(adminRbac));
      app.use("/admin/tenants/*", rbacMiddleware(adminRbac));
    }

    // Match the `/api/*` throttling policy: explicit config wins, otherwise
    // fall back to the conservative default whenever auth is enabled.
    const effectiveRateLimit =
      runtimeConfig.rateLimit ??
      (runtimeConfig.auth ? DEFAULT_RATE_LIMIT : undefined);
    if (effectiveRateLimit) {
      app.use("/admin/tenants", rateLimiterMiddleware(effectiveRateLimit));
      app.use("/admin/tenants/*", rateLimiterMiddleware(effectiveRateLimit));
    }

    app.route(
      "/admin/tenants",
      createCostAttributorRoutes({
        costAttributor: runtimeConfig.costAttributor,
      }),
    );
  }

  app.route("/api/runs", createHumanContactRoutes(runtimeConfig));
  app.route(
    "/api/runs",
    createEnrichmentMetricsRoute({ runStore: runtimeConfig.runStore }),
  );

  if (runtimeConfig.traceStore) {
    app.route(
      "/api/runs",
      createRunTraceRoutes({
        runStore: runtimeConfig.runStore,
        traceStore: runtimeConfig.traceStore,
      }),
    );
  }
}
