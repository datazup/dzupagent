/**
 * Background runtime slice of {@link ForgeServerConfig}: queues, executors,
 * journals, metrics exposure, the event gateway, the cost-aware router, the
 * reflector, retrieval feedback, and consolidation scheduling.
 *
 * Split out of `composition/types.ts` so composition helpers can ask for the
 * narrow runtime slice without importing the full aggregate. Re-exported from
 * `composition/types.ts` to preserve every existing import path.
 */
import type { CostAwareRouter } from "@dzupagent/core/llm";
import type { RunJournal } from "@dzupagent/core/persistence";
import type { MetricsCollector } from "@dzupagent/core/utils";

import type { RunQueue } from "../queue/run-queue.js";
import type { GracefulShutdown } from "../lifecycle/graceful-shutdown.js";
import type { EventGateway } from "../events/event-gateway.js";
import type { RunExecutor, RunReflectorLike } from "../runtime/run-worker.js";
import type { RetrievalFeedbackHookConfig } from "../runtime/retrieval-feedback-hook.js";
import type { ConsolidationSchedulerConfig } from "../runtime/consolidation-scheduler.js";
import type { SleepConsolidatorLike } from "../runtime/sleep-consolidation-task.js";
import type { MetricsAccessControl } from "../routes/metrics.js";

/**
 * Shared scheduling options for consolidation (everything except the task itself
 * and eventBus, which is injected by createForgeApp).
 */
type ConsolidationSchedulingOpts = Omit<
  ConsolidationSchedulerConfig,
  "eventBus" | "task"
>;

/**
 * Consolidation config — supports two modes:
 * 1. Provide an explicit `task` (ConsolidationTask).
 * 2. Provide `consolidator` + `store` + `namespaces` to auto-create the task.
 */
export type ConsolidationConfig =
  | (ConsolidationSchedulingOpts & {
      task: ConsolidationSchedulerConfig["task"];
    })
  | (ConsolidationSchedulingOpts & {
      /** A SleepConsolidator instance (from @dzupagent/memory) */
      consolidator: SleepConsolidatorLike;
      /** A BaseStore instance passed to the consolidator */
      store: unknown;
      /** Namespaces to consolidate */
      namespaces: string[][];
    });

/**
 * Background runtime: queues, executors, journals, scheduler, lifecycle hooks.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeRuntimeConfig {
  runQueue?: RunQueue;
  runExecutor?: RunExecutor;
  shutdown?: GracefulShutdown;
  metrics?: MetricsCollector;
  /**
   * Prometheus `/metrics` endpoint exposure policy. The endpoint is not mounted
   * unless this is configured, so public scraping requires an explicit
   * `unsafe-public` opt-in.
   */
  prometheusMetrics?: {
    access: MetricsAccessControl;
  };
  eventGateway?: EventGateway;
  consolidation?: ConsolidationConfig;
  router?: CostAwareRouter;
  reflector?: RunReflectorLike;
  retrievalFeedback?: RetrievalFeedbackHookConfig;
  journal?: RunJournal;
}
