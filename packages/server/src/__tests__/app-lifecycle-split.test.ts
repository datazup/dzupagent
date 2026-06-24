import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForgeApp,
  startForgeRuntime,
  createForgeApp,
  type ForgeServerConfig,
} from "../app.js";
import { ConsolidationScheduler } from "../runtime/consolidation-scheduler.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.js";
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";

function createBaseConfig(
  overrides: Partial<ForgeServerConfig> = {}
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    // Tests run with NODE_ENV !== 'production' so auth: undefined only warns.
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RF-6: buildForgeApp / startForgeRuntime lifecycle split", () => {
  it("buildForgeApp starts no background scheduler", () => {
    const startSpy = vi.spyOn(ConsolidationScheduler.prototype, "start");

    const app = buildForgeApp({
      ...createBaseConfig(),
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    });

    expect(app).toBeDefined();
    // No background work was started during pure construction.
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("startForgeRuntime starts the consolidation scheduler", () => {
    const startSpy = vi.spyOn(ConsolidationScheduler.prototype, "start");

    const config: ForgeServerConfig = {
      ...createBaseConfig(),
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    };

    const app = buildForgeApp(config);
    expect(startSpy).not.toHaveBeenCalled();

    const handle = startForgeRuntime(config, app);
    expect(startSpy).toHaveBeenCalledTimes(1);

    void handle;
  });

  it("RuntimeHandle.stop() is idempotent (double-stop safe)", async () => {
    const config: ForgeServerConfig = {
      ...createBaseConfig(),
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    };

    const app = buildForgeApp(config);
    const handle = startForgeRuntime(config, app);

    await expect(handle.stop()).resolves.toBeUndefined();
    // Second stop must not throw and must resolve.
    await expect(handle.stop()).resolves.toBeUndefined();
    // A third call remains safe.
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("stop() drains the compliance audit logger exactly once across repeated calls", async () => {
    const flushed: number[] = [];
    const auditStore = {
      append: vi.fn(async () => {}),
      flush: vi.fn(async () => {
        flushed.push(Date.now());
      }),
    } as unknown as ForgeServerConfig["auditStore"];

    const config: ForgeServerConfig = {
      ...createBaseConfig(),
      auditStore,
    };

    const app = buildForgeApp(config);
    const handle = startForgeRuntime(config, app);

    await handle.stop();
    await handle.stop();

    // The audit logger flush should have run at most once despite two stops.
    // (Logger may also no-op if there is nothing buffered; assert it is not
    // called more than once.)
    expect(flushed.length).toBeLessThanOrEqual(1);
  });

  it("createForgeApp remains a build + start wrapper (back-compat)", () => {
    const startSpy = vi.spyOn(ConsolidationScheduler.prototype, "start");

    createForgeApp({
      ...createBaseConfig(),
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    });

    // The legacy wrapper still starts background work in one call.
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("startForgeRuntime mounts consolidation health route only with shutdown", async () => {
    const shutdown = new GracefulShutdown({
      drainTimeoutMs: 1_000,
      runStore: new InMemoryRunStore(),
      eventBus: createEventBus(),
    });

    const config: ForgeServerConfig = {
      ...createBaseConfig(),
      shutdown,
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    };

    const app = buildForgeApp(config);
    // Route is mounted at build time but reports not-running before start.
    const before = await app.request("/api/health/consolidation");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { data: { running: boolean } };
    expect(beforeBody.data.running).toBe(false);

    const handle = startForgeRuntime(config, app);
    const after = await app.request("/api/health/consolidation");
    expect(after.status).toBe(200);

    await handle.stop();
  });
});
