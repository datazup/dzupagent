/**
 * Unit tests for createHealthRoutes.
 *
 * The existing health-routes-extended.test.ts already covers several branches
 * (503 on store failure, runQueue stats, shutdown state, degraded model provider).
 * This file focuses on the liveness endpoint correctness, readiness JSON shape,
 * and the metrics endpoint — complementing rather than duplicating existing coverage.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  MetricsCollector,
  createEventBus,
} from "@dzupagent/core";
import { Hono } from "hono";
import { secureLogger } from "@dzupagent/core/utils";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import { createHealthRoutes } from "../routes/health.js";

function makeConfig(
  overrides: Partial<ForgeServerConfig> = {}
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  };
}

describe("Health routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- GET /api/health (liveness) ---

  describe("GET /api/health", () => {
    it("always returns 200 regardless of store state", async () => {
      const brokenStore = new InMemoryRunStore();
      vi.spyOn(brokenStore, "list").mockRejectedValue(new Error("DB down"));
      const app = createForgeApp(makeConfig({ runStore: brokenStore }));

      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
    });

    it("response body contains status=ok", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health")).json()) as Record<
        string,
        unknown
      >;
      expect(body["status"]).toBe("ok");
    });

    it("response body contains a numeric uptime", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health")).json()) as Record<
        string,
        unknown
      >;
      expect(typeof body["uptime"]).toBe("number");
      expect(body["uptime"] as number).toBeGreaterThanOrEqual(0);
    });

    it("response body contains an ISO timestamp string", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health")).json()) as Record<
        string,
        unknown
      >;
      expect(typeof body["timestamp"]).toBe("string");
      // Sanity: parseable as Date
      expect(() => new Date(body["timestamp"] as string)).not.toThrow();
    });

    it("returns version 0.1.0", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health")).json()) as Record<
        string,
        unknown
      >;
      expect(body["version"]).toBe("0.1.0");
    });
  });

  // --- GET /api/health/ready (readiness) ---

  describe("GET /api/health/ready", () => {
    it("returns 200 when all stores are healthy", async () => {
      const app = createForgeApp(makeConfig());
      const res = await app.request("/api/health/ready");
      expect(res.status).toBe(200);
    });

    it("response body includes checks.runStore and checks.agentStore", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health/ready")).json()) as {
        checks: Record<string, { status: string }>;
      };
      expect(body.checks["runStore"]).toBeDefined();
      expect(body.checks["agentStore"]).toBeDefined();
    });

    it("runStore check has status=ok when list() succeeds", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health/ready")).json()) as {
        checks: Record<string, { status: string }>;
      };
      expect(body.checks["runStore"]?.status).toBe("ok");
    });

    it("returns 503 when runStore.list throws", async () => {
      const broken = new InMemoryRunStore();
      vi.spyOn(broken, "list").mockRejectedValue(new Error("down"));
      const app = createForgeApp(makeConfig({ runStore: broken }));
      const res = await app.request("/api/health/ready");
      expect(res.status).toBe(503);
    });

    it("returns 503 when agentStore.list throws", async () => {
      const broken = new InMemoryAgentStore();
      vi.spyOn(broken, "list").mockRejectedValue(new Error("down"));
      const app = createForgeApp(makeConfig({ agentStore: broken }));
      const res = await app.request("/api/health/ready");
      expect(res.status).toBe(503);
    });

    it("response body contains a top-level status field", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health/ready")).json()) as {
        status: string;
      };
      expect(["ok", "degraded", "error"]).toContain(body.status);
    });

    it("response body contains numeric uptime", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health/ready")).json()) as {
        uptime: number;
      };
      expect(typeof body.uptime).toBe("number");
    });

    it("modelRegistry check is unconfigured when no providers are registered", async () => {
      const app = createForgeApp(makeConfig());
      const body = (await (await app.request("/api/health/ready")).json()) as {
        checks: Record<string, { status: string }>;
      };
      expect(body.checks["modelRegistry"]?.status).toBe("unconfigured");
    });

    it("modelRegistry check is error when all providers are open (circuit broken)", async () => {
      const registry = new ModelRegistry();
      vi.spyOn(registry, "getProviderHealth").mockReturnValue({
        openai: {
          state: "open",
          provider: "openai",
          weight: 0,
          successRate: 0,
          samples: 1,
        },
      });

      const app = createForgeApp(makeConfig({ modelRegistry: registry }));
      const body = (await (await app.request("/api/health/ready")).json()) as {
        checks: Record<string, { status: string }>;
      };
      expect(body.checks["modelRegistry"]?.status).toBe("error");
    });
  });

  // --- GET /api/health/metrics (DZUPAGENT-SEC-H-21) ---

  describe("GET /api/health/metrics", () => {
    const publicAccess = {
      prometheusMetrics: { access: { mode: "unsafe-public" as const } },
    };

    it("is not mounted (404) when no prometheusMetrics access is configured", async () => {
      const app = createForgeApp(makeConfig());
      const res = await app.request("/api/health/metrics");
      expect(res.status).toBe(404);
      expect((await app.request("/api/health")).status).toBe(200);
    });

    it("is not mounted (404) when access is disabled", async () => {
      const app = createForgeApp(
        makeConfig({ prometheusMetrics: { access: { mode: "disabled" } } }),
      );
      expect((await app.request("/api/health/metrics")).status).toBe(404);
      expect((await app.request("/api/health")).status).toBe(200);
    });

    it("returns 401 without the token when access is token, 200 with it", async () => {
      const app = createForgeApp(
        makeConfig({
          prometheusMetrics: { access: { mode: "token", token: "scrape-secret" } },
        }),
      );
      expect((await app.request("/api/health/metrics")).status).toBe(401);
      const ok = await app.request("/api/health/metrics", {
        headers: { Authorization: "Bearer scrape-secret" },
      });
      expect(ok.status).toBe(200);
      expect((await app.request("/api/health")).status).toBe(200);
    });

    it("applies host middleware when access is middleware", async () => {
      const app = createForgeApp(
        makeConfig({
          prometheusMetrics: {
            access: {
              mode: "middleware",
              middleware: async (c) => c.json({ error: "denied" }, 401),
            },
          },
        }),
      );
      expect((await app.request("/api/health/metrics")).status).toBe(401);
    });

    it("returns 200 with a metrics array when access is unsafe-public", async () => {
      const app = createForgeApp(makeConfig(publicAccess));
      const res = await app.request("/api/health/metrics");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { metrics: unknown[]; timestamp: string };
      expect(Array.isArray(body.metrics)).toBe(true);
      expect(typeof body.timestamp).toBe("string");
    });

    it("uses custom metrics collector when provided", async () => {
      const realMetrics = new MetricsCollector();
      realMetrics.increment("custom");
      const app = createForgeApp(makeConfig({ metrics: realMetrics, ...publicAccess }));
      const body = (await (
        await app.request("/api/health/metrics")
      ).json()) as {
        metrics: Array<{ name: string; value: number }>;
      };
      expect(body.metrics.length).toBeGreaterThanOrEqual(1);
      expect(body.metrics.some((m) => m.name === "custom")).toBe(true);
    });
  });

  // --- Readiness failure diagnostics (DZUPAGENT-ERR-H-73) ---

  describe("GET /api/health/ready — check diagnostics", () => {
    it("logs one structured entry naming runStore and the error class, not the message", async () => {
      const broken = new InMemoryRunStore();
      vi.spyOn(broken, "list").mockRejectedValue(new TypeError("postgres://u:p@db/x refused"));
      const logged: unknown[] = [];
      vi.spyOn(secureLogger, "error").mockImplementation((entry: unknown) => {
        logged.push(entry);
      });

      const app = createForgeApp(makeConfig({ runStore: broken }));
      const res = await app.request("/api/health/ready");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: Record<string, { status: string; latencyMs?: number }> };
      expect(body.checks["runStore"]?.status).toBe("error");
      expect(typeof body.checks["runStore"]?.latencyMs).toBe("number");

      const entries = logged.filter(
        (e) => (e as { operation?: string }).operation === "health.ready.check_failed",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ subsystem: "runStore", errorClass: "TypeError" });
      expect(JSON.stringify(entries)).not.toContain("postgres://");
    });

    it("reports status 'timeout' within the bound for a hanging store", async () => {
      const hanging = new InMemoryAgentStore();
      vi.spyOn(hanging, "list").mockReturnValue(new Promise(() => undefined));
      vi.spyOn(secureLogger, "warn").mockImplementation(() => undefined);

      const app = new Hono();
      app.route(
        "/api/health",
        createHealthRoutes(makeConfig({ agentStore: hanging }), { readinessCheckTimeoutMs: 50 }),
      );
      const started = Date.now();
      const res = await app.request("/api/health/ready");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: Record<string, { status: string }> };
      expect(body.checks["agentStore"]?.status).toBe("timeout");
      expect(body.checks["runStore"]?.status).toBe("ok");
    });
  });
});
