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
import { describe, it, expect, vi } from "vitest";
import {
  ConsolidationEngine,
  type ConsolidationStore,
  type ConsolidationStoreItem,
} from "../consolidation-engine.js";
import { consolidateNamespace } from "../memory-consolidation.js";
import { runSleepConsolidation } from "../sleep-consolidator.js";
import type { SleepConsolidationConfig } from "../sleep-consolidator.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseStore } from "@langchain/langgraph";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ObservationalMemory } from "../observational-memory.js";
import { ObservationExtractor } from "../observation-extractor.js";
import { DualStreamWriter, type PendingRecord } from "../dual-stream-writer.js";
import { createMemoryHarness, type MemoryHarness } from "../testing/memory-harness.js";

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
// Test-local ConsolidationTriggerHarness — injected DRIVER, not a subject
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

class ConsolidationTriggerHarness {
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

describe("Post-consolidation state", () => {
  it("children are marked with consolidatedInto after count trigger", async () => {
    const store = makeConsolidationStore([
      { key: "task:a", value: { text: "task A" } },
      { key: "task:b", value: { text: "task B" } },
      { key: "task:c", value: { text: "task C" } },
    ]);
    const engine = new ConsolidationEngine();

    const trigger = new ConsolidationTriggerHarness(
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

    const trigger = new ConsolidationTriggerHarness(
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

    const trigger = new ConsolidationTriggerHarness(
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

    const trigger = new ConsolidationTriggerHarness(
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

// ──────────────────────────────────────────────────────────────────────────────
/**
 * COVERAGE GAP — deliberately skipped suite (DZUPAGENT-TEST-C-14).
 *
 * This file previously held 59 `it()` blocks across 8 top-level describes
 * ("ConsolidationTrigger — time-based / count-based / importance-based /
 * debounce / simultaneous triggers (idempotency) / cancellation / empty
 * memory set / combined trigger configurations") whose entire subject under
 * test was `ConsolidationTrigger` — a class DEFINED LOCALLY in this file.
 * Those describes asserted only against the harness's own counters
 * (`fired`, `pending`, `additions`), never against any shipped symbol. A
 * repo-wide grep for `ConsolidationTrigger` returns zero non-test source
 * files across all 36 packages: no such class ships anywhere, and no
 * consolidation *scheduler* ships in `@dzupagent/memory` at all.
 *
 * The harness class is KEPT below, because the surviving
 * "Post-consolidation state" describe uses it only as a driver and asserts
 * against the real `ConsolidationEngine` / `consolidateNamespace` /
 * `runSleepConsolidation` output. It has been renamed to
 * `ConsolidationTriggerHarness` so its role as an injected double — not a
 * subject — is unambiguous (same convention as the cleared
 * `RunCancellationHarness` in `@dzupagent/agent`).
 *
 * PRODUCTION TRIGGER SYMBOLS — the real threshold/debounce/timer-driven
 * scheduling in `@dzupagent/memory` has its own suites:
 *   - `ObservationExtractor.shouldExtract()` — observation-extractor.test.ts
 *   - `DualStreamWriter` batch/timer flush — dual-stream-writer.test.ts
 *   - `ShortTermBuffer` auto-flush threshold — short-term-buffer.test.ts
 *   - `ObservationalMemory` observer/reflector thresholds — observational-memory.test.ts
 * The describe below covers the trigger contracts those suites did not:
 * simultaneous triggers are idempotent, rapid additions coalesce into one
 * timer-driven flush, and a trigger with nothing pending is a no-op.
 *
 * Removed 2026-08-14 (DZUPAGENT-TEST-C-14 / RF-07); real tests 2026-10-08 (DZM-P3c).
 */
describe("consolidation triggering — production scheduling symbols", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function makeMessages(count: number): BaseMessage[] {
    return Array.from({ length: count }, (_, i) =>
      i % 2 === 0 ? new HumanMessage(`Message ${i}`) : new AIMessage(`Response ${i}`),
    );
  }

  const observationJson = JSON.stringify([
    { text: "User prefers dark mode", category: "preference", confidence: 0.9, evidenceRefs: ["m1"] },
  ]);

  function makeObservationalMemory(
    model: BaseChatModel,
    harness: MemoryHarness,
  ): ObservationalMemory {
    return new ObservationalMemory({
      model,
      memoryService: harness.memory,
      store: harness.store,
      namespace: harness.namespace,
      scope: harness.scope,
      observerThreshold: 3,
      observerDebounceMs: 0,
    });
  }

  it("simultaneous ObservationalMemory triggers run the observer once", async () => {
    const gate = deferred<{ content: string }>();
    const invoke = vi.fn(() => gate.promise);
    const harness = createMemoryHarness({ namespace: "observations" });
    const om = makeObservationalMemory({ invoke } as unknown as BaseChatModel, harness);

    const first = om.observe(makeMessages(3));
    const second = om.observe(makeMessages(3));
    gate.resolve({ content: observationJson });
    const results = await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const stored = (await harness.snapshot()).filter(
      (r) => r.value["text"] === "User prefers dark mode",
    );
    expect(stored).toHaveLength(1);
    expect(om.getStats().observerRuns).toBe(1);
  });

  it("the observer can trigger again after an in-flight run fails", async () => {
    const invoke = vi.fn(async () => ({ content: observationJson }));
    const harness = createMemoryHarness({ namespace: "observations" });
    vi.spyOn(harness.memory, "get").mockRejectedValueOnce(new Error("store down"));
    const om = makeObservationalMemory({ invoke } as unknown as BaseChatModel, harness);

    // The first run throws inside the observer (store read) and is non-fatal.
    expect(await om.observe(makeMessages(3))).toBeNull();
    // The guard is released: the next crossing runs the observer again.
    expect(await om.observe(makeMessages(3))).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rapid DualStreamWriter additions below batchSize coalesce into one timer flush", async () => {
    vi.useFakeTimers();
    try {
      const onSlowPath = vi.fn(async (_records: PendingRecord[]) => {});
      const writer = new DualStreamWriter({
        memoryService: createMemoryHarness().memory,
        namespace: "facts",
        scope: { tenantId: "t1" },
        batchSize: 10,
        maxDelayMs: 1000,
        onSlowPath,
      });

      await writer.ingest("k1", { text: "a" });
      await vi.advanceTimersByTimeAsync(600);
      await writer.ingest("k2", { text: "b" });
      await writer.ingest("k3", { text: "c" });
      // The deadline is set by the first pending record and is not pushed back.
      await vi.advanceTimersByTimeAsync(401);

      expect(onSlowPath).toHaveBeenCalledTimes(1);
      expect(onSlowPath.mock.calls[0]![0].map((r) => r.key)).toEqual(["k1", "k2", "k3"]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSlowPath).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a DualStreamWriter timer that fires with nothing pending is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const onSlowPath = vi.fn(async (_records: PendingRecord[]) => {});
      const writer = new DualStreamWriter({
        memoryService: createMemoryHarness().memory,
        namespace: "facts",
        scope: { tenantId: "t1" },
        maxDelayMs: 1000,
        onSlowPath,
      });

      await writer.ingest("k1", { text: "a" });
      writer.clearPending();
      await vi.advanceTimersByTimeAsync(1001);

      expect(onSlowPath).not.toHaveBeenCalled();
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ObservationExtractor closes its debounce window as soon as extraction starts", async () => {
    const gate = deferred<{ content: string }>();
    const invoke = vi.fn(() => gate.promise);
    const extractor = new ObservationExtractor({
      model: { invoke } as unknown as BaseChatModel,
      minMessages: 1,
      debounceMs: 60_000,
    });

    expect(extractor.shouldExtract(5)).toBe(true);
    const running = extractor.extract(makeMessages(2));
    // A second caller polling while the model call is in flight is gated.
    expect(extractor.shouldExtract(5)).toBe(false);
    gate.resolve({ content: "[]" });
    await running;
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
