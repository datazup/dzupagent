/**
 * Compatibility/observability optional route families: the OpenAI-compatible
 * `/v1/*` surface, the `/scale-target` autoscaling signal, and the Prometheus
 * `/metrics` endpoint. Each helper applies its own gating on `runtimeConfig`.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { OptionalRoutesContext } from "./context.js";

import type { ForgeServerConfig } from "../types.js";
import { rbacMiddleware } from "../../middleware/rbac.js";
import { openaiAuthMiddleware } from "../../routes/openai-compat/auth-middleware.js";
import { createOpenAICompatCompletionsRoute } from "../../routes/openai-compat/completions.js";
import { createModelsRoute } from "../../routes/openai-compat/models-route.js";
import { PrometheusMetricsCollector } from "../../metrics/prometheus-collector.js";
import { createMetricsRoute } from "../../routes/metrics.js";
import { createScaleTargetRoute } from "../../routes/scale-target.js";
import { resolveWorkerNodeStore } from "../workers.js";
import { createDefaultRbacConfig } from "../middleware.js";

export function mountOpenAICompatRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.openai?.enabled !== true) {
    return;
  }

  // Apply OpenAI auth middleware to all /v1/* routes (separate from /api/* auth).
  app.use("/v1/*", openaiAuthMiddleware(runtimeConfig.openai?.auth));
  if (
    runtimeConfig.rbac !== false &&
    runtimeConfig.openai?.auth?.enabled !== false
  ) {
    app.use("/v1/*", rbacMiddleware(createDefaultRbacConfig(runtimeConfig)));
  }

  app.route(
    "/v1/chat/completions",
    createOpenAICompatCompletionsRoute({
      agentStore: runtimeConfig.agentStore,
      modelRegistry: runtimeConfig.modelRegistry,
      eventBus: runtimeConfig.eventBus,
    })
  );

  app.route(
    "/v1/models",
    createModelsRoute({
      agentStore: runtimeConfig.agentStore,
    })
  );
}

/**
 * S4-F: mount the `GET /scale-target` autoscaling signal. Aggregate queue depth
 * vs. worker capacity — no auth guard since it exposes no sensitive data.
 */
export function mountScaleTargetRoute(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (!runtimeConfig.runQueue) {
    return;
  }

  const workerStore = resolveWorkerNodeStore(runtimeConfig);

  app.route(
    "/scale-target",
    createScaleTargetRoute({
      queue: runtimeConfig.runQueue,
      ...(workerStore ? { workerStore } : {}),
    })
  );
}

/**
 * Mount the Prometheus `/metrics` endpoint when the configured collector is a
 * {@link PrometheusMetricsCollector} and a framework-level access policy is
 * configured. Other collectors (e.g. NoopMetricsCollector) skip this route.
 */
export function mountPrometheusMetricsRoute(
  app: Hono<AppEnv>,
  runtimeConfig: ForgeServerConfig
): void {
  if (!(runtimeConfig.metrics instanceof PrometheusMetricsCollector)) {
    return;
  }

  const access = runtimeConfig.prometheusMetrics?.access;
  if (!access || access.mode === "disabled") {
    return;
  }

  // P1: feed fleet gauges from the same store the run worker registers into,
  // so `/metrics` reports total/active/idle/dead workers refreshed per scrape.
  const workerStore = resolveWorkerNodeStore(runtimeConfig);

  app.route(
    "/metrics",
    createMetricsRoute({
      collector: runtimeConfig.metrics,
      access,
      ...(workerStore ? { workerStore } : {}),
      // S4-F: refresh queue-depth gauges per scrape when a run queue is present.
      ...(runtimeConfig.runQueue ? { runQueue: runtimeConfig.runQueue } : {}),
    })
  );
}
