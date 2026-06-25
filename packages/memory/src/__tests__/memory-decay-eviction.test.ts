/**
 * Comprehensive tests for memory decay & eviction:
 *   - TTL expiry / immortal memories
 *   - LRU eviction (strength-based capacity management via MemoryPruner)
 *   - Access-count boosting (reinforceMemory + half-life doubling)
 *   - Staleness scoring & pruning
 *   - Fake-timer driven decay over time
 *   - Pinned memory protection
 *   - Batch eviction
 *   - Re-insertion after eviction
 *   - Edge cases (capacity=0, malformed decay meta, etc.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
} from "../decay-engine.js";
import type { DecayMetadata } from "../decay-engine.js";
import {
  computeStaleness,
  pruneStaleMemories,
  pruneStaleMemoriesWithGraph,
  StalenessPruner,
} from "../staleness-pruner.js";
import type { MemoryEntry } from "../consolidation-types.js";
import { MemoryPruner } from "../memory-pruner.js";
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from "../consolidation-engine.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const DEFAULT_HALF_LIFE = 24 * ONE_HOUR; // 24 hours
const MAX_HALF_LIFE = 30 * MS_PER_DAY; // 30 days

/**
 * Realistic "now" timestamp (~mid 2024) large enough that subtracting
 * many days of ms does not go negative. 10_000_000 ms is only ~2.8 hours
 * since epoch — way too small for day-based arithmetic.
 */
const BASE_NOW = 1_720_000_000_000; // ~ July 2024

function makeMeta(overrides?: Partial<DecayMetadata>): DecayMetadata {
  const now = Date.now();
  return {
    strength: 1,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    halfLifeMs: DEFAULT_HALF_LIFE,
    ...overrides,
  };
}

function makeEntry(
  key: string,
  text: string,
  extras?: Partial<MemoryEntry>,
): MemoryEntry {
  return { key, text, ...extras };
}

/** Build a simple ConsolidationStore backed by a Map */
function makePrunerStore(
  records: Array<{
    key: string;
    value: Record<string, unknown>;
    createdAt?: Date | number;
  }> = [],
): {
  data: Map<string, Record<string, unknown>>;
  deleteCalls: Array<[string[], string]>;
} & ConsolidationStore {
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

function makeDecayValue(
  createdAt: number,
  strength = 1.0,
): Record<string, unknown> {
  return { _decay: { createdAt, strength } };
}

// ===========================================================================
// SECTION 1: TTL expiry (MemoryPruner)
// ===========================================================================

describe("TTL expiry — MemoryPruner", () => {
  it("memory created within TTL is not expired", async () => {
    const now = 10_000_000;
    const ttlMs = MS_PER_DAY;
    const store = makePrunerStore([
      { key: "fresh", value: makeDecayValue(now - ONE_HOUR) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
    expect(store.data.has("fresh")).toBe(true);
  });

  it("memory past its TTL is removed from store", async () => {
    const now = 10_000_000;
    const ttlMs = MS_PER_DAY;
    const store = makePrunerStore([
      { key: "old", value: makeDecayValue(now - ttlMs - 1) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(result.remaining).toBe(0);
    expect(store.data.has("old")).toBe(false);
  });

  it("memory with createdAt exactly at the TTL boundary survives (not strictly less)", async () => {
    const now = 10_000_000;
    const ttlMs = MS_PER_DAY;
    // cutoff = now - ttlMs; expired when createdAt < cutoff; equal is safe
    const store = makePrunerStore([
      { key: "boundary", value: makeDecayValue(now - ttlMs) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("memory with TTL = undefined (no TTL set) uses 7-day default and survives if within range", async () => {
    const now = 10_000_000;
    const sixDays = 6 * MS_PER_DAY;
    const store = makePrunerStore([
      { key: "week-old", value: makeDecayValue(now - sixDays) },
    ]);
    // No ttlMs provided → defaults to 7 days; 6-day old entry survives
    const result = await new MemoryPruner().prune(store, { now: () => now });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("memory without any timestamp metadata (sentinel createdAt=0) is immortal", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "no-ts", value: {} }, // no _decay, no createdAt → sentinel 0
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: 1,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("TTL = Number.MAX_SAFE_INTEGER: nothing ever expires", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "ancient", value: makeDecayValue(0) }, // epoch = ancient
      { key: "old", value: makeDecayValue(now - MS_PER_DAY * 365) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs: Number.MAX_SAFE_INTEGER,
      now: () => now,
    });
    expect(result.expired).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("multiple memories: only expired ones are removed, fresh ones survive", async () => {
    const now = 10_000_000;
    const ttlMs = MS_PER_DAY * 7;
    const store = makePrunerStore([
      { key: "exp-a", value: makeDecayValue(now - ttlMs * 2) },
      { key: "exp-b", value: makeDecayValue(now - ttlMs - 1) },
      { key: "fresh-a", value: makeDecayValue(now - ONE_HOUR) },
      { key: "fresh-b", value: makeDecayValue(now - MS_PER_DAY) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      now: () => now,
    });
    expect(result.expired).toBe(2);
    expect(result.remaining).toBe(2);
    expect(store.data.has("exp-a")).toBe(false);
    expect(store.data.has("exp-b")).toBe(false);
    expect(store.data.has("fresh-a")).toBe(true);
    expect(store.data.has("fresh-b")).toBe(true);
  });

  it("fake timers: entry is alive before TTL passes, expired after", async () => {
    vi.useFakeTimers();
    const startMs = Date.now();
    const ttlMs = 5000;

    const before = await new MemoryPruner().prune(
      makePrunerStore([{ key: "e", value: makeDecayValue(startMs) }]),
      { ttlMs },
    );
    expect(before.expired).toBe(0);

    vi.advanceTimersByTime(ttlMs + 1);

    const after = await new MemoryPruner().prune(
      makePrunerStore([{ key: "e", value: makeDecayValue(startMs) }]),
      { ttlMs },
    );
    expect(after.expired).toBe(1);

    vi.useRealTimers();
  });
});

// ===========================================================================
// SECTION 2: LRU / capacity eviction (MemoryPruner)
// ===========================================================================

describe("LRU / capacity eviction — MemoryPruner", () => {
  it("when store is at capacity, weakest-strength entry is evicted first", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "strong", value: makeDecayValue(now, 0.9) },
      { key: "medium", value: makeDecayValue(now, 0.5) },
      { key: "weak", value: makeDecayValue(now, 0.1) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 2,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(1);
    expect(result.remaining).toBe(2);
    expect(store.data.has("weak")).toBe(false);
    expect(store.data.has("strong")).toBe(true);
    expect(store.data.has("medium")).toBe(true);
  });

  it("evicts multiple entries when over capacity by N", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "k1", value: makeDecayValue(now, 0.9) },
      { key: "k2", value: makeDecayValue(now, 0.7) },
      { key: "k3", value: makeDecayValue(now, 0.3) },
      { key: "k4", value: makeDecayValue(now, 0.1) },
      { key: "k5", value: makeDecayValue(now, 0.05) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 2,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(3);
    expect(result.remaining).toBe(2);
    expect(store.data.has("k1")).toBe(true);
    expect(store.data.has("k2")).toBe(true);
    expect(store.data.has("k3")).toBe(false);
    expect(store.data.has("k4")).toBe(false);
    expect(store.data.has("k5")).toBe(false);
  });

  it("when count equals capacity limit, no eviction occurs", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "a", value: makeDecayValue(now, 0.9) },
      { key: "b", value: makeDecayValue(now, 0.5) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 2,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("tie-break in eviction: same strength → oldest (lowest createdAt) evicted first", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      {
        key: "newer",
        value: { _decay: { createdAt: now - ONE_HOUR, strength: 0.5 } },
      },
      {
        key: "older",
        value: { _decay: { createdAt: now - MS_PER_DAY, strength: 0.5 } },
      },
      { key: "recent", value: makeDecayValue(now, 0.9) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 2,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(1);
    // 'older' has same strength but lower createdAt → evicted first
    expect(store.data.has("older")).toBe(false);
    expect(store.data.has("newer")).toBe(true);
  });

  it("capacity=0 evicts all survivors (even fresh entries)", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "x", value: makeDecayValue(now, 0.99) },
      { key: "y", value: makeDecayValue(now, 0.99) },
    ]);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: 0,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(2);
    expect(result.remaining).toBe(0);
  });

  it("maxEntries=Infinity (unlimited): no eviction regardless of count", async () => {
    const now = 10_000_000;
    const entries = Array.from({ length: 100 }, (_, i) => ({
      key: `k${i}`,
      value: makeDecayValue(now, 0.01), // weak but no cap
    }));
    const store = makePrunerStore(entries);
    const result = await new MemoryPruner().prune(store, {
      maxEntries: Number.MAX_SAFE_INTEGER,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(result.evicted).toBe(0);
    expect(result.remaining).toBe(100);
  });

  it("re-insertion after eviction: evicted memory can be re-added fresh", async () => {
    const now = 10_000_000;
    const store = makePrunerStore([
      { key: "v1", value: makeDecayValue(now, 0.01) },
      { key: "v2", value: makeDecayValue(now, 0.99) },
    ]);
    await new MemoryPruner().prune(store, {
      maxEntries: 1,
      ttlMs: MS_PER_DAY * 30,
      now: () => now,
    });
    expect(store.data.has("v1")).toBe(false);

    // Re-insert the evicted entry with fresh strength
    const freshEntry = makeDecayValue(now + 100, 0.99);
    store.data.set("v1", freshEntry);

    // After re-insertion, store has 2 entries at high strength; cap=2 → no eviction
    const storeWithReinserted = makePrunerStore([
      { key: "v1", value: freshEntry },
      { key: "v2", value: makeDecayValue(now, 0.99) },
    ]);
    const result2 = await new MemoryPruner().prune(storeWithReinserted, {
      maxEntries: 2,
      ttlMs: MS_PER_DAY * 30,
      now: () => now + 100,
    });
    expect(result2.evicted).toBe(0);
    expect(result2.remaining).toBe(2);
  });

  it("TTL pass then capacity pass: expired first, then weakest survivors evicted", async () => {
    const now = 10_000_000;
    const ttlMs = MS_PER_DAY;
    const store = makePrunerStore([
      { key: "expired", value: makeDecayValue(now - ttlMs - 1, 0.99) }, // TTL expired
      { key: "weak", value: makeDecayValue(now, 0.01) }, // fresh but weak
      { key: "strong-a", value: makeDecayValue(now, 0.9) },
      { key: "strong-b", value: makeDecayValue(now, 0.8) },
    ]);
    // maxEntries=2: after TTL pass 3 remain, capacity evicts 1 weakest
    const result = await new MemoryPruner().prune(store, {
      ttlMs,
      maxEntries: 2,
      now: () => now,
    });
    expect(result.expired).toBe(1);
    expect(result.evicted).toBe(1);
    expect(result.remaining).toBe(2);
    expect(store.data.has("expired")).toBe(false);
    expect(store.data.has("weak")).toBe(false);
    expect(store.data.has("strong-a")).toBe(true);
    expect(store.data.has("strong-b")).toBe(true);
  });
});

// ===========================================================================
// SECTION 3: Access-count boosting (decay-engine reinforcement)
// ===========================================================================

describe("Access-count boosting — reinforceMemory", () => {
  it("each reinforcement doubles the half-life", () => {
    let meta = makeMeta({ halfLifeMs: 1000 });
    meta = reinforceMemory(meta);
    expect(meta.halfLifeMs).toBe(2000);
    meta = reinforceMemory(meta);
    expect(meta.halfLifeMs).toBe(4000);
    meta = reinforceMemory(meta);
    expect(meta.halfLifeMs).toBe(8000);
  });

  it("half-life caps at MAX_HALF_LIFE (30 days) regardless of reinforcements", () => {
    // Start just below cap
    let meta = makeMeta({ halfLifeMs: MAX_HALF_LIFE - 1 });
    meta = reinforceMemory(meta);
    expect(meta.halfLifeMs).toBe(MAX_HALF_LIFE);
    // Further reinforcements keep it at cap
    meta = reinforceMemory(meta);
    expect(meta.halfLifeMs).toBe(MAX_HALF_LIFE);
  });

  it("access count increments correctly across multiple reinforcements", () => {
    let meta = makeMeta({ accessCount: 0 });
    for (let i = 1; i <= 10; i++) {
      meta = reinforceMemory(meta);
      expect(meta.accessCount).toBe(i);
    }
  });

  it("higher access count means longer half-life, so strength decays slower", () => {
    const baseTime = 1_000_000;
    const elapsed = ONE_HOUR * 2;

    // Low access: halfLife = DEFAULT_HALF_LIFE
    const lowMeta = makeMeta({
      lastAccessedAt: baseTime,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    const lowStrength = calculateStrength(lowMeta, baseTime + elapsed);

    // High access: halfLife doubled 5 times
    let highMeta = makeMeta({
      lastAccessedAt: baseTime,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    for (let i = 0; i < 5; i++) {
      highMeta = { ...reinforceMemory(highMeta), lastAccessedAt: baseTime };
    }
    const highStrength = calculateStrength(highMeta, baseTime + elapsed);

    expect(highStrength).toBeGreaterThan(lowStrength);
  });

  it("reinforcement resets strength to 1 regardless of prior decay", () => {
    const meta = makeMeta({ strength: 0.05 });
    const updated = reinforceMemory(meta);
    expect(updated.strength).toBe(1);
  });

  it("reinforcement updates lastAccessedAt to current time", () => {
    const before = Date.now();
    const meta = makeMeta({ lastAccessedAt: 0 });
    const updated = reinforceMemory(meta);
    const after = Date.now();
    expect(updated.lastAccessedAt).toBeGreaterThanOrEqual(before);
    expect(updated.lastAccessedAt).toBeLessThanOrEqual(after);
  });

  it("scoreWithDecay: higher accessCount entry scores higher after same elapsed time", () => {
    const now = 2_000_000;
    const elapsed = ONE_HOUR * 12;

    // Entry A: accessed once (default half-life)
    let metaA = makeMeta({
      lastAccessedAt: now - elapsed,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    const scoreA = scoreWithDecay(1.0, metaA, now);

    // Entry B: accessed 3 times (half-life tripled by 3 doublings)
    let metaB = makeMeta({
      lastAccessedAt: now - elapsed,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    metaB = { ...reinforceMemory(metaB), lastAccessedAt: now - elapsed };
    metaB = { ...reinforceMemory(metaB), lastAccessedAt: now - elapsed };
    metaB = { ...reinforceMemory(metaB), lastAccessedAt: now - elapsed };
    const scoreB = scoreWithDecay(1.0, metaB, now);

    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it("findWeakMemories: highly-accessed memory stays strong and is NOT flagged as weak", () => {
    const now = Date.now();
    // Old but reinforced multiple times — still above 0.1 threshold
    let meta = makeMeta({
      lastAccessedAt: now - ONE_HOUR,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    for (let i = 0; i < 5; i++) {
      meta = { ...reinforceMemory(meta), lastAccessedAt: now - ONE_HOUR };
    }
    const weak = findWeakMemories([{ key: "reinforced", meta }]);
    expect(weak).toHaveLength(0);
  });

  it("findWeakMemories: rarely-accessed old memory is flagged as weak", () => {
    // Never reinforced, very old
    const meta: DecayMetadata = {
      strength: 0,
      accessCount: 0,
      lastAccessedAt: 0,
      createdAt: 0,
      halfLifeMs: 100,
    };
    const weak = findWeakMemories([{ key: "stale", meta }]);
    expect(weak).toHaveLength(1);
    expect(weak[0]!.key).toBe("stale");
  });
});

// ===========================================================================
// SECTION 4: Staleness scoring (staleness-pruner)
// ===========================================================================

describe("Staleness score calculation — computeStaleness", () => {
  it("formula: staleness = age_days * (1 / access_count)", () => {
    const now = BASE_NOW;
    const entry = makeEntry("k", "text", {
      createdAt: now - 30 * MS_PER_DAY,
      accessCount: 5,
    });
    // 30 / 5 = 6.0
    expect(computeStaleness(entry, now)).toBeCloseTo(6.0, 1);
  });

  it("staleness = age_days when accessCount is 1 (default minimum)", () => {
    const now = BASE_NOW;
    const entry = makeEntry("k", "text", {
      createdAt: now - 10 * MS_PER_DAY,
      accessCount: 1,
    });
    expect(computeStaleness(entry, now)).toBeCloseTo(10.0, 1);
  });

  it("staleness approaches 0 for very frequently accessed entry", () => {
    const now = BASE_NOW;
    const entry = makeEntry("k", "text", {
      createdAt: now - MS_PER_DAY, // 1 day old
      accessCount: 10_000,
    });
    // 1 / 10000 = 0.0001
    expect(computeStaleness(entry, now)).toBeCloseTo(0.0001, 4);
  });

  it("staleness = 0 for brand new entry (age=0)", () => {
    const now = BASE_NOW;
    const entry = makeEntry("k", "text", { createdAt: now });
    expect(computeStaleness(entry, now)).toBe(0);
  });

  it("staleness increases as time passes (fake timers)", () => {
    vi.useFakeTimers();
    const createdAt = Date.now();
    const entry = makeEntry("k", "text", { createdAt, accessCount: 1 });

    const s1 = computeStaleness(entry);

    vi.advanceTimersByTime(5 * MS_PER_DAY);
    const s2 = computeStaleness(entry);

    vi.advanceTimersByTime(10 * MS_PER_DAY);
    const s3 = computeStaleness(entry);

    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);

    vi.useRealTimers();
  });

  it("staleness with missing createdAt returns 0", () => {
    const entry = makeEntry("k", "text"); // no createdAt
    expect(computeStaleness(entry)).toBe(0);
  });

  it("staleness uses lastAccessedAt as fallback for createdAt", () => {
    const now = BASE_NOW;
    const entry = makeEntry("k", "text", {
      lastAccessedAt: now - 5 * MS_PER_DAY,
      accessCount: 5,
    });
    // 5 / 5 = 1.0
    expect(computeStaleness(entry, now)).toBeCloseTo(1.0, 1);
  });

  it("staleness with accessCount=0 treated as 1 (guards against division by zero)", () => {
    const now = BASE_NOW;
    // accessCount=0 → treated as 1 by max(1, ...)
    const entry = makeEntry("k", "text", {
      createdAt: now - 10 * MS_PER_DAY,
      accessCount: 0,
    });
    expect(computeStaleness(entry, now)).toBeCloseTo(10.0, 1);
  });

  it("staleness with negative createdAt clamped: Math.max(0, age) → 0", () => {
    // createdAt > now → age negative → clamped to 0
    const now = 1000;
    const entry = makeEntry("k", "text", {
      createdAt: now + 5000,
      accessCount: 1,
    });
    expect(computeStaleness(entry, now)).toBe(0);
  });
});

// ===========================================================================
// SECTION 5: Staleness pruning
// ===========================================================================

describe("Staleness pruning — pruneStaleMemories", () => {
  it("eviction ordering: stalest entries pruned first when maxPruneCount limits", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("stale-1", "text", {
        createdAt: now - 200 * MS_PER_DAY,
        accessCount: 1,
      }),
      makeEntry("stale-2", "text", {
        createdAt: now - 100 * MS_PER_DAY,
        accessCount: 1,
      }),
      makeEntry("stale-3", "text", {
        createdAt: now - 50 * MS_PER_DAY,
        accessCount: 1,
      }),
    ];
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      maxPruneCount: 1,
      now,
    });
    expect(result.prunedCount).toBe(1);
    // stalest (200 days) must be the one pruned
    expect(result.pruned[0]!.key).toBe("stale-1");
  });

  it("pinned memories are never evicted regardless of staleness", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("pinned-ancient", "text", {
        createdAt: now - 500 * MS_PER_DAY,
        accessCount: 1,
        pinned: true,
      }),
      makeEntry("unpinned-old", "text", {
        createdAt: now - 100 * MS_PER_DAY,
        accessCount: 1,
        pinned: false,
      }),
    ];
    const result = pruneStaleMemories(entries, { maxStaleness: 1, now });
    expect(result.pruned.map((e) => e.key)).not.toContain("pinned-ancient");
    expect(result.kept.some((e) => e.key === "pinned-ancient")).toBe(true);
  });

  it("pinned memories stay even when all other entries would be pruned", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("pin-1", "text", {
        createdAt: now - 1000 * MS_PER_DAY,
        accessCount: 1,
        pinned: true,
      }),
      makeEntry("pin-2", "text", {
        createdAt: now - 900 * MS_PER_DAY,
        accessCount: 1,
        pinned: true,
      }),
    ];
    const result = pruneStaleMemories(entries, { maxStaleness: 0, now });
    expect(result.prunedCount).toBe(0);
    expect(result.kept).toHaveLength(2);
  });

  it("high-importance entries are immune to pruning", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("critical", "text", {
        createdAt: now - 365 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.95,
      }),
    ];
    const result = pruneStaleMemories(entries, {
      maxStaleness: 1,
      importanceThreshold: 0.8,
      now,
    });
    expect(result.prunedCount).toBe(0);
    expect(result.kept[0]!.key).toBe("critical");
  });

  it("entries at exactly importanceThreshold are protected", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("at-threshold", "text", {
        createdAt: now - 500 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.8,
      }),
    ];
    const result = pruneStaleMemories(entries, {
      maxStaleness: 1,
      importanceThreshold: 0.8,
      now,
    });
    expect(result.prunedCount).toBe(0);
  });

  it("batch eviction: all stale entries evicted when no count limit", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`k${i}`, "text", {
        createdAt: now - (100 + i) * MS_PER_DAY,
        accessCount: 1,
      }),
    );
    const result = pruneStaleMemories(entries, { maxStaleness: 30, now });
    expect(result.prunedCount).toBe(10);
    expect(result.kept).toHaveLength(0);
  });

  it("access-count boosting: same age, higher access count → lower staleness → survives", () => {
    const now = BASE_NOW;
    const ageDays = 60;
    const entries: MemoryEntry[] = [
      makeEntry("low-access", "text", {
        createdAt: now - ageDays * MS_PER_DAY,
        accessCount: 1,
      }), // staleness=60
      makeEntry("high-access", "text", {
        createdAt: now - ageDays * MS_PER_DAY,
        accessCount: 100,
      }), // staleness=0.6
    ];
    const result = pruneStaleMemories(entries, { maxStaleness: 30, now });
    const prunedKeys = result.pruned.map((e) => e.key);
    expect(prunedKeys).toContain("low-access");
    expect(prunedKeys).not.toContain("high-access");
  });

  it("maxAgeDays: very old entry pruned even with high access count", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("ancient-active", "text", {
        createdAt: now - 200 * MS_PER_DAY,
        accessCount: 10_000,
      }),
    ];
    const result = pruneStaleMemories(entries, {
      maxStaleness: 100,
      maxAgeDays: 90,
      now,
    });
    expect(result.prunedCount).toBe(1);
  });

  it("maxAgeDays=Infinity: age alone never triggers pruning", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("old-frequently-accessed", "text", {
        createdAt: now - 1000 * MS_PER_DAY,
        accessCount: 1,
      }),
    ];
    const result = pruneStaleMemories(entries, {
      maxStaleness: 100_000, // very high threshold
      maxAgeDays: Infinity,
      now,
    });
    expect(result.prunedCount).toBe(0);
  });

  it("empty input returns empty pruned and kept", () => {
    const result = pruneStaleMemories([]);
    expect(result.pruned).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.prunedCount).toBe(0);
  });

  it("all entries fresh: none pruned", () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("fresh-a", "text", {
        createdAt: now - MS_PER_DAY,
        accessCount: 5,
      }),
      makeEntry("fresh-b", "text", {
        createdAt: now - 2 * MS_PER_DAY,
        accessCount: 10,
      }),
    ];
    const result = pruneStaleMemories(entries, { maxStaleness: 30, now });
    expect(result.prunedCount).toBe(0);
    expect(result.kept).toHaveLength(2);
  });
});

// ===========================================================================
// SECTION 6: Decay over time (fake timers)
// ===========================================================================

describe("Decay over time — fake timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("strength is 1 when freshly created", () => {
    vi.useFakeTimers();
    const meta = createDecayMetadata();
    expect(calculateStrength(meta)).toBeCloseTo(1, 5);
  });

  it("strength decreases monotonically as time advances", () => {
    vi.useFakeTimers();
    const created = Date.now();
    const meta = makeMeta({
      lastAccessedAt: created,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });

    const strengths: number[] = [];
    for (let h = 0; h <= 24; h += 4) {
      vi.setSystemTime(created + h * ONE_HOUR);
      strengths.push(calculateStrength(meta));
    }

    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]!).toBeLessThanOrEqual(strengths[i - 1]!);
    }
  });

  it("strength never goes negative", () => {
    vi.useFakeTimers();
    const created = 0;
    const meta = makeMeta({
      lastAccessedAt: created,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    // Advance 100 days
    vi.setSystemTime(created + 100 * MS_PER_DAY);
    const strength = calculateStrength(meta);
    expect(strength).toBeGreaterThanOrEqual(0);
  });

  it("reinforced memory decays slower than non-reinforced memory", () => {
    vi.useFakeTimers();
    const base = Date.now();

    // Non-reinforced meta
    const plain = makeMeta({
      lastAccessedAt: base,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });

    // Reinforced meta (3 reinforcements)
    let reinforced = makeMeta({
      lastAccessedAt: base,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    reinforced = { ...reinforceMemory(reinforced), lastAccessedAt: base };
    reinforced = { ...reinforceMemory(reinforced), lastAccessedAt: base };
    reinforced = { ...reinforceMemory(reinforced), lastAccessedAt: base };

    vi.advanceTimersByTime(12 * ONE_HOUR);
    const now = Date.now();

    const plainStrength = calculateStrength(plain, now);
    const reinforcedStrength = calculateStrength(reinforced, now);
    expect(reinforcedStrength).toBeGreaterThan(plainStrength);
  });

  it("findWeakMemories detects memories that crossed the 0.1 threshold over time", () => {
    vi.useFakeTimers();
    const base = Date.now();
    const meta = makeMeta({ lastAccessedAt: base, halfLifeMs: ONE_HOUR * 2 });

    // Fresh: not weak
    expect(findWeakMemories([{ key: "k", meta }])).toHaveLength(0);

    // Advance until strength < 0.1
    // e^(-t/2h) < 0.1  →  t > -2h*ln(0.1) ≈ 4.6 hours
    vi.advanceTimersByTime(ONE_HOUR * 10);
    const weakNow = Date.now();
    const weakMeta = makeMeta({
      lastAccessedAt: base,
      halfLifeMs: ONE_HOUR * 2,
    });
    const result = findWeakMemories([{ key: "k", meta: weakMeta }]);
    expect(result).toHaveLength(1);
    void weakNow; // suppress unused var lint
  });
});

// ===========================================================================
// SECTION 7: createDecayMetadata edge cases
// ===========================================================================

describe("createDecayMetadata — initialization", () => {
  it("default metadata: strength=1, accessCount=0, halfLife=24h", () => {
    const meta = createDecayMetadata();
    expect(meta.strength).toBe(1);
    expect(meta.accessCount).toBe(0);
    expect(meta.halfLifeMs).toBe(DEFAULT_HALF_LIFE);
  });

  it("importance=0 creates metadata with strength=0", () => {
    const meta = createDecayMetadata({ importance: 0 });
    expect(meta.strength).toBe(0);
  });

  it("importance=0.5 creates metadata with strength=0.5", () => {
    const meta = createDecayMetadata({ importance: 0.5 });
    expect(meta.strength).toBe(0.5);
  });

  it("importance clamped to [0, 1]: above 1 becomes 1", () => {
    const meta = createDecayMetadata({ importance: 5 });
    expect(meta.strength).toBe(1);
  });

  it("importance clamped to [0, 1]: below 0 becomes 0", () => {
    const meta = createDecayMetadata({ importance: -1 });
    expect(meta.strength).toBe(0);
  });

  it("createdAt === lastAccessedAt for fresh metadata", () => {
    const before = Date.now();
    const meta = createDecayMetadata();
    const after = Date.now();
    expect(meta.createdAt).toBeGreaterThanOrEqual(before);
    expect(meta.createdAt).toBeLessThanOrEqual(after);
    expect(meta.lastAccessedAt).toBe(meta.createdAt);
  });
});

// ===========================================================================
// SECTION 8: Malformed / missing decay metadata handling
// ===========================================================================

describe("Malformed and missing decay metadata — graceful handling", () => {
  it("computeStaleness: entry with createdAt=0 returns 0 (sentinel)", () => {
    const entry = makeEntry("k", "text", { createdAt: 0 });
    // createdAt=0 → condition: createdAt <= 0 → return 0
    expect(computeStaleness(entry)).toBe(0);
  });

  it("computeStaleness: entry with negative createdAt returns 0", () => {
    const entry = makeEntry("k", "text", { createdAt: -1000 });
    expect(computeStaleness(entry)).toBe(0);
  });

  it("pruneStaleMemories: entry with missing all timestamps survives (staleness=0)", () => {
    const result = pruneStaleMemories([makeEntry("no-ts", "text")], {
      maxStaleness: 0,
      now: 10_000_000,
    });
    expect(result.prunedCount).toBe(0);
    expect(result.kept).toHaveLength(1);
  });

  it("calculateStrength: handles meta with createdAt in the past correctly", () => {
    const meta = makeMeta({ lastAccessedAt: 0, halfLifeMs: DEFAULT_HALF_LIFE });
    const strength = calculateStrength(meta, MS_PER_DAY); // 1 day elapsed
    expect(strength).toBeGreaterThan(0);
    expect(strength).toBeLessThan(1);
  });

  it("findWeakMemories: empty records list returns empty", () => {
    expect(findWeakMemories([])).toEqual([]);
  });

  it("findWeakMemories: single strong memory returns empty", () => {
    const meta = makeMeta({
      lastAccessedAt: Date.now(),
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    expect(findWeakMemories([{ key: "fresh", meta }])).toHaveLength(0);
  });

  it("MemoryPruner: empty store returns zero counts", async () => {
    const store = makePrunerStore();
    const result = await new MemoryPruner().prune(store, {
      now: () => 10_000_000,
    });
    expect(result).toEqual({ expired: 0, evicted: 0, remaining: 0 });
  });

  it("MemoryPruner: store.search() failure returns zero counts gracefully", async () => {
    const store: ConsolidationStore = {
      search: vi.fn().mockRejectedValue(new Error("search failure")),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const result = await new MemoryPruner().prune(store);
    expect(result).toEqual({ expired: 0, evicted: 0, remaining: 0 });
  });
});

// ===========================================================================
// SECTION 9: StalenessPruner class (stateful wrapper)
// ===========================================================================

describe("StalenessPruner class", () => {
  it("prune() uses configured maxStaleness", async () => {
    const now = BASE_NOW;
    const pruner = new StalenessPruner({ maxStaleness: 10 });
    const entries: MemoryEntry[] = [
      makeEntry("stale", "text", {
        createdAt: now - 50 * MS_PER_DAY,
        accessCount: 1,
      }), // 50 > 10
      makeEntry("fresh", "text", {
        createdAt: now - 2 * MS_PER_DAY,
        accessCount: 5,
      }), // 0.4 < 10
    ];
    const result = await pruner.prune(entries, now);
    expect(result.prunedCount).toBe(1);
    expect(result.pruned[0]!.key).toBe("stale");
  });

  it("prune() with causalGraph removes pruned nodes from graph", async () => {
    const now = BASE_NOW;
    const removeNode = vi.fn().mockResolvedValue(2);
    const mockGraph = { removeNode };

    const pruner = new StalenessPruner({
      maxStaleness: 10,
      causalGraph: mockGraph as Parameters<
        typeof StalenessPruner.prototype.prune
      >[0] extends never
        ? never
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any,
      causalNamespace: "test-ns",
    });

    const entries: MemoryEntry[] = [
      makeEntry("stale", "text", {
        createdAt: now - 50 * MS_PER_DAY,
        accessCount: 1,
      }),
    ];

    const result = await pruner.prune(entries, now);
    expect(result.causalRelationsRemoved).toBe(2);
    expect(removeNode).toHaveBeenCalledWith("stale", "test-ns");
  });

  it("prune() result includes causalRelationsRemoved even without causal graph (= 0)", async () => {
    const now = BASE_NOW;
    const pruner = new StalenessPruner({ maxStaleness: 1 });
    const entries: MemoryEntry[] = [
      makeEntry("stale", "text", {
        createdAt: now - 100 * MS_PER_DAY,
        accessCount: 1,
      }),
    ];
    const result = await pruner.prune(entries, now);
    expect(result.causalRelationsRemoved).toBe(0);
  });
});

// ===========================================================================
// SECTION 10: pruneStaleMemoriesWithGraph (async causal integration)
// ===========================================================================

describe("pruneStaleMemoriesWithGraph — causal graph integration", () => {
  it("removes pruned nodes from causal graph and counts relations removed", async () => {
    const now = BASE_NOW;
    const removeNode = vi
      .fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    const entries: MemoryEntry[] = [
      makeEntry("e1", "text", {
        createdAt: now - 100 * MS_PER_DAY,
        accessCount: 1,
      }),
      makeEntry("e2", "text", {
        createdAt: now - 200 * MS_PER_DAY,
        accessCount: 1,
      }),
      makeEntry("keep", "text", {
        createdAt: now - 1 * MS_PER_DAY,
        accessCount: 5,
      }),
    ];

    const result = await pruneStaleMemoriesWithGraph(entries, {
      maxStaleness: 30,
      now,
      causalGraph: { removeNode } as Parameters<
        typeof pruneStaleMemoriesWithGraph
      >[1]["causalGraph"],
      causalNamespace: "default",
    });

    expect(result.prunedCount).toBe(2);
    expect(result.causalRelationsRemoved).toBe(4); // 3 + 1
    expect(removeNode).toHaveBeenCalledTimes(2);
  });

  it("without causalGraph, causalRelationsRemoved is 0", async () => {
    const now = BASE_NOW;
    const entries: MemoryEntry[] = [
      makeEntry("stale", "text", {
        createdAt: now - 100 * MS_PER_DAY,
        accessCount: 1,
      }),
    ];
    const result = await pruneStaleMemoriesWithGraph(entries, {
      maxStaleness: 10,
      now,
    });
    expect(result.causalRelationsRemoved).toBe(0);
    expect(result.prunedCount).toBe(1);
  });
});

// ===========================================================================
// SECTION 11: scoreWithDecay edge cases
// ===========================================================================

describe("scoreWithDecay — scoring integration", () => {
  it("score is 0 when relevance is 0, regardless of strength", () => {
    const meta = makeMeta({ lastAccessedAt: Date.now() });
    expect(scoreWithDecay(0, meta)).toBe(0);
  });

  it("score equals relevance when memory is perfectly fresh (elapsed=0)", () => {
    const now = Date.now();
    const meta = makeMeta({ lastAccessedAt: now });
    const score = scoreWithDecay(0.75, meta, now);
    expect(score).toBeCloseTo(0.75, 5);
  });

  it("score decreases as memory ages", () => {
    const now = 1_000_000;
    const meta = makeMeta({
      lastAccessedAt: now - ONE_HOUR,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });
    const metaFresh = makeMeta({
      lastAccessedAt: now,
      halfLifeMs: DEFAULT_HALF_LIFE,
    });

    const scoreFresh = scoreWithDecay(1, metaFresh, now);
    const scoreOld = scoreWithDecay(1, meta, now);
    expect(scoreFresh).toBeGreaterThan(scoreOld);
  });

  it("score is bounded [0, relevance]", () => {
    const now = Date.now();
    const relevance = 0.8;
    // Fresh: score ≈ relevance
    const metaFresh = makeMeta({ lastAccessedAt: now });
    const freshScore = scoreWithDecay(relevance, metaFresh, now);
    expect(freshScore).toBeLessThanOrEqual(relevance);
    expect(freshScore).toBeGreaterThanOrEqual(0);

    // Stale: score < relevance
    const metaOld: DecayMetadata = {
      strength: 0,
      accessCount: 0,
      lastAccessedAt: 0,
      createdAt: 0,
      halfLifeMs: 1,
    };
    const oldScore = scoreWithDecay(relevance, metaOld, now);
    expect(oldScore).toBeLessThanOrEqual(relevance);
    expect(oldScore).toBeGreaterThanOrEqual(0);
  });
});
