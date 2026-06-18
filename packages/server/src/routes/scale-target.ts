/**
 * S4-F — autoscaling pressure signal.
 *
 * GET /scale-target returns an aggregate view of queue depth vs. worker
 * capacity so an external autoscaler (HPA, KEDA, a cron, etc.) can decide
 * whether to add workers. It is intentionally cheap, unauthenticated aggregate
 * stats — no per-run or tenant detail leaks.
 *
 * `pressure = pendingJobs / max(1, activeWorkers * targetUtilization * 10)`
 * is a simple backlog-to-capacity ratio: `10` is the assumed jobs-per-worker
 * headroom at `targetUtilization` saturation. `scaleUp` trips when pressure
 * exceeds 1.0 (backlog outstrips the target capacity).
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { QueueStats, RunQueue } from "../queue/run-queue.js";
import type { WorkerNodeStore } from "../runtime/worker-registry.js";

/** Default share of worker capacity the autoscaler targets (0–1). */
const DEFAULT_TARGET_UTILIZATION = 0.8;

export interface ScaleTargetRouteOptions {
  queue: RunQueue;
  workerStore?: WorkerNodeStore;
  /** Target worker utilization in [0, 1]. Defaults to 0.8. */
  targetUtilization?: number;
}

export interface ScaleTargetResponse {
  pendingJobs: number;
  activeJobs: number;
  activeWorkers: number;
  idleWorkers: number;
  pressure: number;
  scaleUp: boolean;
}

async function readQueueStats(queue: RunQueue): Promise<QueueStats> {
  const maybeAsync = queue as RunQueue & {
    statsAsync?: () => Promise<QueueStats>;
  };
  if (typeof maybeAsync.statsAsync === "function") {
    return maybeAsync.statsAsync();
  }
  return queue.stats();
}

export function createScaleTargetRoute(
  options: ScaleTargetRouteOptions
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const targetUtilization =
    options.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;

  app.get("/", async (c) => {
    const stats = await readQueueStats(options.queue);

    let activeWorkers = 0;
    let idleWorkers = 0;
    if (options.workerStore) {
      const nodes = await options.workerStore.list();
      for (const node of nodes) {
        if (node.status === "active") {
          activeWorkers += 1;
          if (node.inFlight === 0) idleWorkers += 1;
        }
      }
    }

    const capacity = Math.max(1, activeWorkers * targetUtilization * 10);
    const pressure = stats.pending / capacity;

    const response: ScaleTargetResponse = {
      pendingJobs: stats.pending,
      activeJobs: stats.active,
      activeWorkers,
      idleWorkers,
      pressure,
      scaleUp: pressure > 1.0,
    };

    return c.json(response, 200);
  });

  return app;
}
