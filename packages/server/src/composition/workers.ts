/**
 * Background lifecycle wiring: run-queue worker, consolidation scheduler, and
 * the closed-loop self-improvement subscribers (PromptFeedbackLoop +
 * LearningEventProcessor).
 *
 * `startRunWorker` is called at most once per `RunQueue` instance; subsequent
 * `createForgeApp` calls reusing the same queue (e.g. when test code wraps
 * the factory) are no-ops. The shared `WeakSet` is module-scoped and
 * deliberately does not leak through the public API.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";

import type { ForgeServerConfig } from "./types.js";
import { startRunWorker, type RunExecutor } from "../runtime/run-worker.js";
import { ConsolidationScheduler } from "../runtime/consolidation-scheduler.js";
import { createSleepConsolidationTask } from "../runtime/sleep-consolidation-task.js";
import type { RunQueue } from "../queue/run-queue.js";
import type { DurableNodeLedger } from "@dzupagent/core/persistence";
import { NodeLedgerReclaimer } from "../runtime/node-ledger-reclaimer.js";
import { buildRunReEnqueuer } from "../runtime/run-reenqueuer.js";
import { registerShutdownDrainHook } from "./utils.js";
import { ScheduleTickWorker } from "../schedules/schedule-tick-worker.js";
import type { ScheduleStore } from "../schedules/schedule-store.js";
import { randomUUID } from "node:crypto";
import {
  InMemoryWorkerNodeStore,
  type WorkerNodeStore,
} from "../runtime/worker-registry.js";
import { DrizzleWorkerNodeStore } from "../runtime/drizzle-worker-node-store.js";

const startedRunQueues = new WeakSet<RunQueue>();

/**
 * Resolve the worker fleet store for a config: an explicit
 * `workerRegistry.store`, else a {@link DrizzleWorkerNodeStore} when a Drizzle
 * `db` is configured, else an {@link InMemoryWorkerNodeStore}.
 *
 * Memoized per-config so the run worker and the `/metrics` fleet gauges observe
 * the same store instance. Returns `undefined` only when neither a
 * `workerRegistry` block nor a `db` is configured (single-node mode).
 */
const resolvedWorkerStores = new WeakMap<ForgeServerConfig, WorkerNodeStore>();
export function resolveWorkerNodeStore(
  runtimeConfig: ForgeServerConfig
): WorkerNodeStore | undefined {
  const cached = resolvedWorkerStores.get(runtimeConfig);
  if (cached) return cached;

  const explicit = runtimeConfig.workerRegistry?.store;
  if (explicit) {
    resolvedWorkerStores.set(runtimeConfig, explicit);
    return explicit;
  }

  // Only auto-provision a default when fleet observability was opted into via a
  // `workerRegistry` block or a Drizzle `db` is available to back it.
  if (
    runtimeConfig.workerRegistry === undefined &&
    runtimeConfig.db === undefined
  ) {
    return undefined;
  }

  const store: WorkerNodeStore = runtimeConfig.db
    ? new DrizzleWorkerNodeStore(runtimeConfig.db)
    : new InMemoryWorkerNodeStore();
  resolvedWorkerStores.set(runtimeConfig, store);
  return store;
}
const startedNodeLedgers = new WeakSet<DurableNodeLedger>();
const startedScheduleStores = new WeakSet<ScheduleStore>();

export function maybeStartRunWorker(
  runtimeConfig: ForgeServerConfig,
  effectiveRunExecutor: RunExecutor
): void {
  if (!runtimeConfig.runQueue || startedRunQueues.has(runtimeConfig.runQueue)) {
    return;
  }

  // P1: resolve the fleet store (explicit → Drizzle → in-memory). When present,
  // register this worker node into the shared fleet via `startRunWorker`'s
  // `workerRegistry` option. The `shutdown` hook deregisters on drain.
  const fleetStore = resolveWorkerNodeStore(runtimeConfig);
  const fleetCfg = runtimeConfig.workerRegistry;
  const workerRegistry =
    fleetStore !== undefined
      ? {
          store: fleetStore,
          workerId: fleetCfg?.workerId ?? `worker-${randomUUID()}`,
          ...(fleetCfg?.capacity !== undefined
            ? { capacity: fleetCfg.capacity }
            : {}),
          ...(fleetCfg?.tenantScope !== undefined
            ? { tenantScope: fleetCfg.tenantScope }
            : {}),
          ...(fleetCfg?.heartbeatMs !== undefined
            ? { heartbeatMs: fleetCfg.heartbeatMs }
            : {}),
          ...(fleetCfg?.reaperMs !== undefined
            ? { reaperMs: fleetCfg.reaperMs }
            : {}),
          ...(fleetCfg?.ttlMs !== undefined ? { ttlMs: fleetCfg.ttlMs } : {}),
          ...(fleetCfg?.meta !== undefined ? { meta: fleetCfg.meta } : {}),
          ...(runtimeConfig.shutdown
            ? {
                onStop: (stop: () => Promise<void>) =>
                  registerShutdownDrainHook(runtimeConfig.shutdown!, stop),
              }
            : {}),
        }
      : undefined;

  startRunWorker({
    runQueue: runtimeConfig.runQueue,
    runStore: runtimeConfig.runStore,
    agentStore: runtimeConfig.agentStore,
    executableAgentResolver: runtimeConfig.executableAgentResolver,
    eventBus: runtimeConfig.eventBus,
    modelRegistry: runtimeConfig.modelRegistry,
    runExecutor: effectiveRunExecutor,
    shutdown: runtimeConfig.shutdown,
    metrics: runtimeConfig.metrics,
    reflector: runtimeConfig.reflector,
    retrievalFeedback: runtimeConfig.retrievalFeedback,
    traceStore: runtimeConfig.traceStore,
    reflectionStore: runtimeConfig.reflectionStore,
    resourceQuota: runtimeConfig.resourceQuota,
    inputGuardConfig: runtimeConfig.security?.inputGuard,
    ...(workerRegistry ? { workerRegistry } : {}),
  });
  startedRunQueues.add(runtimeConfig.runQueue);
}

/**
 * Start the P2 node-ledger reclaimer when both a durable node ledger and a run
 * queue are configured. The reclaimer periodically scans the ledger for stale
 * (lease-expired) nodes and re-enqueues their owning runs via
 * {@link buildRunReEnqueuer} so a live worker resumes them. With no ledger or no
 * queue there is nothing to reclaim into, so this is a no-op.
 *
 * Mirrors {@link maybeStartRunWorker}: a `WeakSet` keyed on the ledger instance
 * guarantees the reclaimer is started at most once per ledger, even when
 * `createForgeApp` is called repeatedly with the same ledger (e.g. in tests).
 */
export function maybeStartNodeLedgerReclaimer(
  runtimeConfig: ForgeServerConfig
): void {
  const ledger = runtimeConfig.nodeLedger;
  const runQueue = runtimeConfig.runQueue;
  if (!ledger || !runQueue || startedNodeLedgers.has(ledger)) {
    return;
  }

  const reEnqueueRun = buildRunReEnqueuer({
    runStore: runtimeConfig.runStore,
    runQueue,
  });

  const reclaimer = new NodeLedgerReclaimer({
    ledger,
    reEnqueueRun,
    eventBus: runtimeConfig.eventBus,
    intervalMs: runtimeConfig.reclaimer?.intervalMs,
    batchSize: runtimeConfig.reclaimer?.batchSize,
    onError: (error) => {
      console.warn(
        "[ForgeServer] node-ledger reclaimer re-enqueue failed",
        error
      );
    },
  });
  reclaimer.start();
  startedNodeLedgers.add(ledger);

  if (runtimeConfig.shutdown) {
    registerShutdownDrainHook(runtimeConfig.shutdown, () => reclaimer.stop());
  }
}

/**
 * Start the P4 HA schedule-tick worker when both `scheduleStore` and
 * `scheduleTickWorker` are configured. The worker atomically claims due
 * schedule occurrences from the shared store and fires them via the injected
 * `onFire` callback, so two nodes sharing one store fire each occurrence
 * exactly once.
 *
 * Mirrors {@link maybeStartNodeLedgerReclaimer}: a `WeakSet` keyed on the
 * `scheduleStore` instance guarantees the worker is started at most once per
 * store, even when `createForgeApp` is called repeatedly with the same store
 * (e.g. in tests).
 */
export function maybeStartScheduleTickWorker(
  runtimeConfig: ForgeServerConfig
): void {
  const store = runtimeConfig.scheduleStore;
  const tickCfg = runtimeConfig.scheduleTickWorker;
  if (!store || !tickCfg || startedScheduleStores.has(store)) {
    return;
  }

  const worker = new ScheduleTickWorker({
    store,
    claimerId: tickCfg.claimerId,
    onFire: tickCfg.onFire,
    ...(tickCfg.intervalMs !== undefined
      ? { intervalMs: tickCfg.intervalMs }
      : {}),
    ...(tickCfg.limit !== undefined ? { limit: tickCfg.limit } : {}),
    ...(tickCfg.maxCatchUp !== undefined
      ? { maxCatchUp: tickCfg.maxCatchUp }
      : {}),
    emit: (event) => runtimeConfig.eventBus?.emit(event),
    onError: (claimed, error) => {
      console.warn(
        "[ForgeServer] schedule-tick-worker fire failed",
        claimed.id,
        error
      );
    },
  });
  worker.start();
  startedScheduleStores.add(store);

  if (runtimeConfig.shutdown) {
    registerShutdownDrainHook(runtimeConfig.shutdown, () => worker.stop());
  }
}

/**
 * Start the consolidation scheduler when configured. Mounts a status endpoint
 * at `GET /api/health/consolidation` if a graceful-shutdown handler is also
 * provided (matching legacy behaviour where the status route was only added
 * alongside shutdown wiring).
 */
export function startConsolidationScheduler(
  app: Hono<AppEnv>,
  runtimeConfig: ForgeServerConfig
): void {
  if (!runtimeConfig.consolidation) {
    return;
  }
  const consolidationCfg = runtimeConfig.consolidation;

  // Resolve the consolidation task: explicit `task` or auto-created from consolidator config
  const task =
    "task" in consolidationCfg
      ? consolidationCfg.task
      : createSleepConsolidationTask({
          consolidator: consolidationCfg.consolidator,
          store: consolidationCfg.store,
          namespaces: consolidationCfg.namespaces,
        });

  const scheduler = new ConsolidationScheduler({
    task,
    intervalMs: consolidationCfg.intervalMs,
    idleThresholdMs: consolidationCfg.idleThresholdMs,
    maxConcurrent: consolidationCfg.maxConcurrent,
    eventBus: runtimeConfig.eventBus,
    activeRunCount:
      consolidationCfg.activeRunCount ??
      (() => runtimeConfig.runQueue?.stats().active ?? 0),
  });
  scheduler.start();

  if (runtimeConfig.shutdown) {
    registerShutdownDrainHook(runtimeConfig.shutdown, () => scheduler.stop());

    // Expose scheduler status via health route
    app.get("/api/health/consolidation", (c) =>
      c.json({ data: scheduler.status() })
    );
  }
}

/**
 * Wire the closed-loop self-improvement subscribers. Both the
 * PromptFeedbackLoop (Step 2) and LearningEventProcessor (Step 3) subscribe
 * to `run:scored` events on the shared event bus. They operate independently
 * — one rewrites failing prompts, the other persists learned patterns — and
 * require no direct coupling beyond sharing the bus.
 */
export function startClosedLoopSubscribers(
  runtimeConfig: ForgeServerConfig
): void {
  if (runtimeConfig.promptFeedbackLoop) {
    const loop = runtimeConfig.promptFeedbackLoop;
    loop.start();
    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, async () => {
        loop.stop();
      });
    }
  }

  if (runtimeConfig.learningEventProcessor) {
    const processor = runtimeConfig.learningEventProcessor;
    processor.start();
    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, async () => {
        processor.stop();
      });
    }
  }
}
