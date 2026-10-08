/**
 * Tests for `MemoryPruner#schedule` (DZM-P3b): the opt-in scheduled pruner
 * hook. Before this, the pruner ran only when a caller remembered to call it.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import type { BaseStore } from "@langchain/langgraph";
import { MemoryPruner } from "../memory-pruner.js";
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from "../consolidation-engine.js";
import { createStore } from "../store-factory.js";

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function createMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): ConsolidationStore & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  for (const { key, value } of records) data.set(key, value);
  return {
    data,
    search: vi.fn(async (): Promise<ConsolidationStoreItem[]> =>
      [...data.entries()].map(([key, value]) => ({ key, value })),
    ),
    put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key);
    }),
  };
}

/** Manual timer pair: the test fires ticks explicitly. */
function createManualTimers() {
  const timers = {
    callback: undefined as (() => void) | undefined,
    intervalMs: undefined as number | undefined,
    cleared: 0,
    setInterval: (fn: () => void, ms: number) => {
      timers.callback = fn;
      timers.intervalMs = ms;
      return "handle";
    },
    clearInterval: (handle: unknown) => {
      expect(handle).toBe("handle");
      timers.cleared++;
    },
    tick: () => timers.callback?.(),
  };
  return timers;
}

/** Let queued microtasks (an in-flight prune) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MemoryPruner#schedule", () => {
  it("runs nothing until the first interval elapses, then prunes on every tick", async () => {
    const store = createMockStore([
      { key: "old", value: { createdAt: NOW - 10 * DAY } },
      { key: "fresh", value: { createdAt: NOW } },
    ]);
    const timers = createManualTimers();
    const results: unknown[] = [];

    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 60_000,
      now: () => NOW,
      timers,
      onResult: (r) => results.push(r),
    });

    expect(timers.intervalMs).toBe(60_000);
    expect(store.search).not.toHaveBeenCalled();

    timers.tick();
    await flush();
    expect(store.data.has("old")).toBe(false);
    expect(store.data.has("fresh")).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ expired: 1, evicted: 0, remaining: 1, status: "completed" });

    timers.tick();
    await flush();
    expect(results).toHaveLength(2);
    handle.stop();
  });

  it("passes the prune options through (namespace, maxEntries)", async () => {
    const store = createMockStore([
      { key: "a", value: { createdAt: NOW, _decay: { strength: 0.1 } } },
      { key: "b", value: { createdAt: NOW, _decay: { strength: 0.9 } } },
    ]);
    const timers = createManualTimers();
    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 1000,
      namespace: ["t1"],
      maxEntries: 1,
      now: () => NOW,
      timers,
    });
    const result = await handle.runNow();
    expect(result).toMatchObject({ evicted: 1, remaining: 1 });
    expect(store.delete).toHaveBeenCalledWith(["t1"], "a");
    handle.stop();
  });

  it("rejects a missing or non-positive interval", () => {
    const store = createMockStore();
    const pruner = new MemoryPruner();
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        pruner.schedule(store, { intervalMs, timers: createManualTimers() }),
      ).toThrow(/intervalMs/);
    }
    expect(() =>
      pruner.schedule(store, { timers: createManualTimers() } as never),
    ).toThrow(/intervalMs/);
  });

  it("never overlaps runs: a tick during an in-flight run is skipped and runNow shares it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createMockStore([{ key: "k", value: { createdAt: NOW } }]);
    store.search = vi.fn(async () => {
      await gate;
      return [];
    });
    const timers = createManualTimers();
    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 1000,
      timers,
    });

    timers.tick();
    timers.tick();
    const manual = handle.runNow();
    expect(store.search).toHaveBeenCalledTimes(1);

    release();
    await expect(manual).resolves.toMatchObject({ status: "completed" });

    timers.tick();
    await flush();
    expect(store.search).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("routes a failing run to onError and keeps the schedule alive", async () => {
    const store = createMockStore();
    let fail = true;
    store.search = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return [];
    });
    const pruner = new MemoryPruner();
    // Make prune itself throw (search errors are normally absorbed as "degraded").
    const realPrune = pruner.prune.bind(pruner);
    vi.spyOn(pruner, "prune").mockImplementation(async (s, o) => {
      if (fail) throw new Error("prune exploded");
      return realPrune(s, o);
    });
    const errors: unknown[] = [];
    const results: unknown[] = [];
    const timers = createManualTimers();
    const handle = pruner.schedule(store, {
      intervalMs: 1000,
      timers,
      onError: (e) => errors.push(e),
      onResult: (r) => results.push(r),
    });

    timers.tick();
    await flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("prune exploded");
    expect(results).toHaveLength(0);

    fail = false;
    timers.tick();
    await flush();
    expect(results).toHaveLength(1);
    handle.stop();
  });

  it("routes a throwing onResult to onError", async () => {
    const store = createMockStore();
    const errors: unknown[] = [];
    const timers = createManualTimers();
    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 1000,
      timers,
      onResult: () => {
        throw new Error("listener broke");
      },
      onError: (e) => errors.push(e),
    });
    timers.tick();
    await flush();
    expect(errors.map((e) => (e as Error).message)).toEqual(["listener broke"]);
    handle.stop();
  });

  it("logs instead of rejecting when no onError is given", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMockStore();
    const pruner = new MemoryPruner();
    vi.spyOn(pruner, "prune").mockRejectedValue(new Error("unhandled?"));
    const timers = createManualTimers();
    const handle = pruner.schedule(store, { intervalMs: 1000, timers });
    timers.tick();
    await flush();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toMatch(/pruner/);
    handle.stop();
  });

  it("stop() clears the timer once, silences later ticks, and leaves runNow usable", async () => {
    const store = createMockStore([{ key: "old", value: { createdAt: NOW - 10 * DAY } }]);
    const timers = createManualTimers();
    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 1000,
      now: () => NOW,
      timers,
    });
    expect(handle.stopped).toBe(false);
    handle.stop();
    handle.stop();
    expect(handle.stopped).toBe(true);
    expect(timers.cleared).toBe(1);

    timers.tick();
    await flush();
    expect(store.search).not.toHaveBeenCalled();

    await expect(handle.runNow()).resolves.toMatchObject({ expired: 1 });
    expect(store.data.size).toBe(0);
  });

  it("uses unref'd real timers by default so a schedule never holds the process open", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realSetInterval(fn, ms);
        (handle as unknown as { unref: () => void }).unref = unref;
        return handle;
      }) as typeof setInterval);

    const store = createMockStore([{ key: "old", value: { createdAt: 1 } }]);
    const handle = new MemoryPruner().schedule(store, {
      intervalMs: 5000,
      ttlMs: 1000,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(store.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.search).toHaveBeenCalled();
    expect(store.data.size).toBe(0);

    handle.stop();
    const calls = (store.search as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect((store.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("physically prunes the in-memory store from createStore on schedule", async () => {
    const store = (await createStore({ type: "memory" })) as BaseStore;
    await store.put(["t1"], "old", { text: "stale", createdAt: NOW - 10 * DAY });
    await store.put(["t1"], "new", { text: "fresh", createdAt: NOW });
    await store.put(["t10"], "other", { text: "other tenant", createdAt: NOW - 10 * DAY });

    const timers = createManualTimers();
    const results: unknown[] = [];
    const handle = new MemoryPruner().schedule(
      store as unknown as ConsolidationStore,
      {
        intervalMs: 1000,
        namespace: ["t1"],
        now: () => NOW,
        timers,
        onResult: (r) => results.push(r),
      },
    );
    timers.tick();
    await flush();
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(await store.get(["t1"], "old")).toBeUndefined();
    expect(await store.get(["t1"], "new")).toBeDefined();
    // Segment-wise namespaces: the t1 schedule must not touch t10.
    expect(await store.get(["t10"], "other")).toBeDefined();
    handle.stop();
  });
});
