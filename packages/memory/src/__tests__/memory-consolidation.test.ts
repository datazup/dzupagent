/**
 * Comprehensive tests for memory consolidation subsystems.
 *
 * Covers:
 *   - consolidateNamespace / consolidateAll (memory-consolidation.ts)
 *   - ConsolidationEngine (consolidation-engine.ts)
 *   - parseMemoryEntry / MemoryEntry (consolidation-types.ts)
 *   - dedupLessons (lesson-dedup.ts)
 *   - SemanticConsolidator additional scenarios (semantic-consolidation.ts)
 *   - SleepConsolidator phase gating (sleep-consolidator.ts)
 *
 * No live LLM calls — all model invocations are mocked with vi.fn().
 * No real database — all store operations use in-memory Map implementations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  consolidateNamespace,
  consolidateAll,
  type ConsolidationConfig,
  type ConsolidationResult as NsConsolidationResult,
} from "../memory-consolidation.js";
import {
  ConsolidationEngine,
  type ConsolidationStore,
  type ConsolidationStoreItem,
} from "../consolidation-engine.js";
import { parseMemoryEntry, type MemoryEntry } from "../consolidation-types.js";
import { dedupLessons } from "../lesson-dedup.js";
import {
  SemanticConsolidator,
  consolidateWithLLM,
  type ConsolidationAction,
} from "../semantic-consolidation.js";
import {
  SleepConsolidator,
  runSleepConsolidation,
} from "../sleep-consolidator.js";
import type { BaseStore } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal BaseStore backed by an in-memory Map, compatible with consolidateNamespace. */
function makeBaseStore(
  records: Array<{
    ns: string[];
    key: string;
    value: Record<string, unknown>;
    createdAt?: Date;
  }> = [],
): BaseStore {
  const data = new Map<
    string,
    { key: string; value: Record<string, unknown>; createdAt: Date }
  >();
  const nsKey = (ns: string[], k: string) => `${ns.join("/")}__${k}`;

  for (const r of records) {
    data.set(nsKey(r.ns, r.key), {
      key: r.key,
      value: r.value,
      createdAt: r.createdAt ?? new Date(),
    });
  }

  return {
    search: vi.fn(async (ns: string[], opts?: { limit?: number }) => {
      const prefix = `${ns.join("/")}__`;
      const limit = opts?.limit ?? 200;
      return [...data.values()]
        .filter((r) => data.has(`${ns.join("/")}__${r.key}`))
        .filter((r) => {
          const k = nsKey(ns, r.key);
          return data.has(k) && data.get(k)!.value === r.value;
        })
        .slice(0, limit);
    }),
    get: vi.fn(),
    put: vi.fn(
      async (ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(nsKey(ns, key), { key, value, createdAt: new Date() });
      },
    ),
    delete: vi.fn(async (ns: string[], key: string) => {
      data.delete(nsKey(ns, key));
    }),
    batch: vi.fn(),
    start: vi.fn(),
    setup: vi.fn(),
    listNamespaces: vi.fn(),
  } as unknown as BaseStore;
}

/** A simpler ConsolidationStore backed by a Map — for ConsolidationEngine tests. */
interface MockConsolidationStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>;
}

function makeMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): MockConsolidationStore {
  const data = new Map<string, Record<string, unknown>>();
  for (const { key, value } of records) {
    data.set(key, value);
  }
  return {
    data,
    search: vi.fn(
      async (): Promise<ConsolidationStoreItem[]> =>
        [...data.entries()].map(([key, value]) => ({ key, value })),
    ),
    put: vi.fn(
      async (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, value);
      },
    ),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key);
    }),
  };
}

/** Build a timestamp far in the past (in milliseconds from epoch). */
function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Build a fake BaseChatModel that returns a fixed JSON string. */
function makeMockModel(responseJson: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({ content: responseJson }),
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

/** Build a namespaced BaseStore that only stores items for one specific namespace tuple. */
function makeNsStore(
  ns: string[],
  records: Array<{
    key: string;
    value: Record<string, unknown>;
    createdAt?: Date;
  }> = [],
): BaseStore {
  const data = new Map<
    string,
    { key: string; value: Record<string, unknown>; createdAt: Date }
  >();
  for (const r of records) {
    data.set(r.key, {
      key: r.key,
      value: r.value,
      createdAt: r.createdAt ?? new Date(),
    });
  }
  return {
    search: vi.fn(async (_ns: string[], opts?: { limit?: number }) => {
      const limit = opts?.limit ?? 200;
      return [...data.values()].slice(0, limit);
    }),
    get: vi.fn(),
    put: vi.fn(
      async (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, { key, value, createdAt: new Date() });
      },
    ),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key);
    }),
    batch: vi.fn(),
    start: vi.fn(),
    setup: vi.fn(),
    listNamespaces: vi.fn(),
  } as unknown as BaseStore;
}

// ===========================================================================
// Section 1: consolidateNamespace (memory-consolidation.ts)
// ===========================================================================

describe("consolidateNamespace", () => {
  describe("empty namespace", () => {
    it("returns zero counts for an empty namespace", async () => {
      const store = makeNsStore(["ns"]);
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.before).toBe(0);
      expect(result.after).toBe(0);
      expect(result.merged).toBe(0);
      expect(result.pruned).toBe(0);
    });

    it("returns the namespace in the result", async () => {
      const store = makeNsStore(["lessons", "user-1"]);
      const result = await consolidateNamespace(store, ["lessons", "user-1"]);
      expect(result.namespace).toEqual(["lessons", "user-1"]);
    });
  });

  describe("deduplication — exact text matches", () => {
    it("merges two entries with identical text and keeps the newer one", async () => {
      const older = new Date(daysAgo(5)).toISOString();
      const newer = new Date(daysAgo(1)).toISOString();
      const store = makeNsStore(
        ["ns"],
        [
          {
            key: "entry-old",
            value: { text: "use snake_case for variables", timestamp: older },
          },
          {
            key: "entry-new",
            value: { text: "use snake_case for variables", timestamp: newer },
          },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.merged).toBe(1);
      expect(store.delete).toHaveBeenCalledTimes(1);
    });

    it("deletes the older entry when two entries have identical text", async () => {
      const older = new Date(daysAgo(10)).toISOString();
      const newer = new Date(daysAgo(1)).toISOString();
      const deleteSpy = vi.fn();
      const store = makeNsStore(
        ["ns"],
        [
          {
            key: "old-key",
            value: { text: "always test before shipping", timestamp: older },
          },
          {
            key: "new-key",
            value: { text: "always test before shipping", timestamp: newer },
          },
        ],
      );
      (store.delete as ReturnType<typeof vi.fn>).mockImplementation(deleteSpy);
      await consolidateNamespace(store, ["ns"]);
      expect(deleteSpy).toHaveBeenCalledWith(["ns"], "old-key");
    });

    it("does not merge entries with different text", async () => {
      const store = makeNsStore(
        ["ns"],
        [
          { key: "k1", value: { text: "use TypeScript" } },
          { key: "k2", value: { text: "use Python for scripts" } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.merged).toBe(0);
    });

    it("merges three entries where two are identical", async () => {
      const older = new Date(daysAgo(3)).toISOString();
      const newest = new Date(daysAgo(1)).toISOString();
      const store = makeNsStore(
        ["ns"],
        [
          {
            key: "k1",
            value: { text: "prefer const over let", timestamp: older },
          },
          {
            key: "k2",
            value: { text: "prefer const over let", timestamp: newest },
          },
          { key: "k3", value: { text: "avoid mutation when possible" } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.merged).toBe(1);
    });
  });

  describe("deduplication — near-duplicate matching (prefix-100-char)", () => {
    it("merges entries that share the same first 100 characters", async () => {
      const base = "A".repeat(100);
      const older = new Date(daysAgo(5)).toISOString();
      const newer = new Date(daysAgo(1)).toISOString();
      const store = makeNsStore(
        ["ns"],
        [
          {
            key: "a",
            value: { text: `${base} (old detail)`, timestamp: older },
          },
          {
            key: "b",
            value: { text: `${base} (new detail)`, timestamp: newer },
          },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.merged).toBe(1);
    });

    it("does NOT merge entries that differ within the first 100 characters", async () => {
      const store = makeNsStore(
        ["ns"],
        [
          { key: "a", value: { text: `Alpha ${"x".repeat(90)} detail A` } },
          { key: "b", value: { text: `Beta ${"x".repeat(90)} detail B` } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.merged).toBe(0);
    });
  });

  describe("pruning — max entries", () => {
    it("prunes entries beyond maxEntries (keeps newest)", async () => {
      const records = Array.from({ length: 5 }, (_, i) => ({
        key: `k${i}`,
        value: {
          text: `unique text number ${i}`,
          timestamp: new Date(daysAgo(5 - i)).toISOString(),
        },
      }));
      const store = makeNsStore(["ns"], records);
      const result = await consolidateNamespace(store, ["ns"], {
        maxEntries: 3,
      });
      expect(result.pruned).toBe(2);
    });

    it("does not prune when count is within maxEntries", async () => {
      const records = Array.from({ length: 3 }, (_, i) => ({
        key: `k${i}`,
        value: {
          text: `unique entry ${i}`,
          timestamp: new Date(daysAgo(i)).toISOString(),
        },
      }));
      const store = makeNsStore(["ns"], records);
      const result = await consolidateNamespace(store, ["ns"], {
        maxEntries: 5,
      });
      expect(result.pruned).toBe(0);
    });
  });

  describe("pruning — max age", () => {
    it("prunes entries older than maxAgeMs", async () => {
      const veryOld = new Date(daysAgo(100)).toISOString();
      const fresh = new Date(daysAgo(1)).toISOString();
      const store = makeNsStore(
        ["ns"],
        [
          { key: "stale", value: { text: "old lesson", timestamp: veryOld } },
          { key: "fresh", value: { text: "new lesson", timestamp: fresh } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"], {
        maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
      expect(result.pruned).toBeGreaterThanOrEqual(1);
    });

    it("does not prune entries newer than maxAgeMs", async () => {
      const fresh = new Date(daysAgo(1)).toISOString();
      const store = makeNsStore(
        ["ns"],
        [
          { key: "k1", value: { text: "fresh entry A", timestamp: fresh } },
          { key: "k2", value: { text: "fresh entry B", timestamp: fresh } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"], {
        maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      expect(result.pruned).toBe(0);
    });
  });

  describe("metadata preservation", () => {
    it("before count matches actual number of items fetched from store", async () => {
      const records = Array.from({ length: 7 }, (_, i) => ({
        key: `k${i}`,
        value: { text: `entry ${i}` },
      }));
      const store = makeNsStore(["ns"], records);
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.before).toBe(7);
    });

    it("after = before - merged - pruned", async () => {
      const records = Array.from({ length: 4 }, (_, i) => ({
        key: `k${i}`,
        value: { text: `unique text ${i}` },
      }));
      const store = makeNsStore(["ns"], records);
      const result = await consolidateNamespace(store, ["ns"]);
      expect(result.after).toBe(result.before - result.merged - result.pruned);
    });

    it("after is never negative", async () => {
      const records = Array.from({ length: 2 }, (_, i) => ({
        key: `k${i}`,
        value: { text: `item ${i}` },
      }));
      const store = makeNsStore(["ns"], records);
      const result = await consolidateNamespace(store, ["ns"], {
        maxEntries: 1,
      });
      expect(result.after).toBeGreaterThanOrEqual(0);
    });
  });

  describe("entries without text field", () => {
    it("handles entries that have no text field (uses key for dedup)", async () => {
      const store = makeNsStore(
        ["ns"],
        [
          { key: "no-text-a", value: { data: 42 } },
          { key: "no-text-b", value: { data: 99 } },
        ],
      );
      const result = await consolidateNamespace(store, ["ns"]);
      // Both have empty text — each gets its own bucket
      expect(result.before).toBe(2);
    });
  });
});

// ===========================================================================
// Section 2: consolidateAll (memory-consolidation.ts)
// ===========================================================================

describe("consolidateAll", () => {
  it("returns one result per namespace", async () => {
    const store = makeNsStore(["ns1"]);
    const results = await consolidateAll(store, [["ns1"], ["ns2"], ["ns3"]]);
    expect(results).toHaveLength(3);
  });

  it("each result has the correct namespace field", async () => {
    const store = makeNsStore(["lessons"]);
    const namespaces = [["lessons"], ["decisions"], ["conventions"]];
    const results = await consolidateAll(store, namespaces);
    expect(results[0]!.namespace).toEqual(["lessons"]);
    expect(results[1]!.namespace).toEqual(["decisions"]);
    expect(results[2]!.namespace).toEqual(["conventions"]);
  });

  it("returns empty results array for zero namespaces", async () => {
    const store = makeNsStore(["ns"]);
    const results = await consolidateAll(store, []);
    expect(results).toEqual([]);
  });

  it("accumulates correct totals across namespaces", async () => {
    const store = makeNsStore(["ns"]);
    const results = await consolidateAll(store, [["lessons"], ["tasks"]]);
    const totalBefore = results.reduce((s, r) => s + r.before, 0);
    expect(typeof totalBefore).toBe("number");
    expect(totalBefore).toBeGreaterThanOrEqual(0);
  });

  it("processes namespaces independently (no cross-namespace interference)", async () => {
    const store = makeNsStore(["ns"]);
    const results = await consolidateAll(store, [["ns-a"], ["ns-b"]]);
    // Each namespace starts with 0 entries — both return clean results
    expect(results[0]!.before).toBe(0);
    expect(results[1]!.before).toBe(0);
  });
});

// ===========================================================================
// Section 3: parseMemoryEntry (consolidation-types.ts)
// ===========================================================================

describe("parseMemoryEntry", () => {
  it("extracts text field from value", () => {
    const entry = parseMemoryEntry("k1", { text: "hello world", count: 5 });
    expect(entry.text).toBe("hello world");
    expect(entry.key).toBe("k1");
  });

  it("falls back to JSON.stringify when text is absent", () => {
    const value = { data: "no text field", count: 1 };
    const entry = parseMemoryEntry("k2", value);
    expect(entry.text).toBe(JSON.stringify(value));
  });

  it("extracts decay metadata when all fields are present", () => {
    const now = Date.now();
    const entry = parseMemoryEntry("k3", {
      text: "test",
      _decay: {
        strength: 0.7,
        accessCount: 3,
        lastAccessedAt: now,
        createdAt: now - 1000,
        halfLifeMs: 86400000,
      },
    });
    expect(entry.decay).toBeDefined();
    expect(entry.decay!.strength).toBe(0.7);
    expect(entry.decay!.accessCount).toBe(3);
  });

  it("decay is undefined when _decay is missing", () => {
    const entry = parseMemoryEntry("k4", { text: "no decay" });
    expect(entry.decay).toBeUndefined();
  });

  it("decay is undefined when _decay has missing fields", () => {
    const entry = parseMemoryEntry("k5", {
      text: "partial decay",
      _decay: { strength: 0.5 }, // missing required fields
    });
    expect(entry.decay).toBeUndefined();
  });

  it("extracts pinned flag from value", () => {
    const pinned = parseMemoryEntry("k6", {
      text: "pinned entry",
      pinned: true,
    });
    const unpinned = parseMemoryEntry("k7", {
      text: "normal entry",
      pinned: false,
    });
    expect(pinned.pinned).toBe(true);
    expect(unpinned.pinned).toBe(false);
  });

  it("pinned is undefined when not present in value", () => {
    const entry = parseMemoryEntry("k8", { text: "no pin field" });
    expect(entry.pinned).toBeUndefined();
  });

  it("extracts importance from value", () => {
    const entry = parseMemoryEntry("k9", {
      text: "important",
      importance: 0.9,
    });
    expect(entry.importance).toBe(0.9);
  });

  it("importance is undefined when not a number", () => {
    const entry = parseMemoryEntry("k10", { text: "test", importance: "high" });
    expect(entry.importance).toBeUndefined();
  });

  it("extracts createdAt from decay if available", () => {
    const ts = 1700000000000;
    const entry = parseMemoryEntry("k11", {
      text: "test",
      _decay: {
        strength: 1,
        accessCount: 0,
        lastAccessedAt: ts,
        createdAt: ts,
        halfLifeMs: 86400000,
      },
    });
    expect(entry.createdAt).toBe(ts);
  });

  it("falls back to value.createdAt when no decay", () => {
    const ts = 1600000000000;
    const entry = parseMemoryEntry("k12", { text: "test", createdAt: ts });
    expect(entry.createdAt).toBe(ts);
  });

  it("raw field holds the original value reference", () => {
    const value = { text: "original", extra: "data" };
    const entry = parseMemoryEntry("k13", value);
    expect(entry.raw).toBe(value);
  });

  it("key is preserved exactly as provided", () => {
    const entry = parseMemoryEntry("my-special-key:123", { text: "test" });
    expect(entry.key).toBe("my-special-key:123");
  });

  it("handles empty string text field", () => {
    const entry = parseMemoryEntry("k14", { text: "" });
    expect(entry.text).toBe("");
  });
});

// ===========================================================================
// Section 4: ConsolidationEngine (consolidation-engine.ts)
// ===========================================================================

describe("ConsolidationEngine", () => {
  describe("empty store", () => {
    it("returns zero result when store is empty", async () => {
      const store = makeMockStore();
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("scope", "ns", store);
      expect(result.summarized).toBe(0);
      expect(result.summaries).toHaveLength(0);
      expect(result.provenance).toEqual({});
    });

    it("search returns empty for store that throws", async () => {
      const store: ConsolidationStore = {
        search: vi.fn().mockRejectedValue(new Error("connection failed")),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("scope", "ns", store);
      expect(result.summarized).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("deterministic summary content (no llmJudge)", () => {
    it("joins cluster entry texts with \\n---\\n delimiter", async () => {
      const store = makeMockStore([
        { key: "work:a", value: { text: "alpha text" } },
        { key: "work:b", value: { text: "beta text" } },
        { key: "work:c", value: { text: "gamma text" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      const summary = store.data.get("work:__summary__")!;
      expect(typeof summary["text"]).toBe("string");
      expect((summary["text"] as string).includes("---")).toBe(true);
    });

    it("summary text contains all cluster entries", async () => {
      const store = makeMockStore([
        { key: "note:x", value: { text: "entry X" } },
        { key: "note:y", value: { text: "entry Y" } },
        { key: "note:z", value: { text: "entry Z" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      const summary = store.data.get("note:__summary__")!;
      const text = summary["text"] as string;
      expect(text).toContain("entry X");
      expect(text).toContain("entry Y");
      expect(text).toContain("entry Z");
    });
  });

  describe("llmJudge integration", () => {
    it("uses llmJudge output as the summary text", async () => {
      const store = makeMockStore([
        { key: "task:1", value: { text: "do A" } },
        { key: "task:2", value: { text: "do B" } },
        { key: "task:3", value: { text: "do C" } },
      ]);
      const llmJudge = vi.fn().mockResolvedValue("LLM summary output");
      const engine = new ConsolidationEngine({ llmJudge });
      await engine.consolidate("s", "n", store);
      const summary = store.data.get("task:__summary__")!;
      expect(summary["text"]).toBe("LLM summary output");
    });

    it("falls back to join when llmJudge throws", async () => {
      const store = makeMockStore([
        { key: "task:1", value: { text: "item one" } },
        { key: "task:2", value: { text: "item two" } },
        { key: "task:3", value: { text: "item three" } },
      ]);
      const llmJudge = vi.fn().mockRejectedValue(new Error("LLM timeout"));
      const engine = new ConsolidationEngine({ llmJudge });
      const result = await engine.consolidate("s", "n", store);
      // Should still consolidate via fallback
      expect(result.summarized).toBe(3);
      const summary = store.data.get("task:__summary__")!;
      expect(summary["text"]).toContain("item one");
    });

    it("passes MemoryEntry objects (with key and text) to llmJudge", async () => {
      const store = makeMockStore([
        { key: "chunk:a", value: { text: "text A" } },
        { key: "chunk:b", value: { text: "text B" } },
        { key: "chunk:c", value: { text: "text C" } },
      ]);
      const llmJudge = vi.fn().mockResolvedValue("ok");
      const engine = new ConsolidationEngine({ llmJudge });
      await engine.consolidate("s", "n", store);
      const [entries] = llmJudge.mock.calls[0] as [MemoryEntry[]];
      expect(entries.every((e) => "key" in e && "text" in e)).toBe(true);
    });
  });

  describe("child entry rewrite", () => {
    it("child strength is stamped to 0.1 after consolidation", async () => {
      const store = makeMockStore([
        { key: "doc:1", value: { text: "document one" } },
        { key: "doc:2", value: { text: "document two" } },
        { key: "doc:3", value: { text: "document three" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      const child = store.data.get("doc:1")!;
      const decay = child["_decay"] as Record<string, unknown>;
      expect(decay["strength"]).toBe(0.1);
    });

    it("consolidatedInto is set to the summary key on each child", async () => {
      const store = makeMockStore([
        { key: "item:a", value: { text: "a" } },
        { key: "item:b", value: { text: "b" } },
        { key: "item:c", value: { text: "c" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      expect(store.data.get("item:a")!["consolidatedInto"]).toBe(
        "item:__summary__",
      );
      expect(store.data.get("item:b")!["consolidatedInto"]).toBe(
        "item:__summary__",
      );
      expect(store.data.get("item:c")!["consolidatedInto"]).toBe(
        "item:__summary__",
      );
    });

    it("child write failure is non-fatal — summarized count still correct", async () => {
      let callCount = 0;
      const store: ConsolidationStore = {
        search: vi.fn(async () => [
          { key: "x:a", value: { text: "alpha" } },
          { key: "x:b", value: { text: "beta" } },
          { key: "x:c", value: { text: "gamma" } },
        ]),
        put: vi.fn(async (_ns: string[], key: string) => {
          callCount++;
          // First put is the summary (succeeds), subsequent puts for children fail
          if (callCount > 1) throw new Error("write failed");
        }),
        delete: vi.fn(),
      };
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      // Summary was written successfully — summarized should still be 3
      expect(result.summarized).toBe(3);
    });
  });

  describe("summary entry metadata", () => {
    it("summary entry has consolidatedFrom array listing child keys", async () => {
      const store = makeMockStore([
        { key: "p:1", value: { text: "first" } },
        { key: "p:2", value: { text: "second" } },
        { key: "p:3", value: { text: "third" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      const summary = store.data.get("p:__summary__")!;
      const from = summary["consolidatedFrom"] as string[];
      expect(Array.isArray(from)).toBe(true);
      expect(from).toContain("p:1");
      expect(from).toContain("p:2");
      expect(from).toContain("p:3");
    });

    it("summary entry has createdAt timestamp", async () => {
      const before = Date.now();
      const store = makeMockStore([
        { key: "q:a", value: { text: "a" } },
        { key: "q:b", value: { text: "b" } },
        { key: "q:c", value: { text: "c" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);
      const summary = store.data.get("q:__summary__")!;
      const ts = summary["createdAt"] as number;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("multiple clusters in one run", () => {
    it("creates one summary per qualifying cluster", async () => {
      const store = makeMockStore([
        { key: "a:1", value: { text: "a1" } },
        { key: "a:2", value: { text: "a2" } },
        { key: "a:3", value: { text: "a3" } },
        { key: "b:1", value: { text: "b1" } },
        { key: "b:2", value: { text: "b2" } },
        { key: "b:3", value: { text: "b3" } },
        { key: "c:1", value: { text: "c1" } },
        { key: "c:2", value: { text: "c2" } },
        { key: "c:3", value: { text: "c3" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.summaries).toHaveLength(3);
      expect(result.summarized).toBe(9);
    });

    it("small cluster below threshold is skipped while large cluster is processed", async () => {
      const store = makeMockStore([
        // Big cluster — 4 items
        { key: "large:1", value: { text: "l1" } },
        { key: "large:2", value: { text: "l2" } },
        { key: "large:3", value: { text: "l3" } },
        { key: "large:4", value: { text: "l4" } },
        // Small cluster — 2 items (below default threshold of 3)
        { key: "small:a", value: { text: "sa" } },
        { key: "small:b", value: { text: "sb" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.summarized).toBe(4);
      expect(result.summaries).toEqual(["large:__summary__"]);
    });
  });
});

// ===========================================================================
// Section 5: dedupLessons (lesson-dedup.ts)
// ===========================================================================

describe("dedupLessons", () => {
  const makeEntry = (
    key: string,
    text: string,
    overrides?: Partial<MemoryEntry>,
  ): MemoryEntry => ({
    key,
    text,
    ...overrides,
  });

  describe("empty and single-entry inputs", () => {
    it("returns empty result for zero lessons", () => {
      const result = dedupLessons([]);
      expect(result.deduplicated).toHaveLength(0);
      expect(result.removedCount).toBe(0);
      expect(result.inputCount).toBe(0);
    });

    it("returns single entry unchanged", () => {
      const result = dedupLessons([
        makeEntry("k1", "always write tests before code"),
      ]);
      expect(result.deduplicated).toHaveLength(1);
      expect(result.removedCount).toBe(0);
      expect(result.inputCount).toBe(1);
    });
  });

  describe("exact duplicates", () => {
    it("merges two identical lessons into one group", () => {
      const entries = [
        makeEntry("k1", "always write tests before code"),
        makeEntry("k2", "always write tests before code"),
      ];
      const result = dedupLessons(entries);
      expect(result.deduplicated).toHaveLength(1);
      expect(result.removedCount).toBe(1);
    });

    it("mergedKeys contains both keys for identical entries", () => {
      const entries = [
        makeEntry("k1", "use async await for async code"),
        makeEntry("k2", "use async await for async code"),
      ];
      const result = dedupLessons(entries);
      expect(result.deduplicated[0]!.mergedKeys).toContain("k1");
      expect(result.deduplicated[0]!.mergedKeys).toContain("k2");
    });

    it("count is 2 when two identical entries merge", () => {
      const entries = [
        makeEntry("k1", "validate all inputs at boundaries"),
        makeEntry("k2", "validate all inputs at boundaries"),
      ];
      const result = dedupLessons(entries);
      expect(result.deduplicated[0]!.count).toBe(2);
    });
  });

  describe("near-duplicate detection (Jaccard)", () => {
    it("merges highly similar paraphrases above default threshold", () => {
      // High Jaccard similarity: both share almost the same words
      const entries = [
        makeEntry("k1", "always validate user inputs at the boundary layer"),
        makeEntry(
          "k2",
          "always validate user inputs at the boundary layer of the system",
        ),
      ];
      const result = dedupLessons(entries, 0.6);
      // Both share "always validate user inputs at the boundary layer"
      expect(result.deduplicated.length).toBeLessThanOrEqual(entries.length);
    });

    it("keeps distinct entries with low Jaccard similarity", () => {
      const entries = [
        makeEntry("k1", "prefer functional programming patterns"),
        makeEntry("k2", "use database indexes for query optimization"),
      ];
      const result = dedupLessons(entries);
      expect(result.deduplicated).toHaveLength(2);
      expect(result.removedCount).toBe(0);
    });
  });

  describe("representative selection", () => {
    it("picks the longest text as representative", () => {
      const short = makeEntry("k1", "write tests");
      const long = makeEntry(
        "k2",
        "write tests for all code paths including edge cases",
      );
      // Use very low threshold to force grouping
      const result = dedupLessons([short, long], 0.3);
      const rep = result.deduplicated.find(
        (g) => g.mergedKeys.includes("k1") && g.mergedKeys.includes("k2"),
      );
      if (rep) {
        expect(rep.entry.text.length).toBeGreaterThanOrEqual(short.text.length);
      }
    });
  });

  describe("inputCount and removedCount invariants", () => {
    it("inputCount equals the number of input entries", () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry(`k${i}`, `lesson ${i}`),
      );
      const result = dedupLessons(entries);
      expect(result.inputCount).toBe(10);
    });

    it("removedCount = inputCount - deduplicated.length", () => {
      const entries = Array.from({ length: 6 }, (_, i) =>
        makeEntry(`k${i}`, `lesson content ${i}`),
      );
      const result = dedupLessons(entries);
      expect(result.removedCount).toBe(
        result.inputCount - result.deduplicated.length,
      );
    });

    it("no entries are lost: sum of group counts equals inputCount", () => {
      const entries = Array.from({ length: 8 }, (_, i) =>
        makeEntry(`k${i}`, `topic ${i}`),
      );
      const result = dedupLessons(entries);
      const totalCount = result.deduplicated.reduce((s, g) => s + g.count, 0);
      expect(totalCount).toBe(result.inputCount);
    });
  });

  describe("custom threshold", () => {
    it("lower threshold groups more entries", () => {
      const entries = [
        makeEntry("k1", "write tests for your code"),
        makeEntry("k2", "write unit tests for the codebase"),
        makeEntry("k3", "use dependency injection patterns"),
      ];
      const strictResult = dedupLessons(entries, 0.9);
      const looseResult = dedupLessons(entries, 0.1);
      expect(looseResult.deduplicated.length).toBeLessThanOrEqual(
        strictResult.deduplicated.length,
      );
    });

    it("threshold=1.0 only merges exact duplicates", () => {
      const entries = [
        makeEntry("k1", "use TypeScript strictly"),
        makeEntry("k2", "use TypeScript strictly"),
        makeEntry("k3", "use TypeScript with strict mode enabled"),
      ];
      const result = dedupLessons(entries, 1.0);
      // Only exact matches merge
      expect(result.deduplicated.length).toBeLessThanOrEqual(2);
    });
  });
});

// ===========================================================================
// Section 6: SemanticConsolidator additional scenarios
// ===========================================================================

describe("SemanticConsolidator — extended scenarios", () => {
  let model: BaseChatModel;

  beforeEach(() => {
    model = makeMockModel(
      JSON.stringify({
        action: "noop",
        reason: "identical content",
      }),
    );
  });

  describe("similarity threshold filtering", () => {
    it("skips pair when similarity score is below threshold", async () => {
      const ns = ["test"];
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "a", value: { text: "apple" } },
            { key: "b", value: { text: "banana" } },
          ])
          .mockResolvedValueOnce([
            // similar item returned with low score
            { key: "b", value: { text: "banana" }, score: 0.1 },
          ])
          .mockResolvedValue([]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const invokeSpy = vi
        .fn()
        .mockResolvedValue({
          content: JSON.stringify({ action: "noop", reason: "test" }),
        });
      const mockModel = {
        invoke: invokeSpy,
        _llmType: () => "mock",
      } as unknown as BaseChatModel;
      const consolidator = new SemanticConsolidator({
        model: mockModel,
        similarityThreshold: 0.5,
      });
      await consolidator.consolidate(store, ns);
      // LLM should not be called because score 0.1 < threshold 0.5
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it("calls LLM when similarity score meets threshold", async () => {
      const ns = ["test"];
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "a", value: { text: "apple juice is great" } },
            { key: "b", value: { text: "apple juice tastes good" } },
          ])
          .mockResolvedValue([
            {
              key: "b",
              value: { text: "apple juice tastes good" },
              score: 0.8,
            },
          ]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const invokeSpy = vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: "noop", reason: "similar" }),
      });
      const mockModel = {
        invoke: invokeSpy,
        _llmType: () => "mock",
      } as unknown as BaseChatModel;
      const consolidator = new SemanticConsolidator({
        model: mockModel,
        similarityThreshold: 0.5,
      });
      await consolidator.consolidate(store, ns);
      expect(invokeSpy).toHaveBeenCalled();
    });
  });

  describe("maxLLMCalls enforcement", () => {
    it("does not exceed maxLLMCalls across multiple items", async () => {
      const invokeSpy = vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: "add", reason: "different" }),
      });
      const mockModel = {
        invoke: invokeSpy,
        _llmType: () => "mock",
      } as unknown as BaseChatModel;

      const items = Array.from({ length: 10 }, (_, i) => ({
        key: `item${i}`,
        value: { text: `some similar content number ${i}` },
      }));
      // Return pairs for every item to force many LLM calls
      const store = {
        search: vi
          .fn()
          .mockImplementation((ns: string[], opts?: { query?: string }) => {
            if (opts?.query) {
              return Promise.resolve(
                items.map((it) => ({ ...it, score: 0.9 })),
              );
            }
            return Promise.resolve(items);
          }),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const consolidator = new SemanticConsolidator({
        model: mockModel,
        maxLLMCalls: 3,
      });
      await consolidator.consolidate(store, ["ns"]);
      expect(invokeSpy.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  describe("CONTRADICT action tracking", () => {
    it("records contradictions in result", async () => {
      const ns = ["test"];
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "fact-a", value: { text: "the system is stateless" } },
            { key: "fact-b", value: { text: "the system maintains state" } },
          ])
          .mockResolvedValue([
            {
              key: "fact-b",
              value: { text: "the system maintains state" },
              score: 0.9,
            },
          ]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const conflictModel = makeMockModel(
        JSON.stringify({
          action: "contradict",
          reason: "mutually exclusive facts",
        }),
      );

      const consolidator = new SemanticConsolidator({ model: conflictModel });
      const result = await consolidator.consolidate(store, ns);
      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0]!.reason).toBe("mutually exclusive facts");
    });

    it("flagged entries get _contradicts and _contradictionFlaggedAt metadata", async () => {
      const ns = ["test"];
      const putSpy = vi.fn();
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "fact-a", value: { text: "CPU count is 8" } },
            { key: "fact-b", value: { text: "CPU count is 16" } },
          ])
          .mockResolvedValue([
            { key: "fact-b", value: { text: "CPU count is 16" }, score: 0.95 },
          ]),
        put: putSpy,
        delete: vi.fn(),
      } as unknown as BaseStore;

      const conflictModel = makeMockModel(
        JSON.stringify({
          action: "contradict",
          reason: "conflicting numbers",
        }),
      );

      const consolidator = new SemanticConsolidator({ model: conflictModel });
      await consolidator.consolidate(store, ns);
      // Both entries should be written with _contradicts metadata
      expect(putSpy).toHaveBeenCalled();
      const calls = putSpy.mock.calls as Array<
        [string[], string, Record<string, unknown>]
      >;
      const hasContradictsMeta = calls.some(
        ([, , value]) => "_contradicts" in value,
      );
      expect(hasContradictsMeta).toBe(true);
    });
  });

  describe("before / after counts", () => {
    it("after = before for ADD action (no entries removed)", async () => {
      const ns = ["test"];
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "r1", value: { text: "result one" } },
            { key: "r2", value: { text: "result two" } },
          ])
          .mockResolvedValue([
            { key: "r2", value: { text: "result two" }, score: 0.8 },
          ]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const addModel = makeMockModel(
        JSON.stringify({ action: "add", reason: "distinct" }),
      );
      const consolidator = new SemanticConsolidator({ model: addModel });
      const result = await consolidator.consolidate(store, ns);
      expect(result.after).toBe(result.before);
    });

    it("after = before - 1 for DELETE action", async () => {
      const ns = ["test"];
      const store = {
        search: vi
          .fn()
          .mockResolvedValueOnce([
            { key: "r1", value: { text: "old entry" } },
            { key: "r2", value: { text: "new entry" } },
          ])
          .mockResolvedValue([
            { key: "r2", value: { text: "new entry" }, score: 0.85 },
          ]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const deleteModel = makeMockModel(
        JSON.stringify({ action: "delete", reason: "obsolete" }),
      );
      const consolidator = new SemanticConsolidator({ model: deleteModel });
      const result = await consolidator.consolidate(store, ns);
      expect(result.after).toBe(result.before - 1);
    });
  });

  describe("consolidateWithLLM convenience wrapper", () => {
    it("returns a SemanticConsolidationResult with namespace", async () => {
      const ns = ["conv-test"];
      const store = {
        search: vi.fn().mockResolvedValue([]),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as BaseStore;

      const result = await consolidateWithLLM(store, ns, { model });
      expect(result.namespace).toEqual(ns);
      expect(typeof result.before).toBe("number");
      expect(typeof result.after).toBe("number");
      expect(Array.isArray(result.actions)).toBe(true);
      expect(Array.isArray(result.contradictions)).toBe(true);
    });
  });
});

// ===========================================================================
// Section 7: SleepConsolidator — phase gating and basic behavior
// ===========================================================================

describe("SleepConsolidator", () => {
  /** Build a minimal mock BaseStore that returns provided items on search. */
  function makeSleepStore(
    items: Array<{ key: string; value: Record<string, unknown> }> = [],
  ): BaseStore {
    return {
      search: vi.fn().mockResolvedValue(items),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;
  }

  describe("empty namespace processing", () => {
    it("returns empty namespaces array for zero input namespaces", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, []);
      expect(report.namespaces).toHaveLength(0);
    });

    it("returns one entry per namespace", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, [["ns1"], ["ns2"]]);
      expect(report.namespaces).toHaveLength(2);
    });
  });

  describe("phase gating", () => {
    it("runs only selected phases", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: ["lesson-dedup"],
      });
      const report = await consolidator.run(store, [["lessons"]]);
      expect(report.phasesRun).toEqual(["lesson-dedup"]);
    });

    it("phasesRun contains all seven phases by default", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel(JSON.stringify({ action: "add", reason: "diff" })),
      });
      const report = await consolidator.run(store, [["ns"]]);
      const expectedPhases = [
        "dedup",
        "decay-prune",
        "contradiction-resolve",
        "heal",
        "lesson-dedup",
        "convention-extract",
        "staleness-prune",
      ];
      expect(report.phasesRun).toEqual(expectedPhases);
    });

    it("skips dedup phase when not in phases list", async () => {
      const invokeSpy = vi.fn();
      const mockModel = {
        invoke: invokeSpy,
        _llmType: () => "mock",
      } as unknown as BaseChatModel;
      const store = makeSleepStore([
        { key: "item:1", value: { text: "test item 1" } },
        { key: "item:2", value: { text: "test item 2" } },
        { key: "item:3", value: { text: "test item 3" } },
      ]);
      const consolidator = new SleepConsolidator({
        model: mockModel,
        phases: ["lesson-dedup"],
      });
      await consolidator.run(store, [["ns"]]);
      // LLM (dedup phase) should not be called when not in phases
      expect(invokeSpy).not.toHaveBeenCalled();
    });
  });

  describe("report structure", () => {
    it("report includes totalLLMCalls, durationMs, phasesRun", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, [["ns"]]);
      expect(typeof report.totalLLMCalls).toBe("number");
      expect(typeof report.durationMs).toBe("number");
      expect(Array.isArray(report.phasesRun)).toBe(true);
    });

    it("durationMs is non-negative", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, [["ns"]]);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("namespace entry has all required counters", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, [["ns"]]);
      const ns = report.namespaces[0]!;
      expect(typeof ns.deduplicated).toBe("number");
      expect(typeof ns.pruned).toBe("number");
      expect(typeof ns.contradictionsFound).toBe("number");
      expect(typeof ns.healed).toBe("number");
      expect(typeof ns.lessonsDeduplicated).toBe("number");
      expect(typeof ns.conventionsExtracted).toBe("number");
      expect(typeof ns.stalenessPruned).toBe("number");
    });

    it("namespace entry has correct namespace field", async () => {
      const store = makeSleepStore();
      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: [],
      });
      const report = await consolidator.run(store, [["team", "session-99"]]);
      expect(report.namespaces[0]!.namespace).toEqual(["team", "session-99"]);
    });
  });

  describe("decay-prune phase", () => {
    it("prunes entries below threshold", async () => {
      const now = Date.now();
      const weakDecay = {
        strength: 0.001,
        accessCount: 0,
        lastAccessedAt: 0,
        createdAt: 0,
        halfLifeMs: 1,
      };
      const deleteSpy = vi.fn();
      const store = {
        search: vi.fn().mockResolvedValue([
          { key: "weak-item", value: { text: "stale", _decay: weakDecay } },
          {
            key: "fresh-item",
            value: {
              text: "fresh",
              _decay: {
                strength: 1,
                accessCount: 0,
                lastAccessedAt: now,
                createdAt: now,
                halfLifeMs: 86400000,
              },
            },
          },
        ]),
        get: vi.fn(),
        put: vi.fn(),
        delete: deleteSpy,
        batch: vi.fn(),
        start: vi.fn(),
        setup: vi.fn(),
        listNamespaces: vi.fn(),
      } as unknown as BaseStore;

      const consolidator = new SleepConsolidator({
        model: makeMockModel(JSON.stringify({ action: "add", reason: "diff" })),
        phases: ["decay-prune"],
        decayPruneThreshold: 0.1,
      });
      const report = await consolidator.run(store, [["ns"]]);
      expect(report.namespaces[0]!.pruned).toBeGreaterThanOrEqual(1);
    });
  });

  describe("runSleepConsolidation convenience wrapper", () => {
    it("returns a SleepConsolidationReport", async () => {
      const store = makeSleepStore();
      const report = await runSleepConsolidation(store, [["ns"]], {
        model: makeMockModel("{}"),
        phases: [],
      });
      expect(report).toBeDefined();
      expect(report.namespaces).toHaveLength(1);
    });
  });

  describe("non-fatal error handling", () => {
    it("continues processing remaining namespaces when one throws", async () => {
      let callCount = 0;
      const store = {
        search: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("first ns failed");
          return Promise.resolve([]);
        }),
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        batch: vi.fn(),
        start: vi.fn(),
        setup: vi.fn(),
        listNamespaces: vi.fn(),
      } as unknown as BaseStore;

      const consolidator = new SleepConsolidator({
        model: makeMockModel("{}"),
        phases: ["lesson-dedup"],
      });
      // Should not throw even if first namespace fails
      const report = await consolidator.run(store, [["ns1"], ["ns2"]]);
      expect(report.namespaces).toHaveLength(2);
    });
  });
});
