/**
 * Branch coverage tests for health routes.
 *
 * Covers: all provider health transitions (ok, degraded, error, unconfigured),
 * shutdown state branches (draining, shutdown), provider health combinations,
 * metrics route with/without collector.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  MetricsCollector,
} from "@dzupagent/core";

function createTestConfig(
  overrides?: Partial<ForgeServerConfig>
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  };
}

/**
 * GracefulShutdown is a class with private internals, so a structural test
 * double cannot satisfy its nominal type. The single documented
 * `as unknown as` cast lives at this factory boundary; call sites stay
 * cast-free. The health route only consumes `getState()`.
 */
function fakeShutdown(
  state: "running" | "draining" | "stopped"
): NonNullable<ForgeServerConfig["shutdown"]> {
  const fake = {
    getState: () => state,
    isAcceptingRuns: () => state === "running",
    config: {},
  };
  return fake as unknown as NonNullable<ForgeServerConfig["shutdown"]>;
}

describe("health routes branch coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('modelRegistry status "error" when all providers are open', async () => {
    const registry = new ModelRegistry();
    vi.spyOn(registry, "getProviderHealth").mockReturnValue({
      openai: {
        state: "open",
        provider: "openai",
        weight: 0,
        successRate: 0,
        samples: 1,
      },
      anthropic: {
        state: "open",
        provider: "anthropic",
        weight: 0,
        successRate: 0,
        samples: 1,
      },
    });

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }));
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["modelRegistry"]?.status).toBe("error");
    expect(data.status).toBe("error");
    expect(res.status).toBe(503);
  });

  it('modelRegistry status "unconfigured" when no providers', async () => {
    const registry = new ModelRegistry();
    vi.spyOn(registry, "getProviderHealth").mockReturnValue({});

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }));
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      checks: Record<
        string,
        { status: string; metadata?: Record<string, unknown> }
      >;
    };
    expect(data.checks["modelRegistry"]?.status).toBe("unconfigured");
    expect(data.checks["modelRegistry"]?.metadata?.["total"]).toBe(0);
  });

  it('modelRegistry status "ok" when every provider is closed', async () => {
    const registry = new ModelRegistry();
    vi.spyOn(registry, "getProviderHealth").mockReturnValue({
      openai: {
        state: "closed",
        provider: "openai",
        weight: 1,
        successRate: 1,
        samples: 1,
      },
      anthropic: {
        state: "closed",
        provider: "anthropic",
        weight: 1,
        successRate: 1,
        samples: 1,
      },
    });

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }));
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["modelRegistry"]?.status).toBe("ok");
  });

  it('shutdown state "draining" produces degraded check', async () => {
    const app = createForgeApp(
      createTestConfig({
        shutdown: fakeShutdown("draining"),
      })
    );
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["shutdown"]?.status).toBe("degraded");
    expect(data.status).toBe("degraded");
    expect(res.status).toBe(503);
  });

  it('shutdown state "stopped" produces error check', async () => {
    const app = createForgeApp(
      createTestConfig({
        shutdown: fakeShutdown("stopped"),
      })
    );
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["shutdown"]?.status).toBe("error");
  });

  it("GET /api/health/metrics returns empty array when no collector", async () => {
    const app = createForgeApp(createTestConfig());
    const res = await app.request("/api/health/metrics");
    const data = (await res.json()) as { metrics: unknown[] };
    expect(data.metrics).toEqual([]);
  });

  it("GET /api/health/metrics includes provided metrics", async () => {
    const collector = new MetricsCollector();
    collector.increment("test_counter");

    const app = createForgeApp(createTestConfig({ metrics: collector }));
    const res = await app.request("/api/health/metrics");
    const data = (await res.json()) as { metrics: Array<{ name: string }> };
    expect(data.metrics.length).toBeGreaterThan(0);
    expect(data.metrics.some((m) => m.name === "test_counter")).toBe(true);
  });
});
