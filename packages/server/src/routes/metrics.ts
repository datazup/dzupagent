/**
 * Prometheus /metrics route.
 *
 * Serves metrics in Prometheus text exposition format (text/plain; version=0.0.4).
 * Only mounted when the configured MetricsCollector has a `render()` method
 * (i.e., is a PrometheusMetricsCollector).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import type { PrometheusMetricsCollector } from "../metrics/prometheus-collector.js";
import type { WorkerNodeStore } from "../runtime/worker-registry.js";
import type { RunQueue } from "../queue/run-queue.js";
import {
  registerFleetGauges,
  updateFleetGauges,
} from "../metrics/fleet-gauge.js";
import {
  registerQueueGauges,
  updateQueueGauges,
} from "../metrics/queue-gauge.js";

export type MetricsAccessControl =
  | {
      /**
       * Require a bearer token in the `Authorization` header, or an exact token
       * match in `headerName` when a custom header is configured.
       */
      mode: "token";
      token: string;
      headerName?: string;
    }
  | {
      /** Delegate framework-level access control to host-supplied middleware. */
      mode: "middleware";
      middleware: MiddlewareHandler;
    }
  | {
      /**
       * Explicit unsafe/development opt-in for public Prometheus scraping.
       * Production hosts should prefer `token` or `middleware`.
       */
      mode: "unsafe-public";
      reason?: string;
    }
  | {
      /** Do not mount `/metrics`, even when the collector supports rendering. */
      mode: "disabled";
    };

export interface MetricsRouteConfig {
  collector: PrometheusMetricsCollector;
  access: MetricsAccessControl;
  /**
   * P1: optional worker fleet store. When provided, the four fleet gauges
   * (`forge_fleet_workers_total/active/idle/dead`) are refreshed from a fresh
   * `store.list()` snapshot on every scrape, just before `render()`.
   */
  workerStore?: WorkerNodeStore;
  /**
   * S4-F: optional run queue. When provided, the three queue-depth gauges
   * (`forge_queue_jobs_pending/active/dead_letter`) are refreshed from a fresh
   * queue snapshot on every scrape, just before `render()`.
   */
  runQueue?: RunQueue;
}

/**
 * Create a Hono sub-app that serves the Prometheus metrics endpoint.
 *
 * GET / — renders all tracked metrics in Prometheus text exposition format.
 */
export function createMetricsRoute(config: MetricsRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  if (config.access.mode === "disabled") {
    return app;
  }

  // Register the fleet gauges up-front so they render with help/type metadata
  // (and report zero on an empty fleet) even before the first scrape.
  if (config.workerStore) {
    registerFleetGauges(config.collector);
  }
  if (config.runQueue) {
    registerQueueGauges(config.collector);
  }

  const guard = createMetricsAccessGuard(config.access);
  if (guard) {
    app.use("*", guard);
  }

  app.get("/", async (c) => {
    // Pull a fresh fleet snapshot so gauge values are current at scrape time.
    if (config.workerStore) {
      await updateFleetGauges(config.workerStore, config.collector);
    }
    if (config.runQueue) {
      await updateQueueGauges(config.runQueue, config.collector);
    }
    const body = config.collector.render();
    return c.text(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  return app;
}

function createMetricsAccessGuard(
  access: MetricsAccessControl
): MiddlewareHandler | undefined {
  if (access.mode === "unsafe-public" || access.mode === "disabled") {
    return undefined;
  }

  if (access.mode === "middleware") {
    return access.middleware;
  }

  if (access.token.length === 0) {
    throw new Error("Prometheus metrics token must not be empty");
  }

  return async (c, next) => {
    const supplied = readMetricsToken(c.req.raw.headers, access);
    if (!constantTimeEquals(supplied, access.token)) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Metrics credentials are missing or invalid",
          },
        },
        401
      );
    }

    await next();
  };
}

function readMetricsToken(
  headers: Headers,
  access: Extract<MetricsAccessControl, { mode: "token" }>
): string | null {
  if (access.headerName) {
    return headers.get(access.headerName);
  }

  const authorization = headers.get("authorization");
  const bearerPrefix = "Bearer ";
  if (!authorization?.startsWith(bearerPrefix)) {
    return null;
  }

  return authorization.slice(bearerPrefix.length);
}

function constantTimeEquals(actual: string | null, expected: string): boolean {
  const actualValue = actual ?? "";
  let mismatch = actualValue.length ^ expected.length;
  const length = Math.max(actualValue.length, expected.length);

  for (let index = 0; index < length; index += 1) {
    mismatch |=
      (actualValue.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}
