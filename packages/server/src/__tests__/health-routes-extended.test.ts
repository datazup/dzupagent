import { describe, it, expect, vi, afterEach } from "vitest";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
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

describe("Health routes — extended", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/health returns version, uptime, and timestamp", async () => {
    const app = createForgeApp(createTestConfig());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["version"]).toBe("0.1.0");
    expect(typeof data["uptime"]).toBe("number");
    expect(typeof data["timestamp"]).toBe("string");
  });

  it("GET /api/health/ready returns 503 when runStore throws", async () => {
    const brokenRunStore = new InMemoryRunStore();
    vi.spyOn(brokenRunStore, "list").mockRejectedValue(new Error("DB down"));

    const app = createForgeApp(createTestConfig({ runStore: brokenRunStore }));
    const res = await app.request("/api/health/ready");
    expect(res.status).toBe(503);
    const data = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["runStore"]?.status).toBe("error");
  });

  it("GET /api/health/ready returns 503 when agentStore throws", async () => {
    const brokenAgentStore = new InMemoryAgentStore();
    vi.spyOn(brokenAgentStore, "list").mockRejectedValue(new Error("DB down"));

    const app = createForgeApp(
      createTestConfig({ agentStore: brokenAgentStore })
    );
    const res = await app.request("/api/health/ready");
    expect(res.status).toBe(503);
    const data = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(data.checks["agentStore"]?.status).toBe("error");
  });

  it("GET /api/health/ready includes runQueue stats when configured", async () => {
    const mockQueue = {
      enqueue: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      stats: () => ({
        pending: 3,
        active: 1,
        completed: 10,
        failed: 2,
        deadLetter: 0,
      }),
      getDeadLetter: () => [],
      clearDeadLetter: vi.fn(),
    };

    const app = createForgeApp(createTestConfig({ runQueue: mockQueue }));
    const res = await app.request("/api/health/ready");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      checks: Record<
        string,
        { status: string; metadata?: Record<string, unknown> }
      >;
    };
    expect(data.checks["runQueue"]?.status).toBe("ok");
    expect(data.checks["runQueue"]?.metadata?.["pending"]).toBe(3);
  });

  it("GET /api/health/ready includes shutdown state", async () => {
    const app = createForgeApp(
      createTestConfig({ shutdown: fakeShutdown("running") })
    );
    const res = await app.request("/api/health/ready");
    const data = (await res.json()) as {
      checks: Record<
        string,
        { status: string; metadata?: Record<string, unknown> }
      >;
    };
    expect(data.checks["shutdown"]?.status).toBe("ok");
    expect(data.checks["shutdown"]?.metadata?.["state"]).toBe("running");
  });

  it("GET /api/health/ready reports degraded when provider is degraded", async () => {
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
    expect(data.checks["modelRegistry"]?.status).toBe("degraded");
  });

  it("GET /api/health/metrics returns metrics JSON", async () => {
    const app = createForgeApp(createTestConfig());
    const res = await app.request("/api/health/metrics");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      metrics: unknown[];
      timestamp: string;
    };
    expect(Array.isArray(data.metrics)).toBe(true);
    expect(typeof data.timestamp).toBe("string");
  });
});
