/**
 * Runtime middleware slice of the Hono app composition: the shutdown guard for
 * `POST /api/runs`, request metrics, and the global `onError` handler. Extracted
 * from the legacy `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06).
 * Behaviour is unchanged.
 */
import type { Hono } from "hono";
import { defaultLogger } from "@dzupagent/core/utils";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig } from "../types.js";

export function applyShutdownGuard(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (!config.shutdown) {
    return;
  }
  app.use("/api/runs", async (c, next) => {
    if (c.req.method === "POST" && !config.shutdown!.isAcceptingRuns()) {
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Server is shutting down",
          },
        },
        503
      );
    }
    return next();
  });
}

export function applyRequestMetrics(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (!config.metrics) {
    return;
  }
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const latency = Date.now() - start;
    config.metrics!.increment("http_requests_total", {
      method: c.req.method,
      path: c.req.path,
      status: String(c.res.status),
    });
    config.metrics!.observe("http_request_duration_ms", latency, {
      method: c.req.method,
      path: c.req.path,
    });
  });
}

export function applyErrorHandler(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);

    defaultLogger.error(
      `[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`
    );
    config.metrics?.increment("http_errors_total", { path: c.req.path });
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500
    );
  });
}
