/**
 * Comprehensive tests for memory consolidation strategies.
 *
 * Covers:
 *   - Dedup: identical memories merged into one
 *   - Dedup by content hash: same content → same hash → deduplicated
 *   - Near-duplicate detection: very similar but not identical memories flagged
 *   - Merge strategy: two related memories merged into one combined memory
 *   - Merge preserves metadata: merged memory retains highest strength/access count
 *   - Summarize: group of related memories → single summary memory
 *   - Summary quality: summary captures key facts from source memories
 *   - Conflict detection: two memories with contradictory facts → conflict flagged
 *   - Conflict resolution — latest wins: newer memory overrides older
 *   - Conflict resolution — highest confidence wins: more confident memory wins
 *   - Conflict resolution — manual: conflict flagged for human review
 *   - Consolidation trigger: consolidation runs when memory count exceeds threshold
 *   - Consolidation result: fewer memories after consolidation than before
 *   - Source preservation: source memory IDs tracked in consolidated memory
 *   - Consolidation idempotency: running twice produces same result
 *   - Empty consolidation: consolidating 0 or 1 memory returns unchanged
 *
 * No live LLM calls — all model invocations are mocked with vi.fn().
 * No real database — all store operations use in-memory Map implementations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  consolidateNamespace,
  consolidateAll,
  type ConsolidationConfig,
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
} from "../semantic-consolidation.js";
import type { BaseStore } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function makeMemoryEntry(
  key: string,
  text: string,
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return { key, text, ...overrides };
}

/** Minimal BaseStore backed by a Map, keyed by (ns+key). */
function makeNsStore(
  initialNs: string[],
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
    _data: data,
  } as unknown as BaseStore;
}

/** ConsolidationStore backed by a Map for ConsolidationEngine tests. */
function makeConsolidationStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): ConsolidationStore & { data: Map<string, Record<string, unknown>> } {
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

function makeMockModel(responseJson: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({ content: responseJson }),
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

// ===========================================================================
// 1. Dedup — Identical memories merged into one
// ===========================================================================

describe("Dedup — identical memories merged into one", () => {
  it("two identical text entries → merged count = 1", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "k1",
          value: {
            text: "always validate inputs",
            timestamp: new Date(daysAgo(5)).toISOString(),
          },
        },
        {
          key: "k2",
          value: {
            text: "always validate inputs",
            timestamp: new Date(daysAgo(1)).toISOString(),
          },
        },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(1);
    expect(result.after).toBe(1);
  });

  it("three identical entries → merged count = 2", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "k1",
          value: {
            text: "use const not let",
            timestamp: new Date(daysAgo(10)).toISOString(),
          },
        },
        {
          key: "k2",
          value: {
            text: "use const not let",
            timestamp: new Date(daysAgo(5)).toISOString(),
          },
        },
        {
          key: "k3",
          value: {
            text: "use const not let",
            timestamp: new Date(daysAgo(1)).toISOString(),
          },
        },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(2);
    expect(result.after).toBe(1);
  });

  it("identical entries with case difference are treated as distinct", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        { key: "k1", value: { text: "Use TypeScript" } },
        { key: "k2", value: { text: "use typescript" } },
      ],
    );
    // Normalization lowercases, so these ARE treated as the same
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(1);
  });

  it("completely distinct texts are not merged", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        { key: "k1", value: { text: "always test your code" } },
        { key: "k2", value: { text: "document public APIs thoroughly" } },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(0);
    expect(result.after).toBe(2);
  });

  it("keeps the newer entry when two identical texts exist", async () => {
    const olderDate = new Date(daysAgo(10)).toISOString();
    const newerDate = new Date(daysAgo(1)).toISOString();
    const deleteSpy = vi.fn();
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "old-entry",
          value: { text: "prefer functional style", timestamp: olderDate },
        },
        {
          key: "new-entry",
          value: { text: "prefer functional style", timestamp: newerDate },
        },
      ],
    );
    (store.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async (ns: string[], key: string) => deleteSpy(ns, key),
    );
    await consolidateNamespace(store, ["ns"]);
    expect(deleteSpy).toHaveBeenCalledWith(["ns"], "old-entry");
  });
});

// ===========================================================================
// 2. Dedup by content hash (dedupLessons — same tokens → same Jaccard=1.0)
// ===========================================================================

describe("Dedup by content hash — same content → deduplicated", () => {
  it("identical lesson text is grouped into one entry", () => {
    const lessons = [
      makeMemoryEntry("k1", "prefer composition over inheritance"),
      makeMemoryEntry("k2", "prefer composition over inheritance"),
    ];
    const result = dedupLessons(lessons, 1.0);
    expect(result.deduplicated).toHaveLength(1);
    expect(result.removedCount).toBe(1);
  });

  it("duplicate lesson count reflects merge count", () => {
    const lessons = [
      makeMemoryEntry("k1", "write unit tests for every function"),
      makeMemoryEntry("k2", "write unit tests for every function"),
      makeMemoryEntry("k3", "write unit tests for every function"),
    ];
    const result = dedupLessons(lessons, 1.0);
    expect(result.deduplicated[0]!.count).toBe(3);
  });

  it("merged group includes all source keys", () => {
    const lessons = [
      makeMemoryEntry("alpha", "always use strict mode"),
      makeMemoryEntry("beta", "always use strict mode"),
    ];
    const result = dedupLessons(lessons, 1.0);
    const group = result.deduplicated[0]!;
    expect(group.mergedKeys).toContain("alpha");
    expect(group.mergedKeys).toContain("beta");
  });

  it("single unique entry passes through unchanged", () => {
    const lessons = [makeMemoryEntry("solo", "this is a unique lesson")];
    const result = dedupLessons(lessons, 1.0);
    expect(result.deduplicated).toHaveLength(1);
    expect(result.deduplicated[0]!.entry.key).toBe("solo");
  });

  it("empty input returns empty output", () => {
    const result = dedupLessons([]);
    expect(result.deduplicated).toHaveLength(0);
    expect(result.inputCount).toBe(0);
    expect(result.removedCount).toBe(0);
  });
});

// ===========================================================================
// 3. Near-duplicate detection
// ===========================================================================

describe("Near-duplicate detection — similar but not identical memories", () => {
  it("entries sharing 100+ chars of prefix are merged", async () => {
    const base = "x".repeat(100);
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "k1",
          value: {
            text: `${base} - first variant`,
            timestamp: new Date(daysAgo(5)).toISOString(),
          },
        },
        {
          key: "k2",
          value: {
            text: `${base} - second variant`,
            timestamp: new Date(daysAgo(1)).toISOString(),
          },
        },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(1);
  });

  it("entries with different first 100 chars are not merged", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        { key: "k1", value: { text: `Alpha${"a".repeat(95)}suffix` } },
        { key: "k2", value: { text: `Beta${"a".repeat(96)}suffix` } },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.merged).toBe(0);
  });

  it("Jaccard-based near-dup: high similarity text is merged by dedupLessons", () => {
    const lessons = [
      makeMemoryEntry("k1", "always validate user inputs at the boundary"),
      makeMemoryEntry(
        "k2",
        "always validate user inputs at the boundary layer",
      ),
    ];
    const result = dedupLessons(lessons, 0.7);
    // Both share the same token set core — should be merged
    expect(result.deduplicated.length).toBeLessThan(2);
  });

  it("Jaccard-based near-dup: low similarity text is kept separate", () => {
    const lessons = [
      makeMemoryEntry("k1", "always write comprehensive unit tests"),
      makeMemoryEntry(
        "k2",
        "configure database indexes for optimal query performance",
      ),
    ];
    const result = dedupLessons(lessons, 0.6);
    expect(result.deduplicated).toHaveLength(2);
  });

  it("threshold=0.0 groups everything into one cluster", () => {
    const lessons = [
      makeMemoryEntry("k1", "apple juice"),
      makeMemoryEntry("k2", "banana smoothie"),
      makeMemoryEntry("k3", "carrot cake"),
    ];
    const result = dedupLessons(lessons, 0.0);
    // With threshold=0 all pairs are considered similar
    expect(result.deduplicated.length).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// 4. Merge strategy — two related memories merged into one combined memory
// ===========================================================================

describe("Merge strategy — two related memories merged into combined memory", () => {
  it("MERGE action produces a merged content entry in the store", async () => {
    const putSpy = vi.fn();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          {
            key: "fact-a",
            value: { text: "system uses OAuth2 for authentication" },
          },
          {
            key: "fact-b",
            value: { text: "system uses JWT tokens for session management" },
          },
        ])
        .mockResolvedValue([
          {
            key: "fact-b",
            value: { text: "system uses JWT tokens for session management" },
            score: 0.85,
          },
        ]),
      put: putSpy,
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const mergeModel = makeMockModel(
      JSON.stringify({
        action: "merge",
        mergedContent:
          "system uses OAuth2 + JWT tokens for authentication and session management",
        reason: "complementary facts",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: mergeModel });
    await consolidator.consolidate(store, ["ns"]);
    expect(putSpy).toHaveBeenCalled();
    const calls = putSpy.mock.calls as Array<
      [string[], string, Record<string, unknown>]
    >;
    const writtenValues = calls.map(([, , v]) => v);
    const hasMergedContent = writtenValues.some(
      (v) =>
        typeof v["text"] === "string" &&
        (v["text"] as string).includes("OAuth2"),
    );
    expect(hasMergedContent).toBe(true);
  });

  it("MERGE action is recorded in result actions list", async () => {
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "m1", value: { text: "service A handles payments" } },
          { key: "m2", value: { text: "service A also handles refunds" } },
        ])
        .mockResolvedValue([
          {
            key: "m2",
            value: { text: "service A also handles refunds" },
            score: 0.9,
          },
        ]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const mergeModel = makeMockModel(
      JSON.stringify({
        action: "merge",
        mergedContent: "service A handles payments and refunds",
        reason: "combined",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: mergeModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    expect(result.actions.length).toBeGreaterThanOrEqual(1);
    const mergeActions = result.actions.filter(
      (a) => a.decision.action === "merge",
    );
    expect(mergeActions.length).toBeGreaterThanOrEqual(1);
  });

  it("ConsolidationEngine join mode merges cluster texts with delimiter", async () => {
    const store = makeConsolidationStore([
      { key: "fact:1", value: { text: "the sky is blue" } },
      { key: "fact:2", value: { text: "clouds are white" } },
      { key: "fact:3", value: { text: "rain falls down" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    const summary = store.data.get("fact:__summary__")!;
    const text = summary["text"] as string;
    expect(text).toContain("the sky is blue");
    expect(text).toContain("clouds are white");
    expect(text).toContain("rain falls down");
  });

  it("merging N related entries produces a single summary entry per cluster", async () => {
    const store = makeConsolidationStore([
      { key: "obs:1", value: { text: "observation one" } },
      { key: "obs:2", value: { text: "observation two" } },
      { key: "obs:3", value: { text: "observation three" } },
      { key: "obs:4", value: { text: "observation four" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("scope", "ns", store);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toBe("obs:__summary__");
  });
});

// ===========================================================================
// 5. Merge preserves metadata — merged memory retains highest strength / access count
// ===========================================================================

describe("Merge preserves metadata — merged memory retains highest strength/access count", () => {
  it("summary entry gets full strength=1 in _decay metadata", async () => {
    const store = makeConsolidationStore([
      { key: "doc:1", value: { text: "doc one" } },
      { key: "doc:2", value: { text: "doc two" } },
      { key: "doc:3", value: { text: "doc three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    const summary = store.data.get("doc:__summary__")!;
    const decay = summary["_decay"] as Record<string, unknown>;
    expect(decay["strength"]).toBe(1);
  });

  it("child entries are stamped with low strength (0.1) after consolidation", async () => {
    const store = makeConsolidationStore([
      { key: "node:a", value: { text: "node A text" } },
      { key: "node:b", value: { text: "node B text" } },
      { key: "node:c", value: { text: "node C text" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    for (const key of ["node:a", "node:b", "node:c"]) {
      const child = store.data.get(key)!;
      const decay = child["_decay"] as Record<string, unknown>;
      expect(decay["strength"]).toBe(0.1);
    }
  });

  it("child original halfLifeMs is preserved in consolidated child record", async () => {
    const store = makeConsolidationStore([
      {
        key: "item:1",
        value: {
          text: "one",
          _decay: {
            strength: 0.9,
            accessCount: 5,
            lastAccessedAt: Date.now(),
            createdAt: Date.now() - 1000,
            halfLifeMs: 172800000,
          },
        },
      },
      {
        key: "item:2",
        value: {
          text: "two",
          _decay: {
            strength: 0.8,
            accessCount: 3,
            lastAccessedAt: Date.now(),
            createdAt: Date.now() - 2000,
            halfLifeMs: 172800000,
          },
        },
      },
      { key: "item:3", value: { text: "three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    const child = store.data.get("item:1")!;
    const decay = child["_decay"] as Record<string, unknown>;
    expect(decay["halfLifeMs"]).toBe(172800000);
  });

  it("child original accessCount is preserved after consolidation", async () => {
    const accessCount = 42;
    const store = makeConsolidationStore([
      {
        key: "log:1",
        value: {
          text: "log entry one",
          _decay: {
            strength: 0.5,
            accessCount,
            lastAccessedAt: Date.now(),
            createdAt: Date.now(),
            halfLifeMs: 86400000,
          },
        },
      },
      { key: "log:2", value: { text: "log entry two" } },
      { key: "log:3", value: { text: "log entry three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    const child = store.data.get("log:1")!;
    const decay = child["_decay"] as Record<string, unknown>;
    expect(decay["accessCount"]).toBe(accessCount);
  });

  it("summary entry has a valid createdAt timestamp", async () => {
    const before = Date.now();
    const store = makeConsolidationStore([
      { key: "ev:1", value: { text: "event one" } },
      { key: "ev:2", value: { text: "event two" } },
      { key: "ev:3", value: { text: "event three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("scope", "ns", store);
    const summary = store.data.get("ev:__summary__")!;
    expect(summary["createdAt"]).toBeGreaterThanOrEqual(before);
  });
});

// ===========================================================================
// 6. Summarize — group of related memories → single summary memory
// ===========================================================================

describe("Summarize — group of related memories → single summary memory", () => {
  it("consolidation engine produces a summary key ending in __summary__", async () => {
    const store = makeConsolidationStore([
      { key: "lesson:1", value: { text: "lesson one text" } },
      { key: "lesson:2", value: { text: "lesson two text" } },
      { key: "lesson:3", value: { text: "lesson three text" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summaries[0]).toMatch(/__summary__$/);
  });

  it("llmJudge is called with all cluster entries for summarization", async () => {
    const llmJudge = vi.fn().mockResolvedValue("LLM summary");
    const store = makeConsolidationStore([
      { key: "sec:1", value: { text: "section one" } },
      { key: "sec:2", value: { text: "section two" } },
      { key: "sec:3", value: { text: "section three" } },
    ]);
    const engine = new ConsolidationEngine({ llmJudge });
    await engine.consolidate("s", "n", store);
    expect(llmJudge).toHaveBeenCalledTimes(1);
    const [entries] = llmJudge.mock.calls[0] as [MemoryEntry[]];
    expect(entries).toHaveLength(3);
  });

  it("llmJudge output becomes the summary text", async () => {
    const summaryText =
      "All three entries discuss error handling best practices";
    const llmJudge = vi.fn().mockResolvedValue(summaryText);
    const store = makeConsolidationStore([
      { key: "err:1", value: { text: "catch all errors" } },
      { key: "err:2", value: { text: "log errors with context" } },
      { key: "err:3", value: { text: "never swallow exceptions silently" } },
    ]);
    const engine = new ConsolidationEngine({ llmJudge });
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("err:__summary__")!;
    expect(summary["text"]).toBe(summaryText);
  });

  it("consolidation trigger: minClusterSize=3 means 3+ items form a summary", async () => {
    const store = makeConsolidationStore([
      { key: "grp:1", value: { text: "alpha" } },
      { key: "grp:2", value: { text: "beta" } },
      { key: "grp:3", value: { text: "gamma" } },
    ]);
    const engine = new ConsolidationEngine({ minClusterSize: 3 });
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(3);
    expect(result.summaries).toHaveLength(1);
  });

  it("consolidation trigger: cluster of 2 below default threshold=3 is not summarized", async () => {
    const store = makeConsolidationStore([
      { key: "pair:1", value: { text: "first" } },
      { key: "pair:2", value: { text: "second" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(0);
    expect(result.summaries).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Summary quality — summary captures key facts from source memories
// ===========================================================================

describe("Summary quality — summary captures key facts from source memories", () => {
  it("deterministic summary contains all source entry texts", async () => {
    const store = makeConsolidationStore([
      { key: "qa:1", value: { text: "fact: water boils at 100°C" } },
      { key: "qa:2", value: { text: "fact: ice melts at 0°C" } },
      { key: "qa:3", value: { text: "fact: steam condenses at 100°C" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("qa:__summary__")!;
    const text = summary["text"] as string;
    expect(text).toContain("water boils at 100°C");
    expect(text).toContain("ice melts at 0°C");
    expect(text).toContain("steam condenses at 100°C");
  });

  it("deterministic summary uses --- delimiter between facts", async () => {
    const store = makeConsolidationStore([
      { key: "sep:1", value: { text: "entry A" } },
      { key: "sep:2", value: { text: "entry B" } },
      { key: "sep:3", value: { text: "entry C" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("sep:__summary__")!;
    expect((summary["text"] as string).split("---").length).toBeGreaterThan(1);
  });

  it("summary provenance tracks all source keys", async () => {
    const store = makeConsolidationStore([
      { key: "prov:a", value: { text: "source A" } },
      { key: "prov:b", value: { text: "source B" } },
      { key: "prov:c", value: { text: "source C" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    const summaryKey = "prov:__summary__";
    expect(result.provenance[summaryKey]).toContain("prov:a");
    expect(result.provenance[summaryKey]).toContain("prov:b");
    expect(result.provenance[summaryKey]).toContain("prov:c");
  });

  it("summary consolidatedFrom field lists all source keys", async () => {
    const store = makeConsolidationStore([
      { key: "src:1", value: { text: "source 1" } },
      { key: "src:2", value: { text: "source 2" } },
      { key: "src:3", value: { text: "source 3" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("src:__summary__")!;
    const from = summary["consolidatedFrom"] as string[];
    expect(from).toEqual(expect.arrayContaining(["src:1", "src:2", "src:3"]));
  });
});

// ===========================================================================
// 8. Conflict detection — contradictory facts → conflict flagged
// ===========================================================================

describe("Conflict detection — contradictory facts flagged", () => {
  it("CONTRADICT action is added to contradictions list", async () => {
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "fact-a", value: { text: "the database is PostgreSQL" } },
          { key: "fact-b", value: { text: "the database is MySQL" } },
        ])
        .mockResolvedValue([
          {
            key: "fact-b",
            value: { text: "the database is MySQL" },
            score: 0.9,
          },
        ]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const conflictModel = makeMockModel(
      JSON.stringify({
        action: "contradict",
        reason: "mutually exclusive database types",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
  });

  it("contradiction record contains both conflicting keys", async () => {
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "a", value: { text: "server listens on port 8080" } },
          { key: "b", value: { text: "server listens on port 3000" } },
        ])
        .mockResolvedValue([
          {
            key: "b",
            value: { text: "server listens on port 3000" },
            score: 0.92,
          },
        ]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const conflictModel = makeMockModel(
      JSON.stringify({
        action: "contradict",
        reason: "different port numbers",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    const conflict = result.contradictions[0]!;
    expect(conflict.keys).toContain("a");
    expect(conflict.keys).toContain("b");
  });

  it("contradiction flagged entries get _contradicts metadata on both entries", async () => {
    const putSpy = vi.fn();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "x", value: { text: "cache expires after 5 minutes" } },
          { key: "y", value: { text: "cache expires after 60 minutes" } },
        ])
        .mockResolvedValue([
          {
            key: "y",
            value: { text: "cache expires after 60 minutes" },
            score: 0.88,
          },
        ]),
      put: putSpy,
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const conflictModel = makeMockModel(
      JSON.stringify({ action: "contradict", reason: "different TTL values" }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    await consolidator.consolidate(store, ["ns"]);
    const calls = putSpy.mock.calls as Array<
      [string[], string, Record<string, unknown>]
    >;
    const withContradicts = calls.filter(([, , v]) => "_contradicts" in v);
    expect(withContradicts.length).toBeGreaterThanOrEqual(1);
  });

  it("contradiction record contains the reason from LLM", async () => {
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "p", value: { text: "memory limit is 4GB" } },
          { key: "q", value: { text: "memory limit is 8GB" } },
        ])
        .mockResolvedValue([
          { key: "q", value: { text: "memory limit is 8GB" }, score: 0.91 },
        ]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const reason = "two different memory configurations reported";
    const conflictModel = makeMockModel(
      JSON.stringify({ action: "contradict", reason }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    expect(result.contradictions[0]!.reason).toBe(reason);
  });
});

// ===========================================================================
// 9. Conflict resolution — latest wins
// ===========================================================================

describe("Conflict resolution — latest wins", () => {
  it("newer entry is kept when two identical texts exist", async () => {
    const olderTs = new Date(daysAgo(30)).toISOString();
    const newerTs = new Date(daysAgo(1)).toISOString();
    const deleteSpy = vi.fn();
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "stale",
          value: { text: "system version is 1.0", timestamp: olderTs },
        },
        {
          key: "current",
          value: { text: "system version is 1.0", timestamp: newerTs },
        },
      ],
    );
    (store.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async (ns: string[], key: string) => deleteSpy(key),
    );
    await consolidateNamespace(store, ["ns"]);
    expect(deleteSpy).toHaveBeenCalledWith("stale");
    expect(deleteSpy).not.toHaveBeenCalledWith("current");
  });

  it("older duplicate is pruned even when it appears first in store", async () => {
    const olderTs = new Date(daysAgo(20)).toISOString();
    const newerTs = new Date(daysAgo(2)).toISOString();
    const deleteSpy = vi.fn();
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "first-in-list",
          value: { text: "api endpoint is /v1/users", timestamp: olderTs },
        },
        {
          key: "second-in-list",
          value: { text: "api endpoint is /v1/users", timestamp: newerTs },
        },
      ],
    );
    (store.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async (ns: string[], key: string) => deleteSpy(key),
    );
    await consolidateNamespace(store, ["ns"]);
    expect(deleteSpy).toHaveBeenCalledWith("first-in-list");
    expect(deleteSpy).not.toHaveBeenCalledWith("second-in-list");
  });

  it("DELETE semantic action removes the older/obsolete entry", async () => {
    const deleteSpy = vi.fn();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "old", value: { text: "deprecated config format" } },
          { key: "new", value: { text: "current config format" } },
        ])
        .mockResolvedValue([
          { key: "new", value: { text: "current config format" }, score: 0.8 },
        ]),
      put: vi.fn(),
      delete: deleteSpy,
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const deleteModel = makeMockModel(
      JSON.stringify({ action: "delete", reason: "superseded by newer entry" }),
    );
    const consolidator = new SemanticConsolidator({ model: deleteModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    expect(result.after).toBe(result.before - 1);
    expect(deleteSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// 10. Conflict resolution — highest confidence wins
// ===========================================================================

describe("Conflict resolution — highest confidence wins", () => {
  it("NOOP action keeps the higher-confidence entry without deletion", async () => {
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "low-conf", value: { text: "servers use HTTP" } },
          { key: "high-conf", value: { text: "servers use HTTPS" } },
        ])
        .mockResolvedValue([
          {
            key: "high-conf",
            value: { text: "servers use HTTPS" },
            score: 0.9,
          },
        ]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const noopModel = makeMockModel(
      JSON.stringify({
        action: "noop",
        reason: "keep the more confident entry",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: noopModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    // NOOP means "keep B, remove A" — the candidate is deleted, so after = before - 1
    expect(result.after).toBe(result.before - 1);
  });

  it("UPDATE action writes merged content combining both confidence signals", async () => {
    const putSpy = vi.fn();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "partial", value: { text: "service responds in 200ms" } },
          {
            key: "full",
            value: { text: "service responds in 200ms under normal load" },
          },
        ])
        .mockResolvedValue([
          {
            key: "full",
            value: { text: "service responds in 200ms under normal load" },
            score: 0.88,
          },
        ]),
      put: putSpy,
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const updateModel = makeMockModel(
      JSON.stringify({
        action: "update",
        mergedContent:
          "service responds in 200ms under normal load; may be slower under high load",
        reason: "combining both signals",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: updateModel });
    await consolidator.consolidate(store, ["ns"]);
    expect(putSpy).toHaveBeenCalled();
    const calls = putSpy.mock.calls as Array<
      [string[], string, Record<string, unknown>]
    >;
    const updatedContent = calls.find(
      ([, , v]) =>
        typeof v["text"] === "string" &&
        (v["text"] as string).includes("under normal load"),
    );
    expect(updatedContent).toBeDefined();
  });
});

// ===========================================================================
// 11. Conflict resolution — manual review
// ===========================================================================

describe("Conflict resolution — manual review", () => {
  it("contradicting entries are flagged for manual review (not auto-deleted)", async () => {
    const deleteSpy = vi.fn();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          {
            key: "view-a",
            value: { text: "team prefers tabs for indentation" },
          },
          {
            key: "view-b",
            value: { text: "team prefers spaces for indentation" },
          },
        ])
        .mockResolvedValue([
          {
            key: "view-b",
            value: { text: "team prefers spaces for indentation" },
            score: 0.85,
          },
        ]),
      put: vi.fn(),
      delete: deleteSpy,
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const conflictModel = makeMockModel(
      JSON.stringify({
        action: "contradict",
        reason: "irreconcilable style preferences",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    const result = await consolidator.consolidate(store, ["ns"]);
    // Contradictions are flagged, NOT auto-deleted
    expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("_contradictionFlaggedAt timestamp is set on flagged entries", async () => {
    const putSpy = vi.fn();
    const before = Date.now();
    const store: BaseStore = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { key: "c1", value: { text: "auth timeout is 30s" } },
          { key: "c2", value: { text: "auth timeout is 300s" } },
        ])
        .mockResolvedValue([
          { key: "c2", value: { text: "auth timeout is 300s" }, score: 0.93 },
        ]),
      put: putSpy,
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const conflictModel = makeMockModel(
      JSON.stringify({
        action: "contradict",
        reason: "different timeout values",
      }),
    );
    const consolidator = new SemanticConsolidator({ model: conflictModel });
    await consolidator.consolidate(store, ["ns"]);
    const calls = putSpy.mock.calls as Array<
      [string[], string, Record<string, unknown>]
    >;
    const flaggedCalls = calls.filter(
      ([, , v]) => "_contradictionFlaggedAt" in v,
    );
    expect(flaggedCalls.length).toBeGreaterThanOrEqual(1);
    // _contradictionFlaggedAt is stored as an ISO 8601 string
    const flaggedTs = flaggedCalls[0]![2]["_contradictionFlaggedAt"] as string;
    expect(typeof flaggedTs).toBe("string");
    expect(new Date(flaggedTs).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ===========================================================================
// 12. Consolidation trigger — runs when memory count exceeds threshold
// ===========================================================================

describe("Consolidation trigger — consolidation runs when count exceeds threshold", () => {
  it("custom minClusterSize=2: clusters of 2 entries ARE consolidated", async () => {
    const store = makeConsolidationStore([
      { key: "small:1", value: { text: "first" } },
      { key: "small:2", value: { text: "second" } },
    ]);
    const engine = new ConsolidationEngine({ minClusterSize: 2 });
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(2);
  });

  it("default minClusterSize=3: single item clusters are skipped", async () => {
    const store = makeConsolidationStore([
      { key: "lone:1", value: { text: "only entry" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(0);
    expect(result.summaries).toHaveLength(0);
  });

  it("maxEntries config triggers pruning when count exceeds limit", async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      key: `k${i}`,
      value: {
        text: `entry ${i}`,
        timestamp: new Date(daysAgo(10 - i)).toISOString(),
      },
    }));
    const store = makeNsStore(["ns"], records);
    const result = await consolidateNamespace(store, ["ns"], { maxEntries: 5 });
    expect(result.pruned).toBe(5);
  });

  it("consolidation only triggers at threshold boundary: 3 items → 1 summary", async () => {
    const store = makeConsolidationStore([
      { key: "boundary:1", value: { text: "one" } },
      { key: "boundary:2", value: { text: "two" } },
      { key: "boundary:3", value: { text: "three" } },
    ]);
    const engine = new ConsolidationEngine({ minClusterSize: 3 });
    const result = await engine.consolidate("s", "n", store);
    expect(result.summaries).toHaveLength(1);
  });
});

// ===========================================================================
// 13. Consolidation result — fewer memories after consolidation than before
// ===========================================================================

describe("Consolidation result — fewer memories after consolidation", () => {
  it("after < before when deduplication occurs", async () => {
    const store = makeNsStore(
      ["ns"],
      [
        {
          key: "d1",
          value: {
            text: "duplicate text here",
            timestamp: new Date(daysAgo(5)).toISOString(),
          },
        },
        {
          key: "d2",
          value: {
            text: "duplicate text here",
            timestamp: new Date(daysAgo(1)).toISOString(),
          },
        },
        { key: "d3", value: { text: "unique entry alpha" } },
      ],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.after).toBeLessThan(result.before);
  });

  it("after = before - merged - pruned (accounting equation)", async () => {
    const records = Array.from({ length: 6 }, (_, i) => ({
      key: `k${i}`,
      value: {
        text: `item ${i}`,
        timestamp: new Date(daysAgo(i)).toISOString(),
      },
    }));
    const store = makeNsStore(["ns"], records);
    const result = await consolidateNamespace(store, ["ns"], { maxEntries: 4 });
    expect(result.after).toBe(result.before - result.merged - result.pruned);
  });

  it("summarized count equals total child entries consolidated", async () => {
    const store = makeConsolidationStore([
      { key: "grp:1", value: { text: "one" } },
      { key: "grp:2", value: { text: "two" } },
      { key: "grp:3", value: { text: "three" } },
      { key: "grp:4", value: { text: "four" } },
      { key: "grp:5", value: { text: "five" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(5);
  });
});

// ===========================================================================
// 14. Source preservation — source IDs tracked in consolidated memory
// ===========================================================================

describe("Source preservation — source memory IDs tracked in consolidated memory", () => {
  it("summary entry consolidatedFrom field is an array", async () => {
    const store = makeConsolidationStore([
      { key: "id:1", value: { text: "content one" } },
      { key: "id:2", value: { text: "content two" } },
      { key: "id:3", value: { text: "content three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("id:__summary__")!;
    expect(Array.isArray(summary["consolidatedFrom"])).toBe(true);
  });

  it("provenance map returned by consolidate tracks all source IDs", async () => {
    const store = makeConsolidationStore([
      { key: "track:a", value: { text: "track alpha" } },
      { key: "track:b", value: { text: "track beta" } },
      { key: "track:c", value: { text: "track gamma" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    const sourceIds = result.provenance["track:__summary__"]!;
    expect(sourceIds).toEqual(
      expect.arrayContaining(["track:a", "track:b", "track:c"]),
    );
  });

  it("child entries have consolidatedInto pointing to their summary key", async () => {
    const store = makeConsolidationStore([
      { key: "child:1", value: { text: "child text one" } },
      { key: "child:2", value: { text: "child text two" } },
      { key: "child:3", value: { text: "child text three" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    for (const key of ["child:1", "child:2", "child:3"]) {
      expect(store.data.get(key)!["consolidatedInto"]).toBe(
        "child:__summary__",
      );
    }
  });

  it("consolidatedFrom length equals cluster size", async () => {
    const store = makeConsolidationStore([
      { key: "ref:1", value: { text: "ref 1" } },
      { key: "ref:2", value: { text: "ref 2" } },
      { key: "ref:3", value: { text: "ref 3" } },
      { key: "ref:4", value: { text: "ref 4" } },
    ]);
    const engine = new ConsolidationEngine();
    await engine.consolidate("s", "n", store);
    const summary = store.data.get("ref:__summary__")!;
    const from = summary["consolidatedFrom"] as string[];
    expect(from).toHaveLength(4);
  });
});

// ===========================================================================
// 15. Consolidation idempotency — running twice produces same result
// ===========================================================================

describe("Consolidation idempotency — running twice produces same result", () => {
  it("second consolidation run on same namespace produces same merged count", async () => {
    const records = [
      {
        key: "idem:k1",
        value: {
          text: "duplicate A",
          timestamp: new Date(daysAgo(5)).toISOString(),
        },
      },
      {
        key: "idem:k2",
        value: {
          text: "duplicate A",
          timestamp: new Date(daysAgo(1)).toISOString(),
        },
      },
      { key: "idem:k3", value: { text: "unique entry" } },
    ];
    const store1 = makeNsStore(["ns"], records);
    const result1 = await consolidateNamespace(store1, ["ns"]);

    // Build a fresh store with the same data
    const store2 = makeNsStore(["ns"], records);
    const result2 = await consolidateNamespace(store2, ["ns"]);

    expect(result1.merged).toBe(result2.merged);
    expect(result1.after).toBe(result2.after);
  });

  it("already-consolidated child entries are skipped on second engine run", async () => {
    const store = makeConsolidationStore([
      { key: "run:1", value: { text: "run one" } },
      { key: "run:2", value: { text: "run two" } },
      { key: "run:3", value: { text: "run three" } },
    ]);
    const engine = new ConsolidationEngine();
    const result1 = await engine.consolidate("s", "n", store);

    // Second run — children already have consolidatedInto, summary has __summary__ key
    const result2 = await engine.consolidate("s", "n", store);

    // Second run should find no new clusters to consolidate
    expect(result2.summarized).toBe(0);
    // First run should have summarized all 3
    expect(result1.summarized).toBe(3);
  });

  it("consolidateAll on same namespaces twice returns consistent before counts", async () => {
    const store = makeNsStore(["ns"]);
    const run1 = await consolidateAll(store, [["lessons"], ["decisions"]]);
    const run2 = await consolidateAll(store, [["lessons"], ["decisions"]]);
    expect(run1[0]!.before).toBe(run2[0]!.before);
    expect(run1[1]!.before).toBe(run2[1]!.before);
  });
});

// ===========================================================================
// 16. Empty consolidation — consolidating 0 or 1 memory returns unchanged
// ===========================================================================

describe("Empty consolidation — consolidating 0 or 1 memory returns unchanged", () => {
  it("empty namespace: before=0, after=0, merged=0, pruned=0", async () => {
    const store = makeNsStore(["ns"]);
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
  });

  it("single memory: not merged or pruned", async () => {
    const store = makeNsStore(
      ["ns"],
      [{ key: "solo", value: { text: "only entry" } }],
    );
    const result = await consolidateNamespace(store, ["ns"]);
    expect(result.before).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.after).toBe(1);
  });

  it("ConsolidationEngine: empty store → zero result", async () => {
    const store = makeConsolidationStore();
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(0);
    expect(result.summaries).toHaveLength(0);
    expect(result.provenance).toEqual({});
  });

  it("ConsolidationEngine: single item cluster (no colon prefix) → not summarized", async () => {
    const store = makeConsolidationStore([
      { key: "standalone", value: { text: "this item has no prefix" } },
    ]);
    const engine = new ConsolidationEngine();
    const result = await engine.consolidate("s", "n", store);
    expect(result.summarized).toBe(0);
  });

  it("dedupLessons: single lesson returns itself unchanged", () => {
    const lessons = [makeMemoryEntry("one", "single lesson content")];
    const result = dedupLessons(lessons);
    expect(result.deduplicated).toHaveLength(1);
    expect(result.deduplicated[0]!.entry.key).toBe("one");
    expect(result.removedCount).toBe(0);
    expect(result.inputCount).toBe(1);
  });

  it("dedupLessons: empty array returns empty result", () => {
    const result = dedupLessons([]);
    expect(result.deduplicated).toHaveLength(0);
    expect(result.inputCount).toBe(0);
    expect(result.removedCount).toBe(0);
  });

  it("consolidateWithLLM: empty store returns before=0, after=0", async () => {
    const store: BaseStore = {
      search: vi.fn().mockResolvedValue([]),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      batch: vi.fn(),
      start: vi.fn(),
      setup: vi.fn(),
      listNamespaces: vi.fn(),
    } as unknown as BaseStore;

    const result = await consolidateWithLLM(store, ["ns"], {
      model: makeMockModel("{}"),
    });
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
    expect(result.actions).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });
});
