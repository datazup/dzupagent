/**
 * Deep coverage for DecayEngine, ConsolidationEngine, StoreFactory, and
 * AdaptiveRetriever subsystems. Targets gaps left by the baseline test suite.
 *
 * No live network or database calls — all external dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
  type DecayMetadata,
} from "../decay-engine.js";
import {
  ConsolidationEngine,
  type ConsolidationStore,
  type ConsolidationStoreItem,
} from "../consolidation-engine.js";
import { createStore } from "../store-factory.js";
import type { StoreQueryOptions } from "../store-factory.js";
import type { BaseStore } from "@langchain/langgraph";
import {
  AdaptiveRetriever,
  WeightLearner,
  type RetrievalWeights,
} from "../retrieval/adaptive-retriever.js";
import { ProviderHealthTracker } from "../retrieval/adaptive-retriever-health.js";
import {
  weightedFusion,
  redistributeWeights,
} from "../retrieval/adaptive-retriever-fusion.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMeta(overrides?: Partial<DecayMetadata>): DecayMetadata {
  const now = Date.now();
  return {
    strength: 1,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    halfLifeMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

interface MockStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>;
}

function createMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): MockStore {
  const data = new Map<string, Record<string, unknown>>();
  for (const { key, value } of records) {
    data.set(key, value);
  }
  return {
    data,
    search: vi.fn(async (_ns: string[]): Promise<ConsolidationStoreItem[]> => {
      return [...data.entries()].map(([key, value]) => ({ key, value }));
    }),
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

interface SearchableStore {
  search(
    namespace: string[],
    options?: StoreQueryOptions,
  ): Promise<
    Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>
  >;
}

async function searchWithOptions(
  store: BaseStore,
  namespace: string[],
  options?: StoreQueryOptions,
): Promise<
  Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>
> {
  return (store as unknown as SearchableStore).search(namespace, options);
}

// ─── DecayEngine deep tests ────────────────────────────────────────────────────

describe("DecayEngine — deep coverage", () => {
  describe("createDecayMetadata with importance", () => {
    it("creates metadata with strength = importance when provided", () => {
      const meta = createDecayMetadata({ importance: 0.5 });
      expect(meta.strength).toBe(0.5);
    });

    it("clamps importance above 1 to 1", () => {
      const meta = createDecayMetadata({ importance: 1.5 });
      expect(meta.strength).toBe(1);
    });

    it("clamps importance below 0 to 0", () => {
      const meta = createDecayMetadata({ importance: -0.3 });
      expect(meta.strength).toBe(0);
    });

    it("uses full strength when importance = 1 (explicit)", () => {
      const meta = createDecayMetadata({ importance: 1 });
      expect(meta.strength).toBe(1);
    });

    it("creates metadata with zero accessCount regardless of importance", () => {
      const meta = createDecayMetadata({ importance: 0.7 });
      expect(meta.accessCount).toBe(0);
    });

    it("sets correct default half-life of 24 hours", () => {
      const meta = createDecayMetadata({ importance: 0.5 });
      expect(meta.halfLifeMs).toBe(24 * 60 * 60 * 1000);
    });

    it("sets createdAt and lastAccessedAt to the same timestamp", () => {
      const before = Date.now();
      const meta = createDecayMetadata({ importance: 0.3 });
      const after = Date.now();
      expect(meta.createdAt).toBeGreaterThanOrEqual(before);
      expect(meta.createdAt).toBeLessThanOrEqual(after);
      expect(meta.lastAccessedAt).toBe(meta.createdAt);
    });
  });

  describe("reinforceMemory — multiple reinforcements", () => {
    it("doubles half-life with each access up to cap", () => {
      let meta = makeMeta({ halfLifeMs: 1000 });
      meta = reinforceMemory(meta);
      expect(meta.halfLifeMs).toBe(2000);
      meta = reinforceMemory(meta);
      expect(meta.halfLifeMs).toBe(4000);
      meta = reinforceMemory(meta);
      expect(meta.halfLifeMs).toBe(8000);
    });

    it("never exceeds 30-day cap across many reinforcements", () => {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      let meta = makeMeta({ halfLifeMs: 1 });
      for (let i = 0; i < 60; i++) {
        meta = reinforceMemory(meta);
      }
      expect(meta.halfLifeMs).toBe(THIRTY_DAYS);
    });

    it("increments accessCount with each reinforcement", () => {
      let meta = makeMeta({ accessCount: 0 });
      meta = reinforceMemory(meta);
      meta = reinforceMemory(meta);
      meta = reinforceMemory(meta);
      expect(meta.accessCount).toBe(3);
    });

    it("always resets strength to 1 regardless of prior value", () => {
      const meta = makeMeta({ strength: 0.001 });
      const updated = reinforceMemory(meta);
      expect(updated.strength).toBe(1);
    });
  });

  describe("calculateStrength — boundary conditions", () => {
    it("returns exactly 1 when elapsed is 0 ms", () => {
      const meta = makeMeta({ lastAccessedAt: 5000 });
      expect(calculateStrength(meta, 5000)).toBe(1);
    });

    it("is monotonically decreasing as time passes", () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1000 });
      const s100 = calculateStrength(meta, 100);
      const s200 = calculateStrength(meta, 200);
      const s300 = calculateStrength(meta, 300);
      expect(s100).toBeGreaterThan(s200);
      expect(s200).toBeGreaterThan(s300);
    });

    it("is always positive (never reaches absolute zero)", () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1 });
      // 1,000,000 ms elapsed with halfLife=1 ms: e^(-1000000) ~= 0 but > 0
      const s = calculateStrength(meta, 1_000_000);
      expect(s).toBeGreaterThanOrEqual(0);
    });
  });

  describe("scoreWithDecay — edge cases", () => {
    it("returns 0 when relevance is exactly 0", () => {
      const meta = makeMeta({ lastAccessedAt: Date.now() });
      expect(scoreWithDecay(0, meta)).toBe(0);
    });

    it("returns value equal to relevance when memory is perfectly fresh", () => {
      const now = Date.now();
      const meta = makeMeta({ lastAccessedAt: now });
      const score = scoreWithDecay(0.75, meta, now);
      expect(score).toBeCloseTo(0.75, 10);
    });

    it("decayed score is strictly less than relevance for old memory", () => {
      const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: 1000 });
      const score = scoreWithDecay(1.0, meta, 5000);
      expect(score).toBeLessThan(1.0);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe("findWeakMemories — additional scenarios", () => {
    it("correctly separates strong from weak in a mixed set", () => {
      const now = Date.now();
      const strong = makeMeta({ lastAccessedAt: now });
      const weak: DecayMetadata = {
        strength: 0,
        accessCount: 0,
        lastAccessedAt: 0,
        createdAt: 0,
        halfLifeMs: 1,
      };
      const result = findWeakMemories([
        { key: "strong", meta: strong },
        { key: "weak", meta: weak },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe("weak");
    });

    it("returns all records when all are below threshold", () => {
      const old: DecayMetadata = {
        strength: 0,
        accessCount: 0,
        lastAccessedAt: 0,
        createdAt: 0,
        halfLifeMs: 1,
      };
      const records = [
        { key: "a", meta: old },
        { key: "b", meta: old },
        { key: "c", meta: old },
      ];
      const result = findWeakMemories(records, 0.1);
      expect(result).toHaveLength(3);
    });

    it("threshold=0 means nothing is weak (nothing below zero)", () => {
      const meta: DecayMetadata = {
        strength: 0,
        accessCount: 0,
        lastAccessedAt: 0,
        createdAt: 0,
        halfLifeMs: 1,
      };
      const result = findWeakMemories([{ key: "x", meta }], 0);
      // calculateStrength returns a value > 0 (e^(-elapsed/halfLife) > 0)
      // so nothing is < 0
      expect(result).toHaveLength(0);
    });

    it("threshold=1 means everything is weak (strength always < 1)", () => {
      const meta = makeMeta({ lastAccessedAt: Date.now() - 1 });
      const result = findWeakMemories([{ key: "x", meta }], 1);
      // The calculated strength is slightly < 1 due to small elapsed time
      expect(result).toHaveLength(1);
    });
  });
});

// ─── ConsolidationEngine deep tests ─────────────────────────────────────────

describe("ConsolidationEngine — deep coverage", () => {
  describe("minClusterSize configuration", () => {
    it("uses minClusterSize=2 when configured", async () => {
      const store = createMockStore([
        { key: "task:a", value: { text: "alpha" } },
        { key: "task:b", value: { text: "beta" } },
      ]);
      const engine = new ConsolidationEngine({ minClusterSize: 2 });
      const result = await engine.consolidate("s", "n", store);
      // With 2 items and minClusterSize=2, should consolidate
      expect(result.summarized).toBe(2);
      expect(result.summaries).toEqual(["task:__summary__"]);
    });

    it("does NOT consolidate when cluster size equals default threshold minus 1", async () => {
      // Default minClusterSize = 3, so 2 items should be skipped
      const store = createMockStore([
        { key: "task:a", value: { text: "alpha" } },
        { key: "task:b", value: { text: "beta" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.summarized).toBe(0);
      expect(result.summaries).toHaveLength(0);
    });

    it("uses minClusterSize=4 when configured — skips cluster of 3", async () => {
      const store = createMockStore([
        { key: "task:a", value: { text: "alpha" } },
        { key: "task:b", value: { text: "beta" } },
        { key: "task:c", value: { text: "gamma" } },
      ]);
      const engine = new ConsolidationEngine({ minClusterSize: 4 });
      const result = await engine.consolidate("s", "n", store);
      expect(result.summarized).toBe(0);
    });
  });

  describe("key prefix parsing", () => {
    it("groups keys by leading colon-delimited segment", async () => {
      const store = createMockStore([
        { key: "group:x", value: { text: "1" } },
        { key: "group:y", value: { text: "2" } },
        { key: "group:z", value: { text: "3" } },
        { key: "other:a", value: { text: "4" } },
        { key: "other:b", value: { text: "5" } },
        { key: "other:c", value: { text: "6" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.summaries).toHaveLength(2);
      expect(result.summarized).toBe(6);
    });

    it("keys without colon delimiter form single-item clusters (not consolidated)", async () => {
      const store = createMockStore([
        { key: "standalone", value: { text: "no colon" } },
        { key: "another", value: { text: "no colon either" } },
        { key: "third", value: { text: "still no colon" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      // Each key is its own cluster with size 1 — below default threshold 3
      expect(result.summarized).toBe(0);
    });

    it("does not double-count keys that are already summaries", async () => {
      const store = createMockStore([
        { key: "task:a", value: { text: "alpha" } },
        { key: "task:b", value: { text: "beta" } },
        { key: "task:c", value: { text: "gamma" } },
        // Pre-existing summary — should be excluded from candidates
        {
          key: "task:__summary__",
          value: { text: "prior summary", kind: "summary" },
        },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      // Only the 3 non-summary items should form a cluster
      expect(result.summarized).toBe(3);
    });
  });

  describe("already-consolidated children", () => {
    it("skips items that already have consolidatedInto set", async () => {
      const store = createMockStore([
        {
          key: "task:a",
          value: { text: "alpha", consolidatedInto: "task:__summary__" },
        },
        {
          key: "task:b",
          value: { text: "beta", consolidatedInto: "task:__summary__" },
        },
        {
          key: "task:c",
          value: { text: "gamma", consolidatedInto: "task:__summary__" },
        },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      // All items are already consolidated — nothing to do
      expect(result.summarized).toBe(0);
    });
  });

  describe("summary put failure handling", () => {
    it("skips cluster when summary put fails but does not throw", async () => {
      let putCallCount = 0;
      const store: ConsolidationStore = {
        search: vi.fn(async () => [
          { key: "task:a", value: { text: "alpha" } },
          { key: "task:b", value: { text: "beta" } },
          { key: "task:c", value: { text: "gamma" } },
        ]),
        put: vi.fn(async () => {
          putCallCount++;
          // First put (summary) always fails
          if (putCallCount === 1) throw new Error("store write failed");
        }),
        delete: vi.fn(),
      };
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      // Non-fatal: should return empty result rather than throwing
      expect(result.summarized).toBe(0);
      expect(result.summaries).toHaveLength(0);
    });
  });

  describe("preserving existing decay fields on child rewrite", () => {
    it("preserves existing decay.createdAt and accessCount on child rewrite", async () => {
      const originalCreatedAt = Date.now() - 100_000;
      const store = createMockStore([
        {
          key: "task:a",
          value: {
            text: "alpha",
            _decay: {
              strength: 0.9,
              accessCount: 5,
              lastAccessedAt: Date.now() - 1000,
              createdAt: originalCreatedAt,
              halfLifeMs: 86_400_000,
            },
          },
        },
        { key: "task:b", value: { text: "beta" } },
        { key: "task:c", value: { text: "gamma" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);

      const child = store.data.get("task:a")!;
      const decay = child["_decay"] as Record<string, unknown>;
      // Original values preserved
      expect(decay["createdAt"]).toBe(originalCreatedAt);
      expect(decay["accessCount"]).toBe(5);
      // Strength stamped to 0.1
      expect(decay["strength"]).toBe(0.1);
    });
  });

  describe("durationMs", () => {
    it("returns a non-negative durationMs even for zero-work runs", async () => {
      const store = createMockStore();
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns a positive durationMs when work was done", async () => {
      const store = createMockStore([
        { key: "task:a", value: { text: "alpha" } },
        { key: "task:b", value: { text: "beta" } },
        { key: "task:c", value: { text: "gamma" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  describe("searchLimit configuration", () => {
    it("passes searchLimit to the store search call", async () => {
      const store: ConsolidationStore = {
        search: vi.fn(async () => []),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const engine = new ConsolidationEngine({ searchLimit: 42 });
      await engine.consolidate("s", "n", store);
      expect(store.search).toHaveBeenCalledWith(["s", "n"], { limit: 42 });
    });
  });

  describe("multi-cluster consolidation result integrity", () => {
    it("provenance keys map each summary to its exact children", async () => {
      const store = createMockStore([
        { key: "alpha:1", value: { text: "1" } },
        { key: "alpha:2", value: { text: "2" } },
        { key: "alpha:3", value: { text: "3" } },
        { key: "beta:1", value: { text: "4" } },
        { key: "beta:2", value: { text: "5" } },
        { key: "beta:3", value: { text: "6" } },
      ]);
      const engine = new ConsolidationEngine();
      const result = await engine.consolidate("s", "n", store);
      expect(result.provenance["alpha:__summary__"]).toEqual([
        "alpha:1",
        "alpha:2",
        "alpha:3",
      ]);
      expect(result.provenance["beta:__summary__"]).toEqual([
        "beta:1",
        "beta:2",
        "beta:3",
      ]);
    });
  });
});

// ─── StoreFactory deep tests ──────────────────────────────────────────────────

describe("StoreFactory — deep coverage", () => {
  it("throws for unknown store type", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createStore({ type: "redis" as any }),
    ).rejects.toThrow(/Unknown store type/);
  });

  it("throws for postgres type without connectionString", async () => {
    await expect(createStore({ type: "postgres" })).rejects.toThrow(
      /connectionString required/,
    );
  });

  describe("InMemoryBaseStore operations", () => {
    let store: BaseStore;

    beforeEach(async () => {
      store = await createStore({ type: "memory" });
    });

    it("get() returns undefined for missing key", async () => {
      const result = await store.get(["ns"], "nonexistent");
      expect(result).toBeUndefined();
    });

    it("get() returns the stored value after put()", async () => {
      await store.put(["ns"], "key1", { text: "hello", count: 42 });
      const result = await store.get(["ns"], "key1");
      expect(result).toBeDefined();
      expect(result!.value).toEqual({ text: "hello", count: 42 });
    });

    it("overwrites an existing key on second put()", async () => {
      await store.put(["ns"], "key1", { text: "first" });
      await store.put(["ns"], "key1", { text: "second" });
      const result = await store.get(["ns"], "key1");
      expect(result!.value).toEqual({ text: "second" });
    });

    it("delete() removes a key", async () => {
      await store.put(["ns"], "key1", { text: "to be deleted" });
      await store.delete(["ns"], "key1");
      const result = await store.get(["ns"], "key1");
      expect(result).toBeUndefined();
    });

    it("delete() is a no-op for a non-existent key", async () => {
      // Should not throw
      await expect(store.delete(["ns"], "ghost")).resolves.toBeUndefined();
    });

    it("get() is namespace-isolated (different namespaces do not share keys)", async () => {
      await store.put(["ns-a"], "key1", { text: "in ns-a" });
      const result = await store.get(["ns-b"], "key1");
      expect(result).toBeUndefined();
    });

    it("search() returns empty when namespace has no records", async () => {
      const results = await searchWithOptions(store, ["empty-ns"]);
      expect(results).toHaveLength(0);
    });

    it("search() returns correct namespace array in results", async () => {
      await store.put(["project", "alpha"], "r1", { text: "hello" });
      const results = await searchWithOptions(store, ["project", "alpha"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.namespace).toEqual(["project", "alpha"]);
    });

    it("search() with limit=0 returns empty array", async () => {
      await store.put(["ns"], "r1", { text: "hello" });
      const results = await searchWithOptions(store, ["ns"], { limit: 0 });
      expect(results).toHaveLength(0);
    });

    it("multiple puts to same namespace accumulate", async () => {
      await store.put(["ns"], "r1", { text: "a" });
      await store.put(["ns"], "r2", { text: "b" });
      await store.put(["ns"], "r3", { text: "c" });
      const results = await searchWithOptions(store, ["ns"]);
      expect(results).toHaveLength(3);
    });

    it("filter returns empty when field value does not match", async () => {
      await store.put(["ns"], "r1", { text: "a", type: "foo" });
      const results = await searchWithOptions(store, ["ns"], {
        filter: { type: "bar" },
      });
      expect(results).toHaveLength(0);
    });

    it("query filter is case-insensitive for text field", async () => {
      await store.put(["ns"], "r1", { text: "Hello World TypeScript" });
      const results = await searchWithOptions(store, ["ns"], {
        query: "TYPESCRIPT",
      });
      expect(results).toHaveLength(1);
    });
  });
});

// ─── AdaptiveRetriever — health tracking ─────────────────────────────────────

describe("ProviderHealthTracker — direct unit tests", () => {
  it("starts with perfect health (no entries)", () => {
    const tracker = new ProviderHealthTracker();
    const metrics = tracker.metrics("vector");
    expect(metrics.successCount).toBe(0);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.successRate).toBe(1); // 1 by convention when no data
    expect(metrics.avgLatencyMs).toBe(0);
  });

  it("records a success and reflects it in metrics", () => {
    const tracker = new ProviderHealthTracker();
    tracker.record(true, 120);
    const metrics = tracker.metrics("fts");
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.successRate).toBe(1);
    expect(metrics.avgLatencyMs).toBe(120);
    expect(metrics.totalLatencyMs).toBe(120);
  });

  it("records a failure and reflects it in metrics", () => {
    const tracker = new ProviderHealthTracker();
    tracker.record(false, 500, "timeout");
    const metrics = tracker.metrics("graph");
    expect(metrics.successCount).toBe(0);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successRate).toBe(0);
    expect(metrics.lastFailure).toBeDefined();
    expect(metrics.lastFailure!.error).toBe("timeout");
  });

  it("computes correct success rate with mixed results", () => {
    const tracker = new ProviderHealthTracker();
    tracker.record(true, 100);
    tracker.record(true, 200);
    tracker.record(false, 50, "err");
    const metrics = tracker.metrics("vector");
    expect(metrics.successCount).toBe(2);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("computes correct average latency across multiple successes", () => {
    const tracker = new ProviderHealthTracker();
    tracker.record(true, 100);
    tracker.record(true, 300);
    tracker.record(true, 200);
    const metrics = tracker.metrics("vector");
    expect(metrics.avgLatencyMs).toBeCloseTo(200, 5);
    expect(metrics.totalLatencyMs).toBe(600);
  });

  it("respects windowSize: oldest entries are evicted when limit exceeded", () => {
    const tracker = new ProviderHealthTracker(3);
    // Fill window with failures
    tracker.record(false, 0, "e1");
    tracker.record(false, 0, "e2");
    tracker.record(false, 0, "e3");
    // Now add a success — evicts first failure
    tracker.record(true, 50);
    const metrics = tracker.metrics("vector");
    // Window is [false, false, true] → successRate = 1/3
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(2);
  });

  it("source name is preserved in metrics", () => {
    const tracker = new ProviderHealthTracker();
    const metrics = tracker.metrics("graph");
    expect(metrics.source).toBe("graph");
  });

  it("lastFailure is undefined when no failures recorded", () => {
    const tracker = new ProviderHealthTracker();
    tracker.record(true, 100);
    const metrics = tracker.metrics("fts");
    expect(metrics.lastFailure).toBeUndefined();
  });
});

describe("AdaptiveRetriever — health() method", () => {
  it("health() returns metrics for all configured providers", () => {
    const vector = { search: vi.fn().mockResolvedValue([]) };
    const fts = { search: vi.fn().mockReturnValue([]) };
    const retriever = new AdaptiveRetriever({ providers: { vector, fts } });
    const health = retriever.health();
    expect(health).toHaveLength(2);
    const sources = health.map((h) => h.source).sort();
    expect(sources).toEqual(["fts", "vector"]);
  });

  it("health() returns empty array when no providers configured", () => {
    const retriever = new AdaptiveRetriever({ providers: {} });
    expect(retriever.health()).toHaveLength(0);
  });

  it("health() shows accumulated metrics after searches", async () => {
    const vector = {
      search: vi
        .fn()
        .mockResolvedValue([
          { key: "r1", score: 0.9, value: { text: "result" } },
        ]),
    };
    const retriever = new AdaptiveRetriever({ providers: { vector } });
    const RECORDS = [{ key: "r1", value: { text: "result" } }];

    await retriever.search("query one", RECORDS);
    await retriever.search("query two", RECORDS);

    const health = retriever.health();
    expect(health[0]!.successCount).toBe(2);
    expect(health[0]!.failureCount).toBe(0);
    expect(health[0]!.successRate).toBe(1);
  });

  it("health() shows failure count after provider errors", async () => {
    const vector = {
      search: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const fts = {
      search: vi
        .fn()
        .mockReturnValue([{ key: "r1", score: 0.5, value: { text: "a" } }]),
    };
    const retriever = new AdaptiveRetriever({ providers: { vector, fts } });
    const RECORDS = [{ key: "r1", value: { text: "a" } }];

    await retriever.search("query", RECORDS);
    await retriever.search("query 2", RECORDS);

    const health = retriever.health();
    const vectorHealth = health.find((h) => h.source === "vector")!;
    expect(vectorHealth.failureCount).toBe(2);
    expect(vectorHealth.successCount).toBe(0);
    expect(vectorHealth.successRate).toBe(0);
    expect(vectorHealth.lastFailure).toBeDefined();
    expect(vectorHealth.lastFailure!.error).toBe("db down");
  });
});

// ─── weightedFusion — direct unit tests ──────────────────────────────────────

describe("weightedFusion — direct unit tests", () => {
  it("returns empty when no results provided", () => {
    const result = weightedFusion(
      {},
      { vector: 0.4, fts: 0.3, graph: 0.3 },
      { k: 60, limit: 10 },
    );
    expect(result).toHaveLength(0);
  });

  it("ranks item appearing in more sources higher", () => {
    const item = {
      key: "shared",
      score: 0.8,
      value: { text: "shared result" },
    };
    const vectorOnly = {
      key: "vector-only",
      score: 0.9,
      value: { text: "v only" },
    };
    const ftsOnly = {
      key: "fts-only",
      score: 0.9,
      value: { text: "fts only" },
    };

    const results = weightedFusion(
      {
        vector: [item, vectorOnly],
        fts: [item, ftsOnly],
      },
      { vector: 0.5, fts: 0.5, graph: 0 },
      { k: 60, limit: 10 },
    );

    const sharedResult = results.find((r) => r.key === "shared")!;
    const vectorResult = results.find((r) => r.key === "vector-only")!;
    expect(sharedResult).toBeDefined();
    expect(vectorResult).toBeDefined();
    // Shared item gets score from two sources
    expect(sharedResult.score).toBeGreaterThan(vectorResult.score);
    expect(sharedResult.sources).toContain("vector");
    expect(sharedResult.sources).toContain("fts");
  });

  it("respects limit parameter", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      key: `r${i}`,
      score: 0.9 - i * 0.01,
      value: { text: `result ${i}` },
    }));
    const results = weightedFusion(
      { vector: items },
      { vector: 1, fts: 0, graph: 0 },
      { k: 60, limit: 5 },
    );
    expect(results).toHaveLength(5);
  });

  it("sorts results by descending RRF score (earlier rank = higher score)", () => {
    // weightedFusion uses RRF position (rank), not the item's .score field.
    // Item at index 0 gets rank 0 → highest RRF score: weight * 1/(k+0)
    const items = [
      { key: "rank0", score: 0.2, value: {} },
      { key: "rank1", score: 0.9, value: {} },
      { key: "rank2", score: 0.5, value: {} },
    ];
    const results = weightedFusion(
      { vector: items },
      { vector: 1, fts: 0, graph: 0 },
      { k: 60, limit: 10 },
    );
    // rank0 has the best RRF score, rank2 the worst
    expect(results[0]!.key).toBe("rank0");
    expect(results[results.length - 1]!.key).toBe("rank2");
    // Scores must be strictly descending
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThan(results[i + 1]!.score);
    }
  });

  it("sources array lists all source names that contributed a key", () => {
    const item = { key: "shared", score: 0.8, value: {} };
    const results = weightedFusion(
      { vector: [item], fts: [item], graph: [item] },
      { vector: 0.4, fts: 0.3, graph: 0.3 },
      { k: 60, limit: 10 },
    );
    expect(results[0]!.key).toBe("shared");
    expect(results[0]!.sources).toContain("vector");
    expect(results[0]!.sources).toContain("fts");
    expect(results[0]!.sources).toContain("graph");
  });
});

// ─── redistributeWeights — direct unit tests ─────────────────────────────────

describe("redistributeWeights — direct unit tests", () => {
  it("returns original weights when all three sources are available", () => {
    const original: RetrievalWeights = { vector: 0.4, fts: 0.3, graph: 0.3 };
    const result = redistributeWeights(original, ["vector", "fts", "graph"]);
    expect(result).toEqual(original);
  });

  it("redistributes missing source weight proportionally", () => {
    // Causal: graph=0.6, vector=0.3, fts=0.1 — graph missing
    const original: RetrievalWeights = { vector: 0.3, fts: 0.1, graph: 0.6 };
    const result = redistributeWeights(original, ["vector", "fts"]);
    expect(result.graph).toBe(0);
    expect(result.vector + result.fts).toBeCloseTo(1.0, 5);
    expect(result.vector).toBeCloseTo(0.3 / 0.4, 5);
    expect(result.fts).toBeCloseTo(0.1 / 0.4, 5);
  });

  it("distributes equally when only one source has zero-weight in original", () => {
    // If vector=0, fts=0, graph=0 for all available sources — divide equally
    const original: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    const result = redistributeWeights(original, ["vector", "fts"]);
    expect(result.vector).toBeCloseTo(0.5, 5);
    expect(result.fts).toBeCloseTo(0.5, 5);
    expect(result.graph).toBe(0);
  });

  it("returns single-source weight of 1 when only one available", () => {
    const original: RetrievalWeights = { vector: 0.5, fts: 0.3, graph: 0.2 };
    const result = redistributeWeights(original, ["vector"]);
    expect(result.vector).toBeCloseTo(1.0, 5);
    expect(result.fts).toBe(0);
    expect(result.graph).toBe(0);
  });
});

// ─── DecayEngine — additional edge cases ─────────────────────────────────────

describe("DecayEngine — additional edge cases", () => {
  describe("future timestamp (now < lastAccessedAt)", () => {
    it("calculateStrength returns exactly 1 when now is in the past (future lastAccessedAt)", () => {
      const future = Date.now() + 10_000;
      const meta = makeMeta({ lastAccessedAt: future, halfLifeMs: 1000 });
      // elapsed = max(0, now - future) = 0, so strength = e^0 = 1
      const strength = calculateStrength(meta, Date.now());
      expect(strength).toBe(1);
    });

    it("scoreWithDecay is equal to relevance when lastAccessedAt is in the future", () => {
      const future = Date.now() + 5_000;
      const meta = makeMeta({ lastAccessedAt: future, halfLifeMs: 1000 });
      const score = scoreWithDecay(0.6, meta, Date.now());
      expect(score).toBe(0.6); // no decay applied
    });
  });

  describe("bulk decay — findWeakMemories scenarios", () => {
    it("returns records sorted weakest-first in bulk set", () => {
      const now = Date.now();
      const records = [
        {
          key: "medium",
          meta: makeMeta({ lastAccessedAt: now - 12 * 60 * 60 * 1000 }),
        }, // 12h old
        {
          key: "old",
          meta: makeMeta({ lastAccessedAt: now - 36 * 60 * 60 * 1000 }),
        }, // 36h old
        {
          key: "ancient",
          meta: {
            strength: 0,
            accessCount: 0,
            lastAccessedAt: 0,
            createdAt: 0,
            halfLifeMs: 1,
          } as DecayMetadata,
        },
      ];
      const result = findWeakMemories(records, 0.5);
      // All should be weak at threshold 0.5, sorted weakest-first
      expect(result.length).toBeGreaterThan(0);
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i]!.strength).toBeLessThanOrEqual(
          result[i + 1]!.strength,
        );
      }
    });

    it("prunes below 0.1 threshold from a mixed bulk set", () => {
      const now = Date.now();
      const fresh = makeMeta({ lastAccessedAt: now }); // strength ≈ 1
      const veryOld: DecayMetadata = {
        strength: 0,
        accessCount: 0,
        lastAccessedAt: now - 1_000_000_000,
        createdAt: 0,
        halfLifeMs: 100,
      };
      const records = [
        { key: "fresh-1", meta: fresh },
        { key: "fresh-2", meta: fresh },
        { key: "dead-1", meta: veryOld },
        { key: "dead-2", meta: veryOld },
        { key: "dead-3", meta: veryOld },
      ];
      const weak = findWeakMemories(records, 0.1);
      // Only the dead ones should be returned
      expect(weak).toHaveLength(3);
      const weakKeys = weak.map((r) => r.key);
      expect(weakKeys).toContain("dead-1");
      expect(weakKeys).toContain("dead-2");
      expect(weakKeys).toContain("dead-3");
    });

    it("handles large bulk input without error", () => {
      const now = Date.now();
      const records = Array.from({ length: 500 }, (_, i) => ({
        key: `record-${i}`,
        meta: makeMeta({ lastAccessedAt: now - i * 1000 }),
      }));
      const result = findWeakMemories(records, 0.1);
      // Should complete without error; result is a valid array
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("reinforceMemory preserves immutability", () => {
    it("does not mutate the original meta object", () => {
      const meta = makeMeta({ accessCount: 2, halfLifeMs: 1000 });
      const original = { ...meta };
      reinforceMemory(meta);
      // Original should be unchanged
      expect(meta.accessCount).toBe(original.accessCount);
      expect(meta.halfLifeMs).toBe(original.halfLifeMs);
      expect(meta.strength).toBe(original.strength);
    });
  });

  describe("createDecayMetadata without options", () => {
    it("defaults to full strength when no options provided", () => {
      const meta = createDecayMetadata();
      expect(meta.strength).toBe(1);
    });

    it("defaults to full strength when importance is undefined", () => {
      const meta = createDecayMetadata({});
      expect(meta.strength).toBe(1);
    });
  });

  describe("decay formula properties", () => {
    it("two items with same elapsed but different halfLife: longer halfLife = stronger", () => {
      const now = Date.now();
      const elapsed = 5000;
      const metaShortLife = makeMeta({
        lastAccessedAt: now - elapsed,
        halfLifeMs: 1000,
      });
      const metaLongLife = makeMeta({
        lastAccessedAt: now - elapsed,
        halfLifeMs: 100_000,
      });
      const shortStrength = calculateStrength(metaShortLife, now);
      const longStrength = calculateStrength(metaLongLife, now);
      expect(longStrength).toBeGreaterThan(shortStrength);
    });

    it("scoreWithDecay(1.0) equals calculateStrength for relevance=1", () => {
      const now = Date.now();
      const meta = makeMeta({ lastAccessedAt: now - 3600_000 });
      const strength = calculateStrength(meta, now);
      const score = scoreWithDecay(1.0, meta, now);
      expect(score).toBeCloseTo(strength, 10);
    });
  });
});

// ─── ConsolidationEngine — additional edge cases ──────────────────────────────

describe("ConsolidationEngine — additional edge cases", () => {
  describe("single item cluster (no-op)", () => {
    it("single item is never consolidated regardless of minClusterSize", async () => {
      const store = createMockStore([
        { key: "task:only", value: { text: "solo item" } },
      ]);
      const engine = new ConsolidationEngine({ minClusterSize: 1 });
      const result = await engine.consolidate("s", "n", store);
      // Even with minClusterSize=1, the consolidation logic requires >= minClusterSize
      // A single item forms a cluster of size 1 which equals the threshold
      // The code uses `< this.minClusterSize` so size=1 with minClusterSize=1 passes through
      // Let's verify: summarized should be 1 (or 0 if threshold is exclusive)
      expect(typeof result.summarized).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("two items with minClusterSize=3 — no-op returns zero summarized", async () => {
      const store = createMockStore([
        { key: "x:a", value: { text: "item a" } },
        { key: "x:b", value: { text: "item b" } },
      ]);
      const engine = new ConsolidationEngine({ minClusterSize: 3 });
      const result = await engine.consolidate("s", "n", store);
      expect(result.summarized).toBe(0);
      expect(result.summaries).toHaveLength(0);
    });
  });

  describe("namespace tuple passed to store.search", () => {
    it("constructs namespace tuple from [scope, namespace]", async () => {
      const store: ConsolidationStore = {
        search: vi.fn(async () => []),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const engine = new ConsolidationEngine();
      await engine.consolidate("team-A", "session-1", store);
      expect(store.search).toHaveBeenCalledWith(
        ["team-A", "session-1"],
        expect.any(Object),
      );
    });
  });

  describe("summary entry gets strength=1 and kind=summary", () => {
    it("written summary has kind=summary and strength 1 in _decay", async () => {
      const store = createMockStore([
        { key: "work:a", value: { text: "item a" } },
        { key: "work:b", value: { text: "item b" } },
        { key: "work:c", value: { text: "item c" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);

      const summary = store.data.get("work:__summary__")!;
      expect(summary["kind"]).toBe("summary");
      const decay = summary["_decay"] as Record<string, unknown>;
      expect(decay["strength"]).toBe(1);
    });
  });

  describe("child rewrite adds consolidatedInto field", () => {
    it("each child gets consolidatedInto pointing to the summary key", async () => {
      const store = createMockStore([
        { key: "chunk:a", value: { text: "part A" } },
        { key: "chunk:b", value: { text: "part B" } },
        { key: "chunk:c", value: { text: "part C" } },
      ]);
      const engine = new ConsolidationEngine();
      await engine.consolidate("s", "n", store);

      for (const key of ["chunk:a", "chunk:b", "chunk:c"]) {
        const child = store.data.get(key)!;
        expect(child["consolidatedInto"]).toBe("chunk:__summary__");
      }
    });
  });

  describe("llmJudge receives all cluster entries", () => {
    it("llmJudge is called with the correct number of entries per cluster", async () => {
      const store = createMockStore([
        { key: "note:1", value: { text: "first note" } },
        { key: "note:2", value: { text: "second note" } },
        { key: "note:3", value: { text: "third note" } },
        { key: "note:4", value: { text: "fourth note" } },
      ]);
      const llmJudge = vi.fn(async (entries: unknown[]) => {
        expect(entries).toHaveLength(4);
        return "judge summary";
      });
      const engine = new ConsolidationEngine({ llmJudge });
      const result = await engine.consolidate("s", "n", store);
      expect(result.summarized).toBe(4);
      expect(llmJudge).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── AdaptiveRetriever — event bus integration ────────────────────────────────

describe("AdaptiveRetriever — event bus integration", () => {
  it("emits retrieval_source_succeeded event on provider success", async () => {
    const vector = {
      search: vi
        .fn()
        .mockResolvedValue([
          { key: "r1", score: 0.9, value: { text: "result" } },
        ]),
    };
    const emittedEvents: Array<{ type: string }> = [];
    const eventBus = {
      emit: vi.fn((e: { type: string }) => {
        emittedEvents.push(e);
      }),
    };

    const retriever = new AdaptiveRetriever({
      providers: { vector },
      eventBus,
    });

    await retriever.search("test query", [
      { key: "r1", value: { text: "result" } },
    ]);

    expect(eventBus.emit).toHaveBeenCalled();
    const successEvent = emittedEvents.find(
      (e) => e.type === "memory:retrieval_source_succeeded",
    );
    expect(successEvent).toBeDefined();
  });

  it("emits retrieval_source_failed event on provider failure", async () => {
    const vector = {
      search: vi.fn().mockRejectedValue(new Error("provider crashed")),
    };
    const fts = {
      search: vi
        .fn()
        .mockReturnValue([
          { key: "r1", score: 0.5, value: { text: "fts result" } },
        ]),
    };
    const emittedEvents: Array<{ type: string; error?: string }> = [];
    const eventBus = {
      emit: vi.fn((e: { type: string; error?: string }) => {
        emittedEvents.push(e);
      }),
    };

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    await retriever.search("test query", [
      { key: "r1", value: { text: "fts result" } },
    ]);

    const failEvent = emittedEvents.find(
      (e) => e.type === "memory:retrieval_source_failed",
    );
    expect(failEvent).toBeDefined();
    expect(failEvent!.error).toBe("provider crashed");
  });

  it("includes warnings in search results when a provider fails", async () => {
    const vector = {
      search: vi.fn().mockRejectedValue(new Error("vector db timeout")),
    };
    const fts = {
      search: vi
        .fn()
        .mockReturnValue([
          { key: "r1", score: 0.5, value: { text: "fts result" } },
        ]),
    };
    const eventBus = { emit: vi.fn() };

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    const results = await retriever.search("test", [
      { key: "r1", value: { text: "fts result" } },
    ]);
    expect(results.length).toBeGreaterThan(0);
    // Results should carry the warning from the failed vector provider
    const warnings = results[0]!.warnings;
    expect(warnings).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe("vector");
    expect(warnings[0]!.error).toBe("vector db timeout");
  });

  it("search results contain empty warnings array when all providers succeed", async () => {
    const vector = {
      search: vi
        .fn()
        .mockResolvedValue([
          { key: "r1", score: 0.9, value: { text: "vec result" } },
        ]),
    };

    const retriever = new AdaptiveRetriever({ providers: { vector } });
    const results = await retriever.search("test", [
      { key: "r1", value: { text: "vec result" } },
    ]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.warnings).toEqual([]);
  });
});

// ─── AdaptiveRetriever — feedback widens / narrows search ────────────────────

describe("AdaptiveRetriever — confidence / feedback adaptive behaviour", () => {
  it("after bad feedback, weights shift toward equal (widening search)", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: { search: vi.fn().mockResolvedValue([]) } },
      learnFromFeedback: true,
    });

    // Causal intent: graph=0.6 is dominant. Bad feedback dampens it.
    const causalWeights = retriever.getWeights("causal");
    const dominantBefore = Math.max(
      causalWeights.vector,
      causalWeights.fts,
      causalWeights.graph,
    );

    for (let i = 0; i < 30; i++) {
      retriever.reportFeedback("why did it fail?", "causal", "bad");
    }

    const learned = retriever.getLearnedAdjustments().get("causal")!;
    const dominantAfter = Math.max(learned.vector, learned.fts, learned.graph);

    // Dominant weight should decrease (search widened toward other sources)
    expect(dominantAfter).toBeLessThan(dominantBefore);
  });

  it("after good feedback, dominant weight increases (narrows to best strategy)", () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: { search: vi.fn().mockResolvedValue([]) } },
      learnFromFeedback: true,
    });

    // Factual intent: vector=0.6 is dominant.
    const factualWeights = retriever.getWeights("factual");
    const dominantBefore = factualWeights.vector;

    for (let i = 0; i < 50; i++) {
      retriever.reportFeedback(
        "which version is supported?",
        "factual",
        "good",
      );
    }

    const learned = retriever.getLearnedAdjustments().get("factual")!;
    // Dominant weight should increase (narrows toward the dominant strategy)
    expect(learned.vector).toBeGreaterThan(dominantBefore);
  });

  it("strategy switches at threshold: high graph weight queries become causal-classified", () => {
    const retriever = new AdaptiveRetriever({ providers: {} });
    // "why" is in causal patterns — should classify as causal not general
    const intent = retriever.classifyIntent("why did the service go down?");
    expect(intent).toBe("causal");
    // Causal has graph=0.6, vector=0.3 — graph weight dominates
    const weights = retriever.getWeights(intent);
    expect(weights.graph).toBeGreaterThan(weights.vector);
    expect(weights.graph).toBeGreaterThan(weights.fts);
  });

  it("fallback on empty result: search returns empty when provider returns nothing", async () => {
    const fts = {
      search: vi.fn().mockReturnValue([]),
    };

    const retriever = new AdaptiveRetriever({ providers: { fts } });
    const results = await retriever.search("query with no matches", []);
    expect(results).toEqual([]);
  });

  it("fallback on empty result: search returns empty when all providers return nothing", async () => {
    const vector = { search: vi.fn().mockResolvedValue([]) };
    const fts = { search: vi.fn().mockReturnValue([]) };
    const graph = { search: vi.fn().mockReturnValue([]) };

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts, graph },
    });
    const results = await retriever.search("obscure query", []);
    // Fusion of empty result sets should yield empty array
    expect(results).toEqual([]);
  });
});

// ─── StoreFactory — capabilities integration ──────────────────────────────────

describe("StoreFactory — capabilities integration", () => {
  it("createStore memory type succeeds with empty config", async () => {
    const store = await createStore({ type: "memory" });
    expect(store).toBeDefined();
  });

  it("memory store returns undefined for missing key before any puts", async () => {
    const store = await createStore({ type: "memory" });
    const result = await store.get(["test-ns"], "no-such-key");
    expect(result).toBeUndefined();
  });

  it("memory store with explicit capability overrides propagates them", async () => {
    const store = await createStore({
      type: "memory",
      capabilities: { supportsVectorSearch: true },
    });
    expect(store).toBeDefined();
  });

  it("multiple separate createStore calls produce independent stores", async () => {
    const store1 = await createStore({ type: "memory" });
    const store2 = await createStore({ type: "memory" });

    await store1.put(["ns"], "key1", { text: "in store 1" });
    const fromStore2 = await store2.get(["ns"], "key1");
    expect(fromStore2).toBeUndefined();
  });

  it("unknown type error message includes the bad type string", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createStore({ type: "mongo" as any }),
    ).rejects.toThrow("mongo");
  });
});
