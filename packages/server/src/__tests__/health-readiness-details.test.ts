/**
 * DZUPAGENT-SEC-H-21 remainder (QF-26) — `/api/health/*` is auth-exempt so
 * probes need no credentials. By default the readiness and consolidation
 * bodies therefore reveal status only; `exposeReadinessDetails: true`
 * restores latencies, provider circuit state, queue counts, shutdown state,
 * uptime and consolidation counters. Status codes do not depend on the flag.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";
import { buildForgeApp, createForgeApp, startForgeRuntime, type ForgeServerConfig } from "../app.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.js";

function config(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  const registry = new ModelRegistry();
  vi.spyOn(registry, "getProviderHealth").mockReturnValue({
    anthropic: { state: "closed", provider: "anthropic" },
  } as unknown as ReturnType<ModelRegistry["getProviderHealth"]>);
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: registry,
    runQueue: {
      enqueue: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      stats: () => ({ pending: 3, active: 1, completed: 10, failed: 2 }),
    } as unknown as ForgeServerConfig["runQueue"],
    ...overrides,
  };
}

type ReadyBody = {
  status: string;
  uptime?: number;
  timestamp: string;
  checks: Record<string, Record<string, unknown>>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readiness details are opt-in", () => {
  it("by default returns per-check status only and keeps 200", async () => {
    const res = await createForgeApp(config()).request("/api/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadyBody;
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(body).not.toHaveProperty("uptime");
    for (const [name, check] of Object.entries(body.checks)) {
      expect(Object.keys(check), name).toEqual(["status"]);
    }
    expect(body.checks["runQueue"]).toEqual({ status: "ok" });
    expect(JSON.stringify(body)).not.toContain("anthropic");
  });

  it("by default still returns 503 when a store fails", async () => {
    const broken = new InMemoryRunStore();
    vi.spyOn(broken, "list").mockRejectedValue(new Error("DB down"));
    const res = await createForgeApp(config({ runStore: broken })).request("/api/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyBody;
    expect(body.checks["runStore"]).toEqual({ status: "error" });
  });

  it("exposeReadinessDetails restores the full body", async () => {
    const res = await createForgeApp(config({ exposeReadinessDetails: true })).request("/api/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadyBody;
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.checks["runStore"]?.["latencyMs"]).toBe("number");
    expect(body.checks["runQueue"]?.["metadata"]).toEqual({ pending: 3, active: 1, completed: 10, failed: 2 });
    expect(body.checks["modelRegistry"]?.["metadata"]).toMatchObject({ total: 1, healthy: 1 });
  });

  it.each([
    [undefined, ["running"]],
    [true, ["activeConsolidations", "lastRunAt", "running"]],
  ] as const)("consolidation status with exposeReadinessDetails=%s", async (flag, keys) => {
    const shutdown = new GracefulShutdown({
      drainTimeoutMs: 1_000,
      runStore: new InMemoryRunStore(),
      eventBus: createEventBus(),
    });
    const cfg: ForgeServerConfig = {
      ...config(),
      shutdown,
      ...(flag !== undefined ? { exposeReadinessDetails: flag } : {}),
      consolidation: {
        task: { run: async () => ({ recordsProcessed: 0, pruned: 0, merged: 0, durationMs: 0 }) },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
      },
    };
    const app = buildForgeApp(cfg);
    const handle = startForgeRuntime(cfg, app);
    try {
      const res = await app.request("/api/health/consolidation");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(Object.keys(body.data).sort()).toEqual([...keys]);
    } finally {
      await handle.stop();
    }
  });
});
