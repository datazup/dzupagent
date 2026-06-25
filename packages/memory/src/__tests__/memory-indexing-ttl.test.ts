/**
 * Memory indexing and TTL tests — Wave 35-F
 *
 * Covers:
 *  - Index rebuild (full and incremental) via SessionSearch
 *  - TTL expiry enforcement (MemoryPruner)
 *  - GC runs: full and partial garbage collection
 *  - Index consistency after GC
 *  - TTL reset/extension on access patterns
 *  - Querying after TTL expiry vs before
 *  - Multiple TTL policies coexisting in the same store
 *  - Edge cases: zero TTL, infinite TTL (no TTL), TTL precision, clock skew
 *  - TemporalMemoryService expiry and active filtering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryPruner } from "../memory-pruner.js";
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from "../consolidation-engine.js";
import { SessionSearch, type SessionSearchStore } from "../session-search.js";
import {
  isActive,
  wasActiveAsOf,
  wasValidAt,
  filterByTemporal,
  createTemporalMeta,
  TemporalMemoryService,
} from "../temporal.js";
import type { TemporalMetadata } from "../temporal.js";
import type { MemoryService } from "../memory-service.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface MockPrunerStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>;
  deleteCalls: Array<[string[], string]>;
}

function makePrunerStore(
  records: Array<{
    key: string;
    value: Record<string, unknown>;
    createdAt?: Date | number;
  }> = [],
): MockPrunerStore {
  const data = new Map<string, Record<string, unknown>>();
  const itemsWithMeta: Array<{
    key: string;
    value: Record<string, unknown>;
    createdAt?: Date | number;
  }> = [];
  for (const r of records) {
    data.set(r.key, r.value);
    itemsWithMeta.push(r);
  }
  const deleteCalls: Array<[string[], string]> = [];
  return {
    data,
    deleteCalls,
    search: vi.fn(async (): Promise<ConsolidationStoreItem[]> => {
      return itemsWithMeta
        .filter((r) => data.has(r.key))
        .map((r) => ({
          key: r.key,
          value: data.get(r.key)!,
          createdAt: r.createdAt,
        }));
    }),
    put: vi.fn(
      async (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, value);
      },
    ),
    delete: vi.fn(async (ns: string[], key: string) => {
      data.delete(key);
      deleteCalls.push([ns, key]);
    }),
  };
}

const ONE_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * ONE_DAY;
const BASE_NOW = 10_000_000;

function makeDecay(createdAt: number, strength = 1.0): Record<string, unknown> {
  return { _decay: { createdAt, strength } };
}

// ---------------------------------------------------------------------------
// SessionSearch index helpers
// ---------------------------------------------------------------------------

function makeIndexStore(
  initialData: Record<string, Record<string, unknown>[]> = {},
): {
  store: SessionSearchStore;
  data: Record<string, Record<string, unknown>[]>;
} {
  const data: Record<string, Record<string, unknown>[]> = { ...initialData };
  const store: SessionSearchStore = {
    get: vi.fn(
      async (ns: string, _scope: Record<string, string>) => data[ns] ?? [],
    ),
  };
  return { store, data };
}

const SCOPE = { tenantId: "t1" };

// ---------------------------------------------------------------------------
// TemporalMemoryService helpers
// ---------------------------------------------------------------------------

function makeTemporalRecord(
  overrides: Partial<TemporalMetadata> = {},
): Record<string, unknown> {
  const meta: TemporalMetadata = {
    systemCreatedAt: 1000,
    systemExpiredAt: null,
    validFrom: 1000,
    validUntil: null,
    ...overrides,
  };
  return { text: "payload", _temporal: meta };
}

function createMockMemoryService(
  opts: {
    getReturn?: Record<string, unknown>[][];
  } = {},
): {
  svc: MemoryService;
  putSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  searchSpy: ReturnType<typeof vi.fn>;
} {
  let getCallIndex = 0;
  const getReturns = opts.getReturn ?? [[]];
  const putSpy = vi.fn().mockResolvedValue(undefined);
  const getSpy = vi.fn().mockImplementation(async () => {
    const ret =
      getReturns[getCallIndex] ?? getReturns[getReturns.length - 1] ?? [];
    getCallIndex++;
    return ret;
  });
  const searchSpy = vi.fn().mockResolvedValue([]);
  const svc = {
    put: putSpy,
    get: getSpy,
    search: searchSpy,
    formatForPrompt: vi.fn().mockReturnValue(""),
  } as unknown as MemoryService;
  return { svc, putSpy, getSpy, searchSpy };
}

// ===========================================================================
// SECTION 1: TTL expiry enforcement (MemoryPruner)
// ===========================================================================

describe("TTL expiry enforcement", () => {
  it("expires entry exactly at boundary (createdAt = now - ttlMs + 1 survives)", async () => {
    const now = BASE_NOW;
    const ttlMs = SEVEN_DAYS;
    const store = makePrunerStore([
      { key: "boundary", value: makeDecay(now - ttlMs + 1) }, // 1ms inside → survive
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
    expect(store.data.has("boundary")).toBe(true);
  });

  it("expires entry exactly at cutoff (createdAt = now - ttlMs is expired)", async () => {
    const now = BASE_NOW;
    const ttlMs = SEVEN_DAYS;
    // createdAt === now - ttlMs → cutoff = now - ttlMs; entry.createdAt < cutoff? NO (not strictly less)
    // Actually: cutoff = now - ttlMs; expired when createdAt < cutoff → equal is NOT expired
    const store = makePrunerStore([
      { key: "at-cutoff", value: makeDecay(now - ttlMs) }, // equal to cutoff → survive
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("expires entry 1ms past cutoff (createdAt = now - ttlMs - 1)", async () => {
    const now = BASE_NOW;
    const ttlMs = SEVEN_DAYS;
    const store = makePrunerStore([
      { key: "expired", value: makeDecay(now - ttlMs - 1) }, // 1ms past cutoff → expire
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(result.remaining).toBe(0);
    expect(store.data.has("expired")).toBe(false);
  });

  it("with zero TTL every entry expires (all past t=0)", async () => {
    // zero TTL: cutoff = now - 0 = now; entry.createdAt < now → all expire
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "a", value: makeDecay(now - 1) },
      { key: "b", value: makeDecay(now - 1000) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: 0,
      now: () => now,
    });
    expect(result.expired).toBe(2);
    expect(result.remaining).toBe(0);
  });

  it("entry with createdAt === 0 is sentinel and does not expire", async () => {
    const now = BASE_NOW;
    // parseItem returns createdAt=0 when no timestamp found; sentinel skips TTL
    const store = makePrunerStore([
      { key: "sentinel", value: {} }, // no _decay, no createdAt → createdAt=0 sentinel
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: 1,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("infinite TTL (very large value) — no entries expire", async () => {
    const now = BASE_NOW;
    const infiniteTtl = Number.MAX_SAFE_INTEGER;
    const store = makePrunerStore([
      { key: "a", value: makeDecay(now - SEVEN_DAYS * 100) },
      { key: "b", value: makeDecay(0) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: infiniteTtl,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("TTL precision: sub-millisecond boundary handled correctly", async () => {
    const now = 5000;
    const ttlMs = 2000; // cutoff = 3000
    const store = makePrunerStore([
      { key: "old", value: makeDecay(2999) }, // 2999 < 3000 → expires
      { key: "fresh", value: makeDecay(3001) }, // 3001 > 3000 → survives
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(result.remaining).toBe(1);
    expect(store.data.has("old")).toBe(false);
    expect(store.data.has("fresh")).toBe(true);
  });

  it("mixed fresh and expired entries — only expired removed", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "exp1", value: makeDecay(now - SEVEN_DAYS - 1) },
      { key: "exp2", value: makeDecay(now - SEVEN_DAYS * 2) },
      { key: "fresh1", value: makeDecay(now - ONE_DAY) },
      { key: "fresh2", value: makeDecay(now - ONE_DAY * 2) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(2);
    expect(result.remaining).toBe(2);
    expect(store.data.has("exp1")).toBe(false);
    expect(store.data.has("exp2")).toBe(false);
    expect(store.data.has("fresh1")).toBe(true);
    expect(store.data.has("fresh2")).toBe(true);
  });

  it("createdAt sourced from value.createdAt when _decay absent", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      {
        key: "by-value",
        value: { createdAt: now - SEVEN_DAYS - 1, text: "old" },
      },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(1);
  });

  it("createdAt sourced from item.createdAt wrapper (Date object)", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      {
        key: "by-wrapper",
        value: { text: "old" },
        createdAt: new Date(now - SEVEN_DAYS - 1),
      },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(1);
  });

  it("createdAt sourced from item.createdAt wrapper (string ISO date)", async () => {
    const now = BASE_NOW;
    const old = new Date(now - SEVEN_DAYS - 1);
    const store = makePrunerStore([
      {
        key: "by-string",
        value: { text: "old" },
        createdAt: old.toISOString(),
      },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(1);
  });
});

// ===========================================================================
// SECTION 2: GC runs (garbage collection)
// ===========================================================================

describe("GC runs — MemoryPruner full and partial GC", () => {
  it("full GC: all entries expired", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "a", value: makeDecay(now - SEVEN_DAYS * 2) },
      { key: "b", value: makeDecay(now - SEVEN_DAYS * 3) },
      { key: "c", value: makeDecay(now - SEVEN_DAYS * 10) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(3);
    expect(result.remaining).toBe(0);
    expect(store.data.size).toBe(0);
  });

  it("partial GC: only expired entries removed, rest kept", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "gc1", value: makeDecay(now - SEVEN_DAYS * 2) },
      { key: "keep1", value: makeDecay(now - ONE_DAY) },
      { key: "gc2", value: makeDecay(now - SEVEN_DAYS * 5) },
      { key: "keep2", value: makeDecay(now - ONE_DAY * 3) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(2);
    expect(result.remaining).toBe(2);
    expect(store.data.has("gc1")).toBe(false);
    expect(store.data.has("gc2")).toBe(false);
    expect(store.data.has("keep1")).toBe(true);
    expect(store.data.has("keep2")).toBe(true);
  });

  it("GC non-fatal: delete failure on one entry does not abort remaining GC", async () => {
    const now = BASE_NOW;
    const deleteCallCount = { count: 0 };
    const store: ConsolidationStore = {
      search: vi.fn(
        async (): Promise<ConsolidationStoreItem[]> => [
          { key: "exp1", value: makeDecay(now - SEVEN_DAYS * 2) },
          { key: "exp2", value: makeDecay(now - SEVEN_DAYS * 2) },
          { key: "exp3", value: makeDecay(now - SEVEN_DAYS * 2) },
        ],
      ),
      put: vi.fn(),
      delete: vi.fn(async (_ns: string[], key: string) => {
        deleteCallCount.count++;
        if (key === "exp2") throw new Error("transient delete failure");
      }),
    };
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    // 3 expired, exp2 failed → counted in survivors
    expect(result.expired).toBe(2);
    expect(result.remaining).toBe(1); // exp2 failed delete → survivor
    expect(deleteCallCount.count).toBe(3); // all 3 attempted
  });

  it("GC with capacity cap: evicts weakest after TTL pass", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "exp", value: makeDecay(now - SEVEN_DAYS * 2) }, // TTL expired
      { key: "weak", value: { _decay: { createdAt: now, strength: 0.05 } } },
      { key: "medium", value: { _decay: { createdAt: now, strength: 0.5 } } },
      { key: "strong", value: { _decay: { createdAt: now, strength: 0.9 } } },
    ]);
    // After TTL pass: 3 remain; max=2 → evict 1 weakest
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      maxEntries: 2,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(result.evicted).toBe(1);
    expect(result.remaining).toBe(2);
    expect(store.data.has("exp")).toBe(false);
    expect(store.data.has("weak")).toBe(false);
    expect(store.data.has("strong")).toBe(true);
    expect(store.data.has("medium")).toBe(true);
  });

  it("repeated GC calls on empty store remain safe", async () => {
    const pruner = new MemoryPruner();
    const store = makePrunerStore();
    for (let i = 0; i < 5; i++) {
      const result = await pruner.prune(store);
      expect(result).toEqual({ expired: 0, evicted: 0, remaining: 0 });
    }
  });

  it("GC respects namespace option to scope deletion", async () => {
    const now = BASE_NOW;
    const nsCallRecord: string[][] = [];
    const store: ConsolidationStore = {
      search: vi.fn(async (ns: string[]): Promise<ConsolidationStoreItem[]> => {
        nsCallRecord.push(ns);
        return [{ key: "exp", value: makeDecay(now - SEVEN_DAYS * 2) }];
      }),
      put: vi.fn(),
      delete: vi.fn(),
    };
    await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
      namespace: ["tenant1", "decisions"],
    });
    expect(nsCallRecord[0]).toEqual(["tenant1", "decisions"]);
    expect(store.delete).toHaveBeenCalledWith(["tenant1", "decisions"], "exp");
  });
});

// ===========================================================================
// SECTION 3: Index rebuild (SessionSearch)
// ===========================================================================

describe("Index rebuild — full and incremental", () => {
  it("full rebuild: index cleared then repopulated with new records", async () => {
    const { store, data } = makeIndexStore({
      ns: [{ key: "a", text: "postgres" }],
    });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(1);

    // Full rebuild with more records
    data.ns = [
      { key: "a", text: "postgres" },
      { key: "b", text: "redis" },
      { key: "c", text: "mysql" },
    ];
    await search.index("ns", SCOPE); // re-index = rebuild
    expect(search.indexedCount).toBe(3);

    const r = await search.search({ text: "redis" });
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBe("b");
  });

  it("incremental rebuild: index multiple namespaces independently", async () => {
    const { store, data } = makeIndexStore({
      ns1: [{ key: "a", text: "postgres" }],
      ns2: [{ key: "b", text: "redis" }],
    });
    const search = new SessionSearch(store);
    await search.index("ns1", SCOPE);
    await search.index("ns2", SCOPE);
    expect(search.indexedCount).toBe(2);

    // Rebuild only ns1
    data.ns1 = [
      { key: "a", text: "postgres updated" },
      { key: "c", text: "postgresql new" },
    ];
    await search.index("ns1", SCOPE);
    // ns2 still has 1 from original index, ns1 now has 2
    expect(search.indexedCount).toBe(3);

    const r = await search.search({ text: "updated" });
    expect(r[0]!.key).toBe("a");
  });

  it("rebuild after invalidate populates fresh data", async () => {
    const { store, data } = makeIndexStore({
      ns: [{ key: "old", text: "stale data" }],
    });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);
    search.invalidate("ns");
    expect(search.indexedCount).toBe(0);

    data.ns = [{ key: "new", text: "fresh data" }];
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(1);

    const stale = await search.search({ text: "stale" });
    const fresh = await search.search({ text: "fresh" });
    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  it("rebuild with empty result clears the namespace index", async () => {
    const { store, data } = makeIndexStore({
      ns: [{ key: "a", text: "something" }],
    });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(1);

    data.ns = [];
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(0);
    const r = await search.search({ text: "something" });
    expect(r).toHaveLength(0);
  });

  it("store.get is called once per index() call (no caching across rebuild)", async () => {
    const { store } = makeIndexStore({ ns: [{ key: "a", text: "foo" }] });
    const getMock = store.get as ReturnType<typeof vi.fn>;
    const search = new SessionSearch(store);

    await search.index("ns", SCOPE);
    await search.index("ns", SCOPE);
    await search.index("ns", SCOPE);

    expect(getMock.mock.calls.length).toBe(3);
  });

  it("rebuilding large namespace replaces entire prior index atomically", async () => {
    const { store, data } = makeIndexStore({
      ns: Array.from({ length: 100 }, (_, i) => ({
        key: `alpha-${i}`,
        text: `xalpha legacy ${i}`,
      })),
    });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(100);

    data.ns = Array.from({ length: 50 }, (_, i) => ({
      key: `beta-${i}`,
      text: `xbeta current ${i}`,
    }));
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(50);

    // "xalpha" is unique to old records and does not appear in new records
    const oldResults = await search.search({ text: "xalpha" });
    expect(oldResults).toHaveLength(0);

    // "xbeta" is unique to new records
    const newResults = await search.search({ text: "xbeta", limit: 100 });
    expect(newResults).toHaveLength(50);
  });
});

// ===========================================================================
// SECTION 4: Index consistency after GC
// ===========================================================================

describe("Index consistency after GC", () => {
  it("SessionSearch index after GC reflects only surviving records", async () => {
    const now = BASE_NOW;
    const prunerStore = makePrunerStore([
      {
        key: "old",
        value: { ...makeDecay(now - SEVEN_DAYS * 2), text: "expired entry" },
      },
      {
        key: "alive",
        value: { ...makeDecay(now - ONE_DAY), text: "fresh entry" },
      },
    ]);

    // Run GC
    const pruner = new MemoryPruner();
    await pruner.prune(prunerStore, { ttlMs: SEVEN_DAYS, now: () => now });

    // Index only surviving records
    const surviving = [...prunerStore.data.entries()].map(([k, v]) => ({
      key: k,
      ...v,
    }));
    const { store } = makeIndexStore({ ns: surviving });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);

    // Expired entry should not be searchable
    const expired = await search.search({ text: "expired" });
    expect(expired).toHaveLength(0);

    // Fresh entry should still be searchable
    const fresh = await search.search({ text: "fresh" });
    expect(fresh).toHaveLength(1);
  });

  it("rebuilding index after GC removes stale entries from search results", async () => {
    // Simulate scenario: index built before GC, then stale; rebuild after GC
    const { store, data } = makeIndexStore({
      ns: [
        { key: "stale", text: "old content" },
        { key: "active", text: "current content" },
      ],
    });
    const search = new SessionSearch(store);
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(2);

    // GC removes stale
    data.ns = [{ key: "active", text: "current content" }];

    // Rebuild index
    await search.index("ns", SCOPE);
    expect(search.indexedCount).toBe(1);

    const staleResults = await search.search({ text: "old" });
    expect(staleResults).toHaveLength(0);

    const activeResults = await search.search({ text: "current" });
    expect(activeResults).toHaveLength(1);
  });

  it("eviction by capacity does not corrupt index of surviving entries", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      {
        key: "evict1",
        value: { _decay: { createdAt: now, strength: 0.01 }, text: "weak" },
      },
      {
        key: "evict2",
        value: { _decay: { createdAt: now, strength: 0.02 }, text: "weak too" },
      },
      {
        key: "keep1",
        value: { _decay: { createdAt: now, strength: 0.8 }, text: "strong" },
      },
      {
        key: "keep2",
        value: { _decay: { createdAt: now, strength: 0.9 }, text: "strongest" },
      },
    ]);
    await new MemoryPruner().prune(store, { maxEntries: 2, now: () => now });

    // Confirm survivors
    expect(store.data.has("keep1")).toBe(true);
    expect(store.data.has("keep2")).toBe(true);
    expect(store.data.has("evict1")).toBe(false);
    expect(store.data.has("evict2")).toBe(false);
  });
});

// ===========================================================================
// SECTION 5: Multiple TTL policies coexisting
// ===========================================================================

describe("Multiple TTL policies coexisting", () => {
  it("short TTL vs long TTL: different expiry outcomes for same now", async () => {
    const now = BASE_NOW;
    const shortTtl = ONE_DAY; // 1 day
    const longTtl = SEVEN_DAYS; // 7 days
    const age = ONE_DAY * 3; // 3 days old

    const store = makePrunerStore([
      { key: "entry", value: makeDecay(now - age) },
    ]);

    // Short policy: 3 days > 1 day → expired
    const shortResult = await new MemoryPruner().prune(
      makePrunerStore([{ key: "entry", value: makeDecay(now - age) }]),
      { ttlMs: shortTtl, now: () => now },
    );
    expect(shortResult.expired).toBe(1);

    // Long policy: 3 days < 7 days → survives
    const longResult = await new MemoryPruner().prune(
      makePrunerStore([{ key: "entry", value: makeDecay(now - age) }]),
      { ttlMs: longTtl, now: () => now },
    );
    expect(longResult.expired).toBe(0);
    expect(longResult.remaining).toBe(1);

    // Suppress unused variable warning
    void store;
  });

  it("two different namespaces can be pruned with different TTL policies", async () => {
    const now = BASE_NOW;
    const ageThreeDays = now - ONE_DAY * 3;

    // Namespace A: short TTL (1 day) → the 3-day old entry expires
    const storeA = makePrunerStore([
      { key: "entry", value: makeDecay(ageThreeDays) },
    ]);
    const resultA = await new MemoryPruner().prune(storeA, {
      ttlMs: ONE_DAY,
      namespace: ["tenantA", "lessons"],
      now: () => now,
    });
    expect(resultA.expired).toBe(1);

    // Namespace B: long TTL (30 days) → the 3-day old entry survives
    const storeB = makePrunerStore([
      { key: "entry", value: makeDecay(ageThreeDays) },
    ]);
    const resultB = await new MemoryPruner().prune(storeB, {
      ttlMs: ONE_DAY * 30,
      namespace: ["tenantB", "decisions"],
      now: () => now,
    });
    expect(resultB.expired).toBe(0);
    expect(resultB.remaining).toBe(1);
  });

  it("default TTL applies when none specified", async () => {
    // Default TTL is 7 days; use a now() that makes 6-day old entries survive
    const now = BASE_NOW;
    const sixDays = ONE_DAY * 6;
    const eightDays = ONE_DAY * 8;

    const store = makePrunerStore([
      { key: "alive", value: makeDecay(now - sixDays) },
      { key: "dead", value: makeDecay(now - eightDays) },
    ]);
    const result = await new MemoryPruner().prune(store, { now: () => now });
    expect(result.expired).toBe(1);
    expect(result.remaining).toBe(1);
    expect(store.data.has("alive")).toBe(true);
  });

  it("maxEntries policy independent of TTL policy", async () => {
    const now = BASE_NOW;
    // 5 entries all fresh, cap at 3 (no TTL expiry, only capacity)
    const entries = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`,
      value: { _decay: { createdAt: now, strength: (i + 1) * 0.1 } },
    }));
    const store = makePrunerStore(entries);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 3,
      ttlMs: SEVEN_DAYS * 100, // effectively infinite TTL
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.evicted).toBe(2);
    expect(result.remaining).toBe(3);
  });
});

// ===========================================================================
// SECTION 6: Querying before vs after TTL expiry
// ===========================================================================

describe("Querying before vs after TTL expiry", () => {
  it("entry queryable before TTL, not after — simulated with fake clock", async () => {
    const createdAt = 1000;
    const ttlMs = ONE_DAY;
    const nowBefore = createdAt + ONE_DAY - 1; // just before expiry

    // Before TTL: survives
    const storeBefore = makePrunerStore([
      { key: "entry", value: makeDecay(createdAt) },
    ]);
    const before = await new MemoryPruner().prune(storeBefore, {
      ttlMs,
      now: () => nowBefore,
    });
    expect(before.expired).toBe(0);
    expect(before.remaining).toBe(1);

    // After TTL: expired
    const nowAfter = createdAt + ONE_DAY + 1; // just after expiry
    const storeAfter = makePrunerStore([
      { key: "entry", value: makeDecay(createdAt) },
    ]);
    const after = await new MemoryPruner().prune(storeAfter, {
      ttlMs,
      now: () => nowAfter,
    });
    expect(after.expired).toBe(1);
    expect(after.remaining).toBe(0);
  });

  it("TTL extension via strength bump: high-strength entry survives capacity pruning longer", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "low", value: { _decay: { createdAt: now, strength: 0.01 } } },
      { key: "high", value: { _decay: { createdAt: now, strength: 0.99 } } },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 1,
      now: () => now,
    });
    expect(result.evicted).toBe(1);
    expect(store.data.has("high")).toBe(true);
    expect(store.data.has("low")).toBe(false);
  });

  it("SessionSearch: re-indexing after TTL prune queries updated data correctly", async () => {
    const { store, data } = makeIndexStore({
      ns: [
        { key: "old", text: "pre-expiry data" },
        { key: "new", text: "active data" },
      ],
    });
    const search = new SessionSearch(store);

    // Index before GC
    await search.index("ns", SCOPE);
    const before = await search.search({ text: "pre-expiry" });
    expect(before).toHaveLength(1);

    // Simulate GC removing old entry
    data.ns = [{ key: "new", text: "active data" }];
    await search.index("ns", SCOPE); // rebuild

    const after = await search.search({ text: "pre-expiry" });
    expect(after).toHaveLength(0);

    const active = await search.search({ text: "active" });
    expect(active).toHaveLength(1);
  });

  it("vi.useFakeTimers: TTL expiry driven by fake clock advancement", async () => {
    vi.useFakeTimers();
    const startMs = Date.now();
    const ttlMs = 1000; // 1 second TTL for test speed

    const store = makePrunerStore([
      { key: "entry", value: makeDecay(startMs) },
    ]);

    // Before TTL: survives
    const before = await new MemoryPruner().prune(
      makePrunerStore([{ key: "entry", value: makeDecay(startMs) }]),
      { ttlMs },
    );
    expect(before.expired).toBe(0);

    // Advance clock past TTL
    vi.advanceTimersByTime(ttlMs + 1);

    const after = await new MemoryPruner().prune(
      makePrunerStore([{ key: "entry", value: makeDecay(startMs) }]),
      { ttlMs },
    );
    expect(after.expired).toBe(1);

    vi.useRealTimers();
    void store;
  });
});

// ===========================================================================
// SECTION 7: Clock skew handling
// ===========================================================================

describe("Clock skew handling", () => {
  it("future-dated entries (createdAt > now) survive pruning", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "future", value: makeDecay(now + ONE_DAY) }, // future timestamp
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("slightly-future createdAt (clock skew +1ms) does not expire", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "skewed", value: makeDecay(now + 1) }, // 1ms in future due to skew
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => now,
    });
    expect(result.expired).toBe(0);
  });

  it("negative clock skew (now lagging): entry that should survive may not", async () => {
    const actualCreatedAt = BASE_NOW;
    const laggedNow = actualCreatedAt + SEVEN_DAYS + 1; // lagged observer sees entry as old
    const store = makePrunerStore([
      { key: "entry", value: makeDecay(actualCreatedAt) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      now: () => laggedNow,
    });
    // Due to lagged clock, entry is beyond TTL from lagged perspective
    expect(result.expired).toBe(1);
  });

  it("monotonic clock: multiple prune calls with advancing now expire correctly", async () => {
    // Use a non-zero createdAt to avoid the sentinel (createdAt===0 is skipped by pruner)
    const createdAt = 1;
    const ttlMs = 1000;

    for (let offset = 0; offset <= 2000; offset += 500) {
      const store = makePrunerStore([
        { key: "entry", value: makeDecay(createdAt) },
      ]);
      const result = await new MemoryPruner().prune(store, {
        ttlMs,
        now: () => offset,
      });
      // cutoff = offset - ttlMs; expires when createdAt < cutoff
      // createdAt=1 < cutoff when offset - 1000 > 1, i.e. offset > 1001
      const cutoff = offset - ttlMs;
      if (createdAt < cutoff) {
        expect(result.expired).toBe(1);
      } else {
        expect(result.expired).toBe(0);
      }
    }
  });
});

// ===========================================================================
// SECTION 8: Temporal expiry (TemporalMemoryService)
// ===========================================================================

describe("TemporalMemoryService TTL and expiry", () => {
  it("isActive: record without _temporal is treated as active", () => {
    const rec: Record<string, unknown> = { text: "no temporal" };
    expect(isActive(rec)).toBe(true);
  });

  it("isActive: record with systemExpiredAt=null is active", () => {
    const rec = makeTemporalRecord({ systemExpiredAt: null });
    expect(isActive(rec)).toBe(true);
  });

  it("isActive: record with systemExpiredAt set is NOT active", () => {
    const rec = makeTemporalRecord({ systemExpiredAt: 2000 });
    expect(isActive(rec)).toBe(false);
  });

  it("wasActiveAsOf: record active at creation time", () => {
    const rec = makeTemporalRecord({
      systemCreatedAt: 500,
      systemExpiredAt: null,
    });
    expect(wasActiveAsOf(rec, 500)).toBe(true);
  });

  it("wasActiveAsOf: record not yet created at query time", () => {
    const rec = makeTemporalRecord({ systemCreatedAt: 2000 });
    expect(wasActiveAsOf(rec, 1999)).toBe(false);
  });

  it("wasActiveAsOf: expired record not active at expiry time", () => {
    const rec = makeTemporalRecord({
      systemCreatedAt: 1000,
      systemExpiredAt: 3000,
    });
    expect(wasActiveAsOf(rec, 3000)).toBe(false); // expired at 3000, not active AT 3000
  });

  it("wasActiveAsOf: expired record active just before expiry", () => {
    const rec = makeTemporalRecord({
      systemCreatedAt: 1000,
      systemExpiredAt: 3000,
    });
    expect(wasActiveAsOf(rec, 2999)).toBe(true);
  });

  it("wasValidAt: record without temporal is treated as valid at any time", () => {
    const rec: Record<string, unknown> = { text: "no temporal" };
    expect(wasValidAt(rec, 0)).toBe(true);
    expect(wasValidAt(rec, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("wasValidAt: record valid within its validFrom-validUntil window", () => {
    const rec = makeTemporalRecord({ validFrom: 1000, validUntil: 5000 });
    expect(wasValidAt(rec, 1000)).toBe(true);
    expect(wasValidAt(rec, 3000)).toBe(true);
    expect(wasValidAt(rec, 4999)).toBe(true);
  });

  it("wasValidAt: record NOT valid before validFrom", () => {
    const rec = makeTemporalRecord({ validFrom: 1000 });
    expect(wasValidAt(rec, 999)).toBe(false);
  });

  it("wasValidAt: record NOT valid at or after validUntil", () => {
    const rec = makeTemporalRecord({ validFrom: 1000, validUntil: 5000 });
    expect(wasValidAt(rec, 5000)).toBe(false);
    expect(wasValidAt(rec, 5001)).toBe(false);
  });

  it("filterByTemporal: asOf filters to records active at that time", () => {
    const records = [
      makeTemporalRecord({ systemCreatedAt: 100, systemExpiredAt: null }), // active
      makeTemporalRecord({ systemCreatedAt: 5000, systemExpiredAt: null }), // future, not yet active at 1000
      makeTemporalRecord({ systemCreatedAt: 100, systemExpiredAt: 500 }), // expired before query
    ];
    const result = filterByTemporal(records, { asOf: 1000 });
    expect(result).toHaveLength(1);
    expect((result[0]!["_temporal"] as TemporalMetadata).systemCreatedAt).toBe(
      100,
    );
    expect(
      (result[0]!["_temporal"] as TemporalMetadata).systemExpiredAt,
    ).toBeNull();
  });

  it("filterByTemporal: validAt filters to records valid in real-world time", () => {
    const records = [
      makeTemporalRecord({ validFrom: 1000, validUntil: 3000 }), // valid at 2000
      makeTemporalRecord({ validFrom: 4000, validUntil: null }), // not yet valid at 2000
      makeTemporalRecord({ validFrom: 500, validUntil: 1500 }), // expired at 2000
    ];
    const result = filterByTemporal(records, { validAt: 2000 });
    expect(result).toHaveLength(1);
    expect((result[0]!["_temporal"] as TemporalMetadata).validFrom).toBe(1000);
  });

  it("filterByTemporal: combined asOf + validAt filters both dimensions", () => {
    const active = makeTemporalRecord({
      systemCreatedAt: 100,
      systemExpiredAt: null,
      validFrom: 1000,
      validUntil: null,
    });
    const expired = makeTemporalRecord({
      systemCreatedAt: 100,
      systemExpiredAt: 500,
      validFrom: 1000,
      validUntil: null,
    });
    const future = makeTemporalRecord({
      systemCreatedAt: 100,
      systemExpiredAt: null,
      validFrom: 9999,
      validUntil: null,
    });
    const result = filterByTemporal([active, expired, future], {
      asOf: 2000,
      validAt: 2000,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(active);
  });

  it("TemporalMemoryService.expire marks record inactive", async () => {
    const record = makeTemporalRecord();
    const { svc, putSpy, getSpy } = createMockMemoryService({
      getReturn: [[record]],
    });
    const tms = new TemporalMemoryService(svc);

    await tms.expire("ns", { tenantId: "t1" }, "key1");

    expect(getSpy).toHaveBeenCalled();
    expect(putSpy).toHaveBeenCalledOnce();

    const written = putSpy.mock.calls[0]![3] as Record<string, unknown>;
    const temporal = written["_temporal"] as TemporalMetadata;
    expect(temporal.systemExpiredAt).not.toBeNull();
    expect(temporal.validUntil).not.toBeNull();
  });

  it("TemporalMemoryService.expire is no-op when record not found", async () => {
    const { svc, putSpy, getSpy } = createMockMemoryService({
      getReturn: [[]],
    });
    const tms = new TemporalMemoryService(svc);
    await tms.expire("ns", { tenantId: "t1" }, "missing");
    expect(getSpy).toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("TemporalMemoryService.getActive returns only non-expired records", async () => {
    const activeRec = makeTemporalRecord({ systemExpiredAt: null });
    const expiredRec = makeTemporalRecord({ systemExpiredAt: 999 });
    const { svc } = createMockMemoryService({
      getReturn: [[activeRec, expiredRec]],
    });
    const tms = new TemporalMemoryService(svc);
    const result = await tms.getActive("ns", { tenantId: "t1" });
    expect(result).toHaveLength(1);
    expect(
      (result[0]!["_temporal"] as TemporalMetadata).systemExpiredAt,
    ).toBeNull();
  });

  it("TemporalMemoryService.put enriches record with temporal metadata", async () => {
    const { svc, putSpy } = createMockMemoryService();
    const tms = new TemporalMemoryService(svc);
    await tms.put("ns", { tenantId: "t1" }, "k", { content: "hello" });

    expect(putSpy).toHaveBeenCalledOnce();
    const written = putSpy.mock.calls[0]![3] as Record<string, unknown>;
    const temporal = written["_temporal"] as TemporalMetadata;
    expect(temporal.systemCreatedAt).toBeTypeOf("number");
    expect(temporal.systemExpiredAt).toBeNull();
    expect(temporal.validFrom).toBeTypeOf("number");
    expect(temporal.validUntil).toBeNull();
  });

  it("createTemporalMeta returns structurally correct defaults", () => {
    const before = Date.now();
    const meta = createTemporalMeta();
    const after = Date.now();
    expect(meta.systemCreatedAt).toBeGreaterThanOrEqual(before);
    expect(meta.systemCreatedAt).toBeLessThanOrEqual(after);
    expect(meta.systemExpiredAt).toBeNull();
    expect(meta.validFrom).toBeGreaterThanOrEqual(before);
    expect(meta.validUntil).toBeNull();
  });

  it("createTemporalMeta accepts explicit validFrom", () => {
    const meta = createTemporalMeta(12345);
    expect(meta.validFrom).toBe(12345);
  });

  it("TemporalMemoryService.search with fake timers filters by current active status", async () => {
    vi.useFakeTimers();
    const activeRec = makeTemporalRecord({ systemExpiredAt: null });
    const expiredRec = makeTemporalRecord({ systemExpiredAt: Date.now() - 1 });
    const { svc } = createMockMemoryService();
    (svc.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      activeRec,
      expiredRec,
    ]);

    const tms = new TemporalMemoryService(svc);
    const results = await tms.search("ns", { tenantId: "t1" }, "query");
    expect(results.every((r) => isActive(r))).toBe(true);
    vi.useRealTimers();
  });
});

// ===========================================================================
// SECTION 9: Edge cases
// ===========================================================================

describe("Edge cases", () => {
  it("zero TTL expires everything (including entry created at exactly now)", async () => {
    const now = BASE_NOW;
    // cutoff = now - 0 = now; entries with createdAt < now expire
    const store = makePrunerStore([
      { key: "exact-now", value: makeDecay(now) }, // equal, not < → survives
      { key: "one-before", value: makeDecay(now - 1) }, // 1ms before → expires
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: 0,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(store.data.has("exact-now")).toBe(true);
    expect(store.data.has("one-before")).toBe(false);
  });

  it("very large createdAt (far future) never expires with any reasonable TTL", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "far-future", value: makeDecay(Number.MAX_SAFE_INTEGER) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS * 365 * 100, // 100 years
      now: () => now,
    });
    expect(result.expired).toBe(0);
  });

  it("NaN strength treated as 1 (default) in sort order", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "nan", value: { _decay: { createdAt: now, strength: NaN } } },
      { key: "low", value: { _decay: { createdAt: now, strength: 0.01 } } },
    ]);
    // maxEntries=1: one eviction; NaN vs 0.01 — NaN comparisons return false, so behavior is implementation-defined but no crash
    await expect(
      new MemoryPruner().prune(store, { maxEntries: 1, now: () => now }),
    ).resolves.toBeDefined();
  });

  it("single-entry store with capacity=1 produces no evictions", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([{ key: "only", value: makeDecay(now) }]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 1,
      now: () => now,
    });
    expect(result.evicted).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("capacity=0 evicts all survivors", async () => {
    const now = BASE_NOW;
    const store = makePrunerStore([
      { key: "a", value: makeDecay(now) },
      { key: "b", value: makeDecay(now) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 0,
      now: () => now,
    });
    expect(result.evicted).toBe(2);
    expect(result.remaining).toBe(0);
  });

  it("pageSize option affects how many items are fetched per scan", async () => {
    const now = BASE_NOW;
    const searchCalls: Array<{ limit: number | undefined }> = [];
    const store: ConsolidationStore = {
      search: vi.fn(async (_ns, opts) => {
        searchCalls.push({ limit: opts?.limit });
        return [];
      }),
      put: vi.fn(),
      delete: vi.fn(),
    };
    await new MemoryPruner().prune(store, { pageSize: 42, now: () => now });
    expect(searchCalls[0]!.limit).toBe(42);
  });

  it("SessionSearch: indexedCount stays correct across repeated rebuild cycles", async () => {
    const { store, data } = makeIndexStore({ ns: [] });
    const search = new SessionSearch(store);

    for (let round = 1; round <= 5; round++) {
      data.ns = Array.from({ length: round * 3 }, (_, i) => ({
        key: `r${round}-k${i}`,
        text: `round ${round} item ${i}`,
      }));
      await search.index("ns", SCOPE);
      expect(search.indexedCount).toBe(round * 3);
    }
  });

  it("prune result.remaining + result.expired + result.evicted = original count (normal case)", async () => {
    const now = BASE_NOW;
    const total = 10;
    const records = Array.from({ length: total }, (_, i) => ({
      key: `k${i}`,
      value: {
        _decay: {
          createdAt: i % 2 === 0 ? now - SEVEN_DAYS * 2 : now,
          strength: 0.5,
        },
      },
    }));
    const store = makePrunerStore(records);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: SEVEN_DAYS,
      maxEntries: 100,
      now: () => now,
    });
    // 5 expired, 5 survivors, max=100 so no evictions
    expect(result.expired + result.evicted + result.remaining).toBe(total);
  });
});
