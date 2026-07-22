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
import type {
  DurableNodeLedger,
  RunJournal,
} from "@dzupagent/core/persistence";
import type { MetricsCollector } from "@dzupagent/core/utils";
import type { CostLedgerClient } from "@dzupagent/agent/runtime";

import type { RunQueue } from "../queue/run-queue.js";
import type { GracefulShutdown } from "../lifecycle/graceful-shutdown.js";
import type { EventGateway } from "../events/event-gateway.js";
import type { RunExecutor, RunReflectorLike } from "../runtime/run-worker.js";
import type { RetrievalFeedbackHookConfig } from "../runtime/retrieval-feedback-hook.js";
import type { ConsolidationSchedulerConfig } from "../runtime/consolidation-scheduler.js";
import type { SleepConsolidatorLike } from "../runtime/sleep-consolidation-task.js";
import type { WorkerNodeStore } from "../runtime/worker-registry.js";
import type { DrizzleWorkerNodeDatabase } from "../persistence/drizzle-store-types.js";
import type { MetricsAccessControl } from "../routes/metrics.js";
import type { CostAttributor } from "../services/cost-attributor.js";

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
  /**
   * P2 durable node ledger. When present (with a `runQueue`), the server
   * starts the {@link NodeLedgerReclaimer}, which re-enqueues runs whose
   * nodes have a stale (expired) lease so a live worker resumes them.
   */
  nodeLedger?: DurableNodeLedger;
  /** Tuning for the P2 node-ledger reclaimer (see `nodeLedger`). */
  reclaimer?: {
    /** Sweep interval in ms. Defaults to the reclaimer's own default (15s). */
    intervalMs?: number;
    /** Max stale nodes processed per sweep. Defaults to 50. */
    batchSize?: number;
  };
  runExecutor?: RunExecutor;
  shutdown?: GracefulShutdown;
  metrics?: MetricsCollector;
  /**
   * S4-E: Per-tenant cost showback. When provided, `createForgeApp` mounts
   * `GET /admin/tenants/:tenantId/cost` and `GET /admin/tenants/cost`, which
   * aggregate `cost_cents` from `forge_runs` grouped by tenant. Use
   * {@link DrizzleCostAttributor} for the Postgres-backed implementation.
   */
  costAttributor?: CostAttributor;
  /**
   * P3 distributed guardrail backend. When provided, this Redis-backed
   * {@link CostLedgerClient} (e.g. from
   * {@link createRedisGuardrailClientFromConnection}) is attached to every
   * run's agent spec as the fleet-wide rate-limiter + cost-ledger client and
   * receives the final run cost at completion, so a fleet of worker processes
   * shares one rate-limit window and one spend ceiling. Absent means local-only
   * enforcement, unchanged.
   */
  guardrailClient?: CostLedgerClient;
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
  /**
   * P1 worker fleet registry config. When omitted (and no `db`), the run
   * worker runs in single-node mode with no fleet registration. When present
   * — or when a Drizzle `db` is configured — the worker registers a node,
   * heartbeats, reaps dead peers, and the `/metrics` endpoint exposes fleet
   * gauges fed from the resolved store.
   *
   * Store resolution: explicit `workerRegistry.store` → {@link
   * DrizzleWorkerNodeStore} when `db` is set → {@link InMemoryWorkerNodeStore}.
   */
  workerRegistry?: {
    /** Explicit fleet store. Defaults per `db` (Drizzle) then in-memory. */
    store?: WorkerNodeStore;
    /** Stable id for this worker process. Defaults to a random per-process id. */
    workerId?: string;
    /** Max concurrent runs this node advertises. Default: 5. */
    capacity?: number;
    /** `'shared'` or a tenant id. Default: `'shared'`. */
    tenantScope?: string;
    /** Heartbeat interval ms. Default: 5000. */
    heartbeatMs?: number;
    /** Reaper interval ms. Default: 30000. */
    reaperMs?: number;
    /** Dead-node ttl ms. Default: 30000. */
    ttlMs?: number;
    /** Free-form node metadata (version, host, region). */
    meta?: Record<string, unknown>;
  };
  /**
   * Optional Drizzle client. When provided and `workerRegistry.store` is
   * unset, a {@link DrizzleWorkerNodeStore} is wired as the default fleet
   * store so multiple worker processes share one queryable fleet.
   */
  db?: DrizzleWorkerNodeDatabase;
}
