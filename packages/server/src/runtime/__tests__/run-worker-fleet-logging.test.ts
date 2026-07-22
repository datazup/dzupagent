/**
 * DZUPAGENT-ERR-M-09 — worker-fleet lifecycle failures must be observable.
 *
 * The fleet register / heartbeat / reap calls are fire-and-forget and
 * intentionally non-fatal, but a silent failure is dangerous (missed heartbeat
 * → peer reaper redistributes this live node's in-flight jobs; failed reap →
 * dead workers accumulate; failed registration → invisible node still pulling
 * jobs). This test drives each rejection and asserts a structured warn line is
 * written to stderr (`console.error`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRunWorker } from "../run-worker.js";
import type { StartRunWorkerOptions } from "../run-worker-types.js";
import type { WorkerNodeStore } from "../worker-registry.js";

/** Minimal no-op event bus. */
function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

/**
 * Build the smallest set of options that lets `startRunWorker` run its fleet
 * setup. `runQueue.start` is stubbed so no jobs are pulled — we only exercise
 * the register/heartbeat/reaper lifecycle.
 */
function makeOptions(
  store: WorkerNodeStore,
  workerId: string
): StartRunWorkerOptions {
  const eventBus = makeEventBus();
  return {
    runQueue: {
      start: vi.fn(),
    } as unknown as StartRunWorkerOptions["runQueue"],
    runStore: {} as StartRunWorkerOptions["runStore"],
    agentStore: { get: vi.fn(async () => null) },
    eventBus: eventBus as unknown as StartRunWorkerOptions["eventBus"],
    modelRegistry: {} as StartRunWorkerOptions["modelRegistry"],
    runExecutor: vi.fn(async () => ({ output: null })),
    workerRegistry: {
      store,
      workerId,
      heartbeatMs: 1_000,
      reaperMs: 1_000,
    },
  };
}

/** A store whose lifecycle methods all reject, to force the catch branches. */
function makeRejectingStore(): WorkerNodeStore {
  const rejection = new Error("registry unreachable");
  return {
    register: vi.fn(async () => {
      throw rejection;
    }),
    heartbeat: vi.fn(async () => {
      throw rejection;
    }),
    reapExpired: vi.fn(async () => {
      throw rejection;
    }),
    setStatus: vi.fn(async () => {}),
    deregister: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  } as unknown as WorkerNodeStore;
}

describe("startRunWorker fleet lifecycle logging (ERR-M-09)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  /** Parse every captured console.error arg as JSON (skips non-JSON lines). */
  function loggedEntries(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const call of errSpy.mock.calls) {
      const raw = call[0];
      if (typeof raw !== "string") continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        /* not a structured line */
      }
    }
    return out;
  }

  it("logs a structured warn when registration rejects", async () => {
    const store = makeRejectingStore();
    startRunWorker(makeOptions(store, "w-reg"));
    // Let the register() promise reject and its .catch run.
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();

    const entry = loggedEntries().find((e) => e.operation === "fleet.register");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: "warn",
      operation: "fleet.register",
      workerId: "w-reg",
      error: "registry unreachable",
    });
  });

  it("logs a structured warn when heartbeat rejects", async () => {
    const store = makeRejectingStore();
    startRunWorker(makeOptions(store, "w-hb"));
    // Advance past the heartbeat interval so the timer fires + its catch runs.
    await vi.advanceTimersByTimeAsync(1_100);

    const entry = loggedEntries().find(
      (e) => e.operation === "fleet.heartbeat"
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: "warn",
      operation: "fleet.heartbeat",
      workerId: "w-hb",
      error: "registry unreachable",
    });
    expect(store.heartbeat).toHaveBeenCalled();
  });

  it("logs a structured warn when the reaper rejects", async () => {
    const store = makeRejectingStore();
    startRunWorker(makeOptions(store, "w-reap"));
    await vi.advanceTimersByTimeAsync(1_100);

    const entry = loggedEntries().find((e) => e.operation === "fleet.reap");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: "warn",
      operation: "fleet.reap",
      workerId: "w-reap",
      error: "registry unreachable",
    });
    expect(store.reapExpired).toHaveBeenCalled();
  });
});
