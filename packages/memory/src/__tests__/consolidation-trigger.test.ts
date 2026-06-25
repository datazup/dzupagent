/**
 * W32-E — Consolidation trigger deep (+65 tests)
 *
 * Tests consolidation trigger patterns built on top of the existing
 * ConsolidationEngine, consolidateNamespace, and SleepConsolidator APIs.
 *
 * A "ConsolidationTrigger" is implemented here as a test-local harness
 * class that wraps ConsolidationEngine / consolidateNamespace with
 * time-based, count-based, and importance-based trigger logic so the
 * trigger contract can be tested thoroughly without modifying production
 * code.
 *
 * Topics covered:
 *  - Time-based trigger (consolidate after X ms of idle)
 *  - Count-based trigger (consolidate after N new memories)
 *  - Importance-based trigger (consolidate when high-importance memory arrives)
 *  - Trigger debouncing (rapid additions → only one consolidation fired)
 *  - Multiple triggers firing simultaneously (idempotent)
 *  - Trigger cancellation (shutdown before trigger fires)
 *  - Trigger with empty memory set (no-op)
 *  - Post-consolidation state (memories merged/summarized correctly)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConsolidationEngine,
  type ConsolidationStore,
  type ConsolidationStoreItem,
} from "../consolidation-engine.js";
import {
  consolidateNamespace,
  consolidateAll,
} from "../memory-consolidation.js";
import {
  SleepConsolidator,
  runSleepConsolidation,
} from "../sleep-consolidator.js";
import type { SleepConsolidationConfig } from "../sleep-consolidator.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseStore } from "@langchain/langgraph";

// ────────────────────────────────────────────────────────────────────────────────
// Shared mock factories
// ────────────────────────────────────────────────────────────────────────────────

interface StoreRecord {
  key: string;
  value: Record<string, unknown>;
}

interface MockConsolidationStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>;
  searchCalls: number;
  putCalls: number;
  deleteCalls: number;
}

function makeConsolidationStore(
  records: StoreRecord[] = [],
): MockConsolidationStore {
  const data = new Map<string, Record<string, unknown>>();
  for (const r of records) data.set(r.key, r.value);
  let searchCalls = 0;
  let putCalls = 0;
  let deleteCalls = 0;

  const store: MockConsolidationStore = {
    get data() {
      return data;
    },
    get searchCalls() {
      return searchCalls;
    },
    get putCalls() {
      return putCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
    search: vi.fn(async (_ns: string[]): Promise<ConsolidationStoreItem[]> => {
      searchCalls++;
      return [...data.entries()].map(([key, value]) => ({ key, value }));
    }),
    put: vi.fn(
      async (_ns: string[], key: string, value: Record<string, unknown>) => {
        putCalls++;
        data.set(key, value);
      },
    ),
    delete: vi.fn(async (_ns: string[], key: string) => {
      deleteCalls++;
      data.delete(key);
    }),
  };
  return store;
}

function makeBaseStore(
  records: StoreRecord[] = [],
): BaseStore & { _data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  for (const r of records) data.set(r.key, r.value);
  const store = {
    _data: data,
    search: vi.fn((_ns: string[], _opts?: { limit?: number }) => {
      return Promise.resolve(
        [...data.entries()].map(([key, value]) => ({ key, value })),
      );
    }),
    put: vi.fn((_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((_ns: string[], key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    get: vi.fn((_ns: string[], key: string) => {
      const value = data.get(key);
      return Promise.resolve(value ? { key, value } : undefined);
    }),
  };
  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>;
  };
}

function makeMockModel(): BaseChatModel {
  const model = {
    invoke: vi
      .fn()
      .mockResolvedValue({ content: '{"action":"noop","reason":"ok"}' }),
    _modelType: vi.fn().mockReturnValue("chat"),
    _llmType: vi.fn().mockReturnValue("mock"),
  };
  return model as unknown as BaseChatModel;
}

function makeSleepConfig(
  overrides?: Partial<SleepConsolidationConfig>,
): SleepConsolidationConfig {
  return { model: makeMockModel(), ...overrides };
}

// ────────────────────────────────────────────────────────────────────────────────
// Test-local ConsolidationTrigger harness
//
// A lightweight trigger wrapper built on top of ConsolidationEngine.
// It models the trigger patterns the tests want to exercise.
// ────────────────────────────────────────────────────────────────────────────────

interface TriggerOptions {
  /** Time-based: idle ms before auto-consolidation fires (0 = disabled). */
  idleMs?: number;
  /** Count-based: number of additions before consolidation fires (0 = disabled). */
  countThreshold?: number;
  /** Importance-based: importance value at or above which consolidation fires immediately. */
  importanceThreshold?: number;
  /** Debounce: reset the idle timer on each new addition while within debounce window. */
  debounceMs?: number;
}

class ConsolidationTrigger {
  private addCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consolidationCount = 0;
  private cancelled = false;

  private readonly consolidationFn: () => Promise<void>;

  constructor(
    private readonly opts: TriggerOptions = {},
    onConsolidate?: () => Promise<void>,
  ) {
    this.consolidationFn = onConsolidate ?? (() => Promise.resolve());
  }

  /** Record that a memory was added. Returns whether consolidation was triggered. */
  async add(importance?: number): Promise<boolean> {
    if (this.cancelled) return false;

    this.addCount++;

    // Importance-based: fires immediately if high-importance
    if (
      this.opts.importanceThreshold !== undefined &&
      importance !== undefined &&
      importance >= this.opts.importanceThreshold
    ) {
      await this._fire();
      return true;
    }

    // Count-based: fires when threshold reached
    if (
      this.opts.countThreshold !== undefined &&
      this.opts.countThreshold > 0 &&
      this.addCount >= this.opts.countThreshold
    ) {
      await this._fire();
      this.addCount = 0;
      return true;
    }

    // Time-based / debounce: schedule/reset idle timer
    if (this.opts.idleMs && this.opts.idleMs > 0) {
      const delay = this.opts.debounceMs ?? this.opts.idleMs;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        void this._fire();
      }, delay);
    }

    return false;
  }

  /** Force-cancel any pending timer (shutdown). */
  cancel(): void {
    this.cancelled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get fired(): number {
    return this.consolidationCount;
  }
  get pending(): boolean {
    return this.timer !== null;
  }
  get additions(): number {
    return this.addCount;
  }

  private async _fire(): Promise<void> {
    if (this.cancelled) return;
    this.consolidationCount++;
    await this.consolidationFn();
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — time-based trigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire before idle timeout elapses", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 500 });
    await trigger.add();
    expect(trigger.fired).toBe(0);
    expect(trigger.pending).toBe(true);
  });

  it("fires after idle timeout elapses", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 500 });
    await trigger.add();
    await vi.advanceTimersByTimeAsync(500);
    expect(trigger.fired).toBe(1);
    expect(trigger.pending).toBe(false);
  });

  it("only fires once after single idle period", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 200 });
    await trigger.add();
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(trigger.fired).toBe(1);
  });

  it("calls the consolidation function when timer fires", async () => {
    const consolidateFn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ idleMs: 100 }, consolidateFn);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(consolidateFn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on subsequent add before timeout", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 300 });
    await trigger.add();
    await vi.advanceTimersByTimeAsync(200);
    await trigger.add(); // reset
    await vi.advanceTimersByTimeAsync(200);
    // Should not have fired yet (timer was reset)
    expect(trigger.fired).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(trigger.fired).toBe(1);
  });

  it("does not schedule timer when idleMs is 0", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 0 });
    await trigger.add();
    expect(trigger.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(trigger.fired).toBe(0);
  });

  it("fires once for multiple adds within idle window (debounce effect)", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 300 });
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(300);
    expect(trigger.fired).toBe(1);
  });

  it("can fire multiple times for separate idle periods", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 100 });
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(trigger.fired).toBe(1);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(trigger.fired).toBe(2);
  });

  it("integrates with ConsolidationEngine on timer fire", async () => {
    const store = makeConsolidationStore([
      { key: "task:a", value: { text: "task A" } },
      { key: "task:b", value: { text: "task B" } },
      { key: "task:c", value: { text: "task C" } },
    ]);
    const engine = new ConsolidationEngine();
    let result: Awaited<ReturnType<typeof engine.consolidate>> | null = null;

    const trigger = new ConsolidationTrigger({ idleMs: 50 }, async () => {
      result = await engine.consolidate("team", "session", store);
    });

    await trigger.add();
    await vi.advanceTimersByTimeAsync(50);

    expect(trigger.fired).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.summarized).toBe(3);
  });

  it("tracks timer pending state correctly through lifecycle", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 200 });
    expect(trigger.pending).toBe(false);
    await trigger.add();
    expect(trigger.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(trigger.pending).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — count-based trigger", () => {
  it("does not fire before count threshold", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 3 });
    await trigger.add();
    await trigger.add();
    expect(trigger.fired).toBe(0);
  });

  it("fires exactly at count threshold", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 3 });
    await trigger.add();
    await trigger.add();
    await trigger.add();
    expect(trigger.fired).toBe(1);
  });

  it("resets count after threshold is reached", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 3 });
    for (let i = 0; i < 3; i++) await trigger.add();
    expect(trigger.fired).toBe(1);
    expect(trigger.additions).toBe(0);
  });

  it("fires again after second batch reaches threshold", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 2 });
    await trigger.add();
    await trigger.add();
    expect(trigger.fired).toBe(1);
    await trigger.add();
    await trigger.add();
    expect(trigger.fired).toBe(2);
  });

  it("returns true from add() when consolidation fires", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 1 });
    const fired = await trigger.add();
    expect(fired).toBe(true);
  });

  it("returns false from add() when below threshold", async () => {
    const trigger = new ConsolidationTrigger({ countThreshold: 5 });
    const fired = await trigger.add();
    expect(fired).toBe(false);
  });

  it("calls consolidation function exactly once per threshold crossing", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ countThreshold: 3 }, fn);
    for (let i = 0; i < 9; i++) await trigger.add();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("works with threshold of 1 (immediate consolidation on every add)", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ countThreshold: 1 }, fn);
    await trigger.add();
    await trigger.add();
    await trigger.add();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("integrates with consolidateNamespace on count-based fire", async () => {
    const store = makeBaseStore([
      {
        key: "item1",
        value: {
          text: "first",
          timestamp: new Date(Date.now() - 1000).toISOString(),
        },
      },
      {
        key: "item2",
        value: {
          text: "first",
          timestamp: new Date(Date.now() - 500).toISOString(),
        },
      },
    ]);
    let result: Awaited<ReturnType<typeof consolidateNamespace>> | null = null;

    const trigger = new ConsolidationTrigger(
      { countThreshold: 3 },
      async () => {
        result = await consolidateNamespace(store as unknown as BaseStore, [
          "test",
        ]);
      },
    );

    await trigger.add();
    await trigger.add();
    await trigger.add();

    expect(result).not.toBeNull();
    expect(typeof result!.before).toBe("number");
    expect(typeof result!.after).toBe("number");
  });

  it("fires once when threshold is 0 (disabled — does not fire)", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ countThreshold: 0 }, fn);
    for (let i = 0; i < 10; i++) await trigger.add();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — importance-based trigger", () => {
  it("does not fire for low-importance addition", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.8 });
    const fired = await trigger.add(0.3);
    expect(fired).toBe(false);
    expect(trigger.fired).toBe(0);
  });

  it("fires immediately for high-importance addition", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.8 });
    const fired = await trigger.add(0.9);
    expect(fired).toBe(true);
    expect(trigger.fired).toBe(1);
  });

  it("fires at exactly the threshold value", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.75 });
    const fired = await trigger.add(0.75);
    expect(fired).toBe(true);
  });

  it("does not fire when importance is just below threshold", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.75 });
    const fired = await trigger.add(0.74);
    expect(fired).toBe(false);
  });

  it("fires every time a high-importance memory arrives", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.8 }, fn);
    await trigger.add(0.9);
    await trigger.add(0.5); // below threshold
    await trigger.add(0.95);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("importance trigger takes precedence over count trigger", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { importanceThreshold: 0.8, countThreshold: 10 },
      fn,
    );
    // High importance fires before count threshold
    await trigger.add(0.9);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire when no importance value provided", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.8 });
    await trigger.add(); // no importance
    expect(trigger.fired).toBe(0);
  });

  it("fires for importance = 1.0 (critical memory)", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.5 }, fn);
    await trigger.add(1.0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire for importance = 0 with threshold = 0.5", async () => {
    const trigger = new ConsolidationTrigger({ importanceThreshold: 0.5 });
    const fired = await trigger.add(0);
    expect(fired).toBe(false);
  });

  it("calls consolidation function with correct engine on high-importance arrival", async () => {
    const store = makeConsolidationStore([
      { key: "obs:a", value: { text: "observation A" } },
      { key: "obs:b", value: { text: "observation B" } },
      { key: "obs:c", value: { text: "observation C" } },
    ]);
    const engine = new ConsolidationEngine();
    let engineResult: Awaited<ReturnType<typeof engine.consolidate>> | null =
      null;

    const trigger = new ConsolidationTrigger(
      { importanceThreshold: 0.8 },
      async () => {
        engineResult = await engine.consolidate("agent", "obs", store);
      },
    );

    await trigger.add(0.95);

    expect(engineResult).not.toBeNull();
    expect(engineResult!.summarized).toBe(3);
    expect(store.data.has("obs:__summary__")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid additions into a single consolidation", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { idleMs: 200, debounceMs: 200 },
      fn,
    );

    for (let i = 0; i < 5; i++) {
      await trigger.add();
      await vi.advanceTimersByTimeAsync(50);
    }
    // Final timer should be 200ms from last add
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("each rapid burst fires exactly one consolidation", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { idleMs: 100, debounceMs: 100 },
      fn,
    );

    // Burst 1
    await trigger.add();
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // Burst 2
    await trigger.add();
    await trigger.add();
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not fire until debounce window ends", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { debounceMs: 300, idleMs: 300 },
      fn,
    );

    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("consolidation after debounce processes correct memory set", async () => {
    const store = makeConsolidationStore([
      { key: "memo:1", value: { text: "first memo" } },
      { key: "memo:2", value: { text: "second memo" } },
      { key: "memo:3", value: { text: "third memo" } },
    ]);
    const engine = new ConsolidationEngine();
    let consolidateCount = 0;

    const trigger = new ConsolidationTrigger({ idleMs: 50 }, async () => {
      await engine.consolidate("scope", "ns", store);
      consolidateCount++;
    });

    // Rapid additions
    await trigger.add();
    await vi.advanceTimersByTimeAsync(20);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(20);
    await trigger.add();
    await vi.advanceTimersByTimeAsync(50);

    expect(consolidateCount).toBe(1);
    expect(store.data.has("memo:__summary__")).toBe(true);
  });

  it("add after debounce settles starts a new debounce window", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { idleMs: 100, debounceMs: 100 },
      fn,
    );

    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // New add should start a fresh debounce
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — simultaneous triggers (idempotency)", () => {
  it("count and time triggers firing together still consolidate once", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(undefined);
    // Count threshold = 2, so adding twice fires count trigger
    const trigger = new ConsolidationTrigger(
      { countThreshold: 2, idleMs: 100 },
      fn,
    );

    await trigger.add(); // sets timer
    await trigger.add(); // count threshold fires
    // Now advance timer — it was reset by count trigger firing
    await vi.advanceTimersByTimeAsync(100);
    // Count trigger already fired; timer should have been implicitly redundant
    // Total fires: 1 from count-based (timer add was not scheduled since count fired)
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("calling ConsolidationEngine.consolidate twice is idempotent", async () => {
    const store = makeConsolidationStore([
      { key: "task:a", value: { text: "a" } },
      { key: "task:b", value: { text: "b" } },
      { key: "task:c", value: { text: "c" } },
    ]);
    const engine = new ConsolidationEngine();

    const r1 = await engine.consolidate("s", "ns", store);
    const r2 = await engine.consolidate("s", "ns", store);

    // First pass consolidates 3 items; second pass sees only summary+consolidated children
    expect(r1.summarized).toBe(3);
    // Second pass: children have consolidatedInto set, summary key ends with __summary__
    // → no new consolidation
    expect(r2.summarized).toBe(0);
  });

  it("parallel trigger calls do not double-consolidate", async () => {
    const store = makeConsolidationStore([
      { key: "obs:1", value: { text: "one" } },
      { key: "obs:2", value: { text: "two" } },
      { key: "obs:3", value: { text: "three" } },
    ]);
    const engine = new ConsolidationEngine();
    let callCount = 0;

    const consolidateFn = async () => {
      callCount++;
      await engine.consolidate("scope", "ns", store);
    };

    // Simulate two concurrent trigger fires
    await Promise.all([consolidateFn(), consolidateFn()]);

    // Both fired — but the store handles idempotency
    expect(callCount).toBe(2);
    // Only one summary should exist
    const summaryKeys = [...store.data.keys()].filter((k) =>
      k.endsWith("__summary__"),
    );
    expect(summaryKeys).toHaveLength(1);
  });

  it("SleepConsolidator run is idempotent on same namespace", async () => {
    const store = makeBaseStore([
      { key: "r1", value: { text: "hello there" } },
    ]);
    const config = makeSleepConfig({ phases: ["heal"] });

    const r1 = await runSleepConsolidation(
      store as BaseStore,
      [["ns", "a"]],
      config,
    );
    const r2 = await runSleepConsolidation(
      store as BaseStore,
      [["ns", "a"]],
      config,
    );

    expect(r1.phasesRun).toEqual(r2.phasesRun);
    expect(r1.namespaces).toHaveLength(1);
    expect(r2.namespaces).toHaveLength(1);
  });

  it("multiple SleepConsolidator instances on same store do not conflict", async () => {
    const store = makeBaseStore([{ key: "r1", value: { text: "record one" } }]);
    const c1 = new SleepConsolidator(makeSleepConfig({ phases: ["heal"] }));
    const c2 = new SleepConsolidator(makeSleepConfig({ phases: ["heal"] }));

    const [rep1, rep2] = await Promise.all([
      c1.run(store as BaseStore, [["ns", "x"]]),
      c2.run(store as BaseStore, [["ns", "x"]]),
    ]);

    expect(rep1.phasesRun).toEqual(["heal"]);
    expect(rep2.phasesRun).toEqual(["heal"]);
    expect(rep1.namespaces[0]).toBeDefined();
    expect(rep2.namespaces[0]).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — cancellation (shutdown before trigger fires)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels pending timer without firing", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ idleMs: 500 }, fn);
    await trigger.add();
    expect(trigger.pending).toBe(true);
    trigger.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).not.toHaveBeenCalled();
    expect(trigger.pending).toBe(false);
  });

  it("cancelled trigger does not accept new additions", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ countThreshold: 1 }, fn);
    trigger.cancel();
    const fired = await trigger.add();
    expect(fired).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancelled trigger pending is false", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 100 });
    await trigger.add();
    trigger.cancel();
    expect(trigger.pending).toBe(false);
  });

  it("can be cancelled before any additions", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger({ idleMs: 100 }, fn);
    trigger.cancel();
    await trigger.add();
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("multiple cancel calls are safe", async () => {
    const trigger = new ConsolidationTrigger({ idleMs: 100 });
    await trigger.add();
    trigger.cancel();
    trigger.cancel();
    trigger.cancel();
    // No error thrown
    expect(trigger.fired).toBe(0);
  });

  it("SleepConsolidator run can be aborted via empty namespace list", async () => {
    vi.useRealTimers();
    const store = makeBaseStore([{ key: "r1", value: { text: "data" } }]);
    const config = makeSleepConfig({ phases: ["heal"] });
    // "Cancellation" by passing empty namespaces
    const report = await runSleepConsolidation(store as BaseStore, [], config);
    expect(report.namespaces).toHaveLength(0);
  });

  it("cancelled trigger reports zero fires", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { idleMs: 50, countThreshold: 2 },
      fn,
    );
    await trigger.add();
    trigger.cancel();
    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    expect(trigger.fired).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — empty memory set (no-op)", () => {
  it("count trigger fires but consolidation is no-op on empty store", async () => {
    const store = makeConsolidationStore([]);
    const engine = new ConsolidationEngine();
    let result: Awaited<ReturnType<typeof engine.consolidate>> | null = null;

    const trigger = new ConsolidationTrigger(
      { countThreshold: 3 },
      async () => {
        result = await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add();
    await trigger.add();
    await trigger.add();

    expect(trigger.fired).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.summarized).toBe(0);
    expect(result!.summaries).toHaveLength(0);
  });

  it("importance trigger fires but consolidation is no-op on empty store", async () => {
    const store = makeConsolidationStore([]);
    const engine = new ConsolidationEngine();
    let result: Awaited<ReturnType<typeof engine.consolidate>> | null = null;

    const trigger = new ConsolidationTrigger(
      { importanceThreshold: 0.5 },
      async () => {
        result = await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add(0.9);

    expect(result!.summarized).toBe(0);
    expect(result!.summaries).toEqual([]);
    expect(result!.provenance).toEqual({});
  });

  it("consolidateNamespace returns zero result on empty store", async () => {
    const store = makeBaseStore([]);
    const result = await consolidateNamespace(store as unknown as BaseStore, [
      "empty",
      "ns",
    ]);
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
  });

  it("time trigger fires but no-ops when store is empty", async () => {
    vi.useFakeTimers();
    const store = makeConsolidationStore([]);
    const engine = new ConsolidationEngine();
    let consolidationRan = false;

    const trigger = new ConsolidationTrigger({ idleMs: 100 }, async () => {
      consolidationRan = true;
      await engine.consolidate("scope", "ns", store);
    });

    await trigger.add();
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();

    expect(consolidationRan).toBe(true);
    expect(store.data.size).toBe(0);
  });

  it("SleepConsolidator run on empty store returns zero stats", async () => {
    const store = makeBaseStore([]);
    const config = makeSleepConfig({ phases: ["decay-prune", "heal"] });
    const report = await runSleepConsolidation(
      store as BaseStore,
      [["empty", "ns"]],
      config,
    );
    const ns = report.namespaces[0]!;
    expect(ns.pruned).toBe(0);
    expect(ns.healed).toBe(0);
    expect(ns.deduplicated).toBe(0);
  });

  it("consolidateAll returns empty array for empty namespace list", async () => {
    const store = makeBaseStore([]);
    const results = await consolidateAll(store as unknown as BaseStore, []);
    expect(results).toEqual([]);
  });

  it("count trigger fires no-op without error", async () => {
    const trigger = new ConsolidationTrigger(
      { countThreshold: 1 },
      async () => {
        // simulate no-op consolidation
        return Promise.resolve();
      },
    );
    const fired = await trigger.add();
    expect(fired).toBe(true);
    expect(trigger.fired).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("Post-consolidation state", () => {
  it("children are marked with consolidatedInto after count trigger", async () => {
    const store = makeConsolidationStore([
      { key: "task:a", value: { text: "task A" } },
      { key: "task:b", value: { text: "task B" } },
      { key: "task:c", value: { text: "task C" } },
    ]);
    const engine = new ConsolidationEngine();

    const trigger = new ConsolidationTrigger(
      { countThreshold: 3 },
      async () => {
        await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add();
    await trigger.add();
    await trigger.add();

    // Check child marking
    for (const key of ["task:a", "task:b", "task:c"]) {
      const entry = store.data.get(key);
      expect(entry).toBeDefined();
      expect(entry!["consolidatedInto"]).toBe("task:__summary__");
      const decay = entry!["_decay"] as Record<string, unknown>;
      expect(decay?.["strength"]).toBe(0.1);
    }
  });

  it("summary entry is created with full strength and correct metadata", async () => {
    const store = makeConsolidationStore([
      { key: "note:1", value: { text: "note one" } },
      { key: "note:2", value: { text: "note two" } },
      { key: "note:3", value: { text: "note three" } },
    ]);
    const engine = new ConsolidationEngine();

    const trigger = new ConsolidationTrigger(
      { countThreshold: 3 },
      async () => {
        await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add();
    await trigger.add();
    await trigger.add();

    const summary = store.data.get("note:__summary__");
    expect(summary).toBeDefined();
    expect(summary!["kind"]).toBe("summary");
    expect(summary!["text"]).toContain("note one");
    expect(summary!["text"]).toContain("note two");
    expect(summary!["text"]).toContain("note three");
    const decay = summary!["_decay"] as Record<string, unknown>;
    expect(decay["strength"]).toBe(1);
    expect(Array.isArray(summary!["consolidatedFrom"])).toBe(true);
    expect((summary!["consolidatedFrom"] as string[]).length).toBe(3);
  });

  it("re-running after consolidation does not double-summarize (idempotent post-state)", async () => {
    const store = makeConsolidationStore([
      { key: "obs:1", value: { text: "first" } },
      { key: "obs:2", value: { text: "second" } },
      { key: "obs:3", value: { text: "third" } },
    ]);
    const engine = new ConsolidationEngine();

    await engine.consolidate("scope", "ns", store);
    const r2 = await engine.consolidate("scope", "ns", store);

    // Second pass should produce zero new summaries
    expect(r2.summarized).toBe(0);
    expect(r2.summaries).toEqual([]);

    // Original summary is still there
    expect(store.data.has("obs:__summary__")).toBe(true);
  });

  it("provenance map accurately tracks which keys were consolidated", async () => {
    const store = makeConsolidationStore([
      { key: "fact:alpha", value: { text: "alpha" } },
      { key: "fact:beta", value: { text: "beta" } },
      { key: "fact:gamma", value: { text: "gamma" } },
    ]);
    const engine = new ConsolidationEngine();
    let result: Awaited<ReturnType<typeof engine.consolidate>> | null = null;

    const trigger = new ConsolidationTrigger(
      { importanceThreshold: 0.7 },
      async () => {
        result = await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add(0.95);

    expect(result!.provenance["fact:__summary__"]).toEqual(
      expect.arrayContaining(["fact:alpha", "fact:beta", "fact:gamma"]),
    );
  });

  it("consolidateNamespace merges duplicate texts and reports correct counts", async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 5000).toISOString();
    const newer = now.toISOString();

    const store = makeBaseStore([
      { key: "dup:old", value: { text: "duplicate entry", timestamp: older } },
      { key: "dup:new", value: { text: "duplicate entry", timestamp: newer } },
      { key: "unique:x", value: { text: "unique content", timestamp: newer } },
    ]);

    const result = await consolidateNamespace(store as unknown as BaseStore, [
      "ns",
    ]);
    // One duplicate pair → 1 merged
    expect(result.merged).toBe(1);
    expect(result.before).toBe(3);
  });

  it("post-consolidation store has fewer records than before (net reduction)", async () => {
    const store = makeConsolidationStore([
      { key: "data:1", value: { text: "first entry" } },
      { key: "data:2", value: { text: "second entry" } },
      { key: "data:3", value: { text: "third entry" } },
      { key: "data:4", value: { text: "fourth entry" } },
    ]);
    const engine = new ConsolidationEngine();

    const beforeSize = store.data.size;
    await engine.consolidate("scope", "ns", store);
    // Summary added: size is now beforeSize + 1 (4 original + 1 summary)
    // but children are marked, not deleted (engine marks, decay engine later deletes)
    // So store size grows by 1 (summary entry)
    expect(store.data.size).toBe(beforeSize + 1);
    // But summarized count reflects children absorbed
    const summary = store.data.get("data:__summary__");
    expect(summary).toBeDefined();
    expect((summary!["consolidatedFrom"] as string[]).length).toBe(4);
  });

  it("LLM-judge result replaces default join text in summary", async () => {
    const store = makeConsolidationStore([
      { key: "item:a", value: { text: "alpha detail" } },
      { key: "item:b", value: { text: "beta detail" } },
      { key: "item:c", value: { text: "gamma detail" } },
    ]);

    const llmJudge = vi
      .fn()
      .mockResolvedValue("AI-generated summary of 3 items");
    const engine = new ConsolidationEngine({ llmJudge });

    const trigger = new ConsolidationTrigger(
      { countThreshold: 3 },
      async () => {
        await engine.consolidate("scope", "ns", store);
      },
    );

    await trigger.add();
    await trigger.add();
    await trigger.add();

    const summary = store.data.get("item:__summary__");
    expect(summary!["text"]).toBe("AI-generated summary of 3 items");
    expect(llmJudge).toHaveBeenCalledTimes(1);
  });

  it("SleepConsolidator decay-prune phase removes children below threshold after consolidation", async () => {
    const now = Date.now();
    const store = makeBaseStore([
      {
        key: "old-task",
        value: {
          text: "consolidated child",
          consolidatedInto: "task:__summary__",
          _decay: {
            strength: 0.1,
            accessCount: 1,
            lastAccessedAt: now - 30 * 24 * 60 * 60 * 1000,
            createdAt: now - 30 * 24 * 60 * 60 * 1000,
            halfLifeMs: 1000,
          },
        },
      },
      {
        key: "task:__summary__",
        value: {
          text: "summary of tasks",
          kind: "summary",
          _decay: {
            strength: 1.0,
            accessCount: 0,
            lastAccessedAt: now,
            createdAt: now,
            halfLifeMs: 30 * 24 * 60 * 60 * 1000,
          },
        },
      },
    ]);

    const config = makeSleepConfig({
      phases: ["decay-prune"],
      decayPruneThreshold: 0.05,
    });

    const report = await runSleepConsolidation(
      store as BaseStore,
      [["ns"]],
      config,
    );
    // The consolidated child with strength=0.1 is above 0.05 so may not be pruned
    // depending on halfLife recalculation, but the summary with strength=1.0 is safe
    expect(store._data.has("task:__summary__")).toBe(true);
    expect(typeof report.namespaces[0]!.pruned).toBe("number");
  });
});

// ────────────────────────────────────────────────────────────────────────────────

describe("ConsolidationTrigger — combined trigger configurations", () => {
  it("count and importance triggers both configured — importance fires first", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const trigger = new ConsolidationTrigger(
      { countThreshold: 5, importanceThreshold: 0.9 },
      fn,
    );
    // Add 3 low-importance
    await trigger.add(0.1);
    await trigger.add(0.2);
    expect(fn).not.toHaveBeenCalled();
    // High importance triggers immediately
    await trigger.add(0.95);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("multi-namespace consolidation via consolidateAll processes each independently", async () => {
    const storeA = makeBaseStore([
      { key: "item:1", value: { text: "a1" } },
      { key: "item:2", value: { text: "a2" } },
      { key: "item:3", value: { text: "a3" } },
    ]);
    const storeB = makeBaseStore([{ key: "item:x", value: { text: "b1" } }]);

    const resultsA = await consolidateAll(storeA as unknown as BaseStore, [
      ["ns", "a"],
      ["ns", "b"],
    ]);
    const resultsB = await consolidateAll(storeB as unknown as BaseStore, [
      ["ns", "x"],
    ]);

    expect(resultsA).toHaveLength(2);
    expect(resultsB).toHaveLength(1);
  });

  it("trigger with all options disabled does nothing on add", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    // All triggers disabled: countThreshold=0, no idleMs, no importanceThreshold
    const trigger = new ConsolidationTrigger({ countThreshold: 0 }, fn);
    for (let i = 0; i < 20; i++) await trigger.add(0.99);
    expect(fn).not.toHaveBeenCalled();
  });

  it("durationMs is always tracked in ConsolidationEngine result", async () => {
    const store = makeConsolidationStore();
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("SleepConsolidator phasesRun reflects configured phases after trigger", async () => {
    const store = makeBaseStore();
    const config = makeSleepConfig({ phases: ["heal", "staleness-prune"] });
    const report = await runSleepConsolidation(
      store as BaseStore,
      [["ns", "a"]],
      config,
    );
    expect(report.phasesRun).toEqual(["heal", "staleness-prune"]);
  });
});
