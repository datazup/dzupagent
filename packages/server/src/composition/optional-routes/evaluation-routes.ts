/**
 * Evaluation-plane optional route families: benchmarks, evals, and the
 * playground. Each helper resolves any orchestrator/metrics fallbacks from
 * `runtimeConfig` before mounting.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { OptionalRoutesContext } from "./context.js";

import {
  createBenchmarkRoutes,
  type BenchmarkRouteConfig,
} from "../../routes/benchmarks.js";
import { createEvalRoutes, type EvalRouteConfig } from "../../routes/evals.js";
import { createPlaygroundRoutes } from "../../routes/playground.js";

export function mountBenchmarkRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (!runtimeConfig.benchmark) {
    return;
  }
  const benchmarkConfig: BenchmarkRouteConfig = { ...runtimeConfig.benchmark };
  if (runtimeConfig.benchmarkOrchestrator && !benchmarkConfig.orchestrator) {
    benchmarkConfig.orchestrator = runtimeConfig.benchmarkOrchestrator;
  }
  app.route("/api/benchmarks", createBenchmarkRoutes(benchmarkConfig));
}

export function mountEvalRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (!runtimeConfig.evals) {
    return;
  }
  const evalsConfig: EvalRouteConfig = {
    ...runtimeConfig.evals,
    metrics: runtimeConfig.evals.metrics ?? runtimeConfig.metrics,
  };
  if (runtimeConfig.evalOrchestrator && !evalsConfig.orchestrator) {
    evalsConfig.orchestrator = runtimeConfig.evalOrchestrator;
  }
  app.route("/api/evals", createEvalRoutes(evalsConfig));
}

export function mountPlaygroundRoute(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.playground) {
    app.route("/playground", createPlaygroundRoutes(runtimeConfig.playground));
  }
}
