/**
 * Unit tests for maybeStartScheduleTickWorker bootstrap wiring.
 *
 * Verifies the composition contract:
 * - no-op when scheduleStore is absent
 * - no-op when scheduleTickWorker config is absent
 * - starts the worker when both are present
 * - does not double-start when called twice with the same scheduleStore
 * - registers a shutdown hook when shutdown is provided
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventBus } from "@dzupagent/core/events";

import { maybeStartScheduleTickWorker } from "../workers.js";
import { ScheduleTickWorker } from "../../schedules/schedule-tick-worker.js";
import { InMemoryScheduleStore } from "../../schedules/schedule-store.js";
import type { GracefulShutdown } from "../../lifecycle/graceful-shutdown.js";
import type { ForgeServerConfig } from "../types.js";

function makeShutdown(): GracefulShutdown & {
  config: { onDrain?: () => Promise<void> };
} {
  return {
    config: {},
  } as unknown as GracefulShutdown & {
    config: { onDrain?: () => Promise<void> };
  };
}

function baseConfig(
  overrides: Partial<ForgeServerConfig> = {}
): ForgeServerConfig {
  return {
    runStore: {} as ForgeServerConfig["runStore"],
    agentStore: {} as ForgeServerConfig["agentStore"],
    eventBus: createEventBus(),
    modelRegistry: {} as ForgeServerConfig["modelRegistry"],
    ...overrides,
  };
}

describe("maybeStartScheduleTickWorker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op when scheduleStore is absent", () => {
    const startSpy = vi.spyOn(ScheduleTickWorker.prototype, "start");
    const config = baseConfig({
      // scheduleStore intentionally omitted
      scheduleTickWorker: {
        claimerId: "node-1",
        onFire: vi.fn().mockResolvedValue("run-1"),
      },
    });

    expect(() => maybeStartScheduleTickWorker(config)).not.toThrow();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when scheduleTickWorker config is absent", () => {
    const startSpy = vi.spyOn(ScheduleTickWorker.prototype, "start");
    const config = baseConfig({
      scheduleStore: new InMemoryScheduleStore(),
      // scheduleTickWorker intentionally omitted
    });

    expect(() => maybeStartScheduleTickWorker(config)).not.toThrow();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("starts the worker when both scheduleStore and scheduleTickWorker are present", () => {
    const startSpy = vi
      .spyOn(ScheduleTickWorker.prototype, "start")
      .mockImplementation(() => {});
    const store = new InMemoryScheduleStore();
    const onFire = vi.fn().mockResolvedValue("run-id-1");

    const config = baseConfig({
      scheduleStore: store,
      scheduleTickWorker: {
        claimerId: "node-a",
        onFire,
        intervalMs: 5_000,
        limit: 10,
      },
    });

    maybeStartScheduleTickWorker(config);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does not double-start when called twice with the same scheduleStore", () => {
    const startSpy = vi
      .spyOn(ScheduleTickWorker.prototype, "start")
      .mockImplementation(() => {});
    const store = new InMemoryScheduleStore();
    const onFire = vi.fn().mockResolvedValue("run-id-2");

    const config = baseConfig({
      scheduleStore: store,
      scheduleTickWorker: {
        claimerId: "node-b",
        onFire,
      },
    });

    maybeStartScheduleTickWorker(config);
    maybeStartScheduleTickWorker(config);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("registers a shutdown hook when shutdown is provided", () => {
    vi.spyOn(ScheduleTickWorker.prototype, "start").mockImplementation(
      () => {}
    );
    const stopSpy = vi
      .spyOn(ScheduleTickWorker.prototype, "stop")
      .mockImplementation(() => {});

    const store = new InMemoryScheduleStore();
    const shutdown = makeShutdown();
    const onFire = vi.fn().mockResolvedValue("run-id-3");

    const config = baseConfig({
      scheduleStore: store,
      scheduleTickWorker: {
        claimerId: "node-c",
        onFire,
      },
      shutdown,
    });

    maybeStartScheduleTickWorker(config);

    // registerShutdownDrainHook patches shutdown.config.onDrain
    expect(shutdown.config.onDrain).toBeDefined();
    // invoking it should call worker.stop()
    return shutdown.config.onDrain!().then(() => {
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });
  });
});
