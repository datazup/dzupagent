import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRunStore, createEventBus } from "@dzupagent/core";
import type { DzupEvent } from "@dzupagent/core";
import {
  SimpleDelegationTracker,
  type DelegationExecutor,
  type DelegationRequest,
} from "../orchestration/delegation.js";

function makeRequest(
  overrides: Partial<DelegationRequest> = {}
): DelegationRequest {
  return {
    targetAgentId: "polling-specialist",
    task: "Complete asynchronously",
    input: { packet: "delegation-polling" },
    context: {
      parentRunId: "parent-run",
      decisions: [],
      constraints: [],
      relevantFiles: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SimpleDelegationTracker completion polling admission", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid pollIntervalMs %s at construction",
    (pollIntervalMs) => {
      expect(
        () =>
          new SimpleDelegationTracker({
            runStore: new InMemoryRunStore(),
            executor: async () => {},
            pollIntervalMs,
          })
      ).toThrow("pollIntervalMs must be a positive finite number");
    }
  );

  it("keeps an enqueue-and-return delegation active until the store is terminal", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRunStore();
    const get = vi.spyOn(store, "get");
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: async () => {
        // A queue producer may return as soon as it has accepted the run. The
        // worker owns the later terminal store update.
      },
      pollIntervalMs: 25,
      defaultTimeoutMs: 1_000,
    });

    let settled = false;
    const delegation = tracker.delegate(makeRequest()).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    const [run] = await store.list({ agentId: "polling-specialist" });
    expect(run).toBeDefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(tracker.getActiveDelegations()).toHaveLength(1);
    expect((await store.get(run!.id))?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(24);
    expect(get).toHaveBeenCalledTimes(2); // includes the explicit assertion read
    expect(settled).toBe(false);

    await store.update(run!.id, {
      status: "completed",
      output: { accepted: true },
      completedAt: new Date(),
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(delegation).resolves.toMatchObject({
      success: true,
      output: { accepted: true },
    });
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("uses the configured interval between non-terminal store reads", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRunStore();
    const originalGet = store.get.bind(store);
    let pollingReads = 0;
    vi.spyOn(store, "get").mockImplementation(async (runId) => {
      pollingReads += 1;
      return originalGet(runId);
    });
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: async () => {},
      pollIntervalMs: 40,
      defaultTimeoutMs: 1_000,
    });

    const delegation = tracker.delegate(makeRequest());
    await vi.advanceTimersByTimeAsync(0);
    const [run] = await store.list({ agentId: "polling-specialist" });
    expect(pollingReads).toBe(1);

    await vi.advanceTimersByTimeAsync(39);
    expect(pollingReads).toBe(1);

    await store.update(run!.id, {
      status: "completed",
      output: "interval-observed",
      completedAt: new Date(),
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(delegation).resolves.toMatchObject({
      success: true,
      output: "interval-observed",
    });
    expect(pollingReads).toBe(2);
  });

  it("preserves terminal producer output, error, and token usage", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRunStore();
    const executor: DelegationExecutor = async (runId) => {
      setTimeout(() => {
        void store.update(runId, {
          status: "failed",
          output: 0,
          error: "producer-terminal-error",
          tokenUsage: { input: 13, output: 0 },
          completedAt: new Date(),
        });
      }, 30);
    };
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor,
      pollIntervalMs: 10,
      defaultTimeoutMs: 1_000,
    });

    const delegation = tracker.delegate(makeRequest());
    await vi.advanceTimersByTimeAsync(30);

    await expect(delegation).resolves.toMatchObject({
      success: false,
      output: 0,
      error: "producer-terminal-error",
      metadata: { tokenUsage: { input: 13, output: 0 } },
    });
    const [run] = await store.list({ agentId: "polling-specialist" });
    expect(run).toMatchObject({
      status: "failed",
      output: 0,
      error: "producer-terminal-error",
      tokenUsage: { input: 13, output: 0 },
    });
  });

  it("times out a still-running enqueued run exactly once", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const events: DzupEvent[] = [];
    eventBus.onAny((event) => {
      events.push(event);
    });
    const update = vi.spyOn(store, "update");
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: async () => {},
      pollIntervalMs: 10,
      defaultTimeoutMs: 35,
    });

    let settled = false;
    const delegation = tracker.delegate(makeRequest()).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(34);

    expect(settled).toBe(false);
    expect(events.filter((event) => event.type === "delegation:timeout")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await expect(delegation).resolves.toMatchObject({
      success: false,
      output: null,
      error: "Delegation timed out after 35ms",
    });
    expect(events.filter((event) => event.type === "delegation:timeout")).toHaveLength(1);
    expect(
      update.mock.calls.filter(([, value]) => value.status === "failed")
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(events.filter((event) => event.type === "delegation:timeout")).toHaveLength(1);
    expect(
      update.mock.calls.filter(([, value]) => value.status === "failed")
    ).toHaveLength(1);
  });

  it("preserves explicit-cancellation result and event behavior while polling", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const events: DzupEvent[] = [];
    eventBus.onAny((event) => {
      events.push(event);
    });
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: async () => {},
      pollIntervalMs: 10,
      defaultTimeoutMs: 500,
    });

    const delegation = tracker.delegate(makeRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.cancel("polling-specialist")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    await expect(delegation).resolves.toMatchObject({
      success: false,
      output: null,
      error: "Delegation cancelled by user",
    });
    expect(
      events
        .filter((event) => event.type.startsWith("delegation:"))
        .map((event) => event.type)
    ).toEqual(["delegation:started", "delegation:failed"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(events.filter((event) => event.type === "delegation:failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "delegation:timeout")).toHaveLength(0);
  });
});
