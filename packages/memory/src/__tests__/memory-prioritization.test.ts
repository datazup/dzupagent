/**
 * Memory Prioritization Tests
 *
 * Tests covering importance scoring, priority queue behavior, and
 * priority-based retrieval using the decay-engine, staleness-pruner,
 * and consolidation-types from @dzupagent/memory.
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
import { computeStaleness, pruneStaleMemories } from "../staleness-pruner.js";
import type { MemoryEntry } from "../consolidation-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function makeDecayMeta(overrides?: Partial<DecayMetadata>): DecayMetadata {
  const now = Date.now();
  return {
    strength: 1,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    halfLifeMs: MS_PER_DAY,
    ...overrides,
  };
}

function makeEntry(
  key: string,
  text: string,
  extras?: Partial<MemoryEntry>
): MemoryEntry {
  return { key, text, ...extras };
}

// ---------------------------------------------------------------------------
// 1. Importance scoring — importance weight creates initial strength
// ---------------------------------------------------------------------------

describe("importance scoring", () => {
  it("high importance results in high initial strength", () => {
    const high = createDecayMetadata({ importance: 0.9 });
    const low = createDecayMetadata({ importance: 0.1 });
    expect(high.strength).toBeGreaterThan(low.strength);
  });

  it("importance of 1 yields full initial strength", () => {
    const meta = createDecayMetadata({ importance: 1 });
    expect(meta.strength).toBe(1);
  });

  it("importance of 0 yields zero initial strength", () => {
    const meta = createDecayMetadata({ importance: 0 });
    expect(meta.strength).toBe(0);
  });

  it("default importance (omitted) yields strength 1", () => {
    const meta = createDecayMetadata();
    expect(meta.strength).toBe(1);
  });

  it("importance 0.5 yields strength 0.5", () => {
    const meta = createDecayMetadata({ importance: 0.5 });
    expect(meta.strength).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// 2. Importance range — importance score is bounded [0, 1]
// ---------------------------------------------------------------------------

describe("importance range bounds", () => {
  it("importance above 1 is clamped to 1", () => {
    const meta = createDecayMetadata({ importance: 5 });
    expect(meta.strength).toBe(1);
  });

  it("importance below 0 is clamped to 0", () => {
    const meta = createDecayMetadata({ importance: -3 });
    expect(meta.strength).toBe(0);
  });

  it("importance exactly at boundary 0 is accepted", () => {
    const meta = createDecayMetadata({ importance: 0 });
    expect(meta.strength).toBeGreaterThanOrEqual(0);
    expect(meta.strength).toBeLessThanOrEqual(1);
  });

  it("importance exactly at boundary 1 is accepted", () => {
    const meta = createDecayMetadata({ importance: 1 });
    expect(meta.strength).toBeGreaterThanOrEqual(0);
    expect(meta.strength).toBeLessThanOrEqual(1);
  });

  it("strength computed by calculateStrength is never negative", () => {
    const meta = makeDecayMeta({ lastAccessedAt: 0, halfLifeMs: 1000 });
    const strength = calculateStrength(meta, 1_000_000);
    expect(strength).toBeGreaterThanOrEqual(0);
  });

  it("strength computed by calculateStrength never exceeds 1", () => {
    const meta = makeDecayMeta();
    const strength = calculateStrength(meta, Date.now());
    expect(strength).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Importance factors — recency, access count, explicit importance
// ---------------------------------------------------------------------------

describe("importance factors", () => {
  it("recency: recently accessed memory has higher strength than old memory", () => {
    const now = 1_000_000;
    const recent = makeDecayMeta({
      lastAccessedAt: now - HOUR_MS,
      halfLifeMs: MS_PER_DAY,
    });
    const old = makeDecayMeta({
      lastAccessedAt: now - 10 * MS_PER_DAY,
      halfLifeMs: MS_PER_DAY,
    });
    expect(calculateStrength(recent, now)).toBeGreaterThan(
      calculateStrength(old, now)
    );
  });

  it("access count: reinforced memory has longer half-life (more durable)", () => {
    const base = makeDecayMeta({ halfLifeMs: MS_PER_DAY });
    const reinforced = reinforceMemory(base);
    expect(reinforced.halfLifeMs).toBeGreaterThan(base.halfLifeMs);
  });

  it("access count: memory reinforced multiple times decays slower", () => {
    const now = 1_000_000;
    let meta = makeDecayMeta({ lastAccessedAt: now, halfLifeMs: MS_PER_DAY });
    // Reinforce 5 times
    for (let i = 0; i < 5; i++) {
      meta = reinforceMemory(meta);
    }
    const future = now + 3 * MS_PER_DAY;
    const baseline = makeDecayMeta({
      lastAccessedAt: now,
      halfLifeMs: MS_PER_DAY,
    });
    expect(calculateStrength(meta, future)).toBeGreaterThan(
      calculateStrength(baseline, future)
    );
  });

  it("explicit importance: higher importance entry has higher initial strength", () => {
    // createDecayMetadata encodes importance as the initial strength value.
    // scoreWithDecay recomputes strength from elapsed time, so to see the
    // importance difference we compare initial strength directly — that is the
    // documented API contract (importance sets durability at creation time).
    const high = createDecayMetadata({ importance: 0.9 });
    const low = createDecayMetadata({ importance: 0.3 });
    expect(high.strength).toBeGreaterThan(low.strength);
  });

  it("score with decay combines relevance and strength multiplicatively", () => {
    const now = 1_000_000;
    const meta = makeDecayMeta({ lastAccessedAt: now });
    const score = scoreWithDecay(0.8, meta, now);
    // strength ≈ 1 (freshly accessed), so score ≈ 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
/**
 * COVERAGE GAP — deliberately skipped suite (DZUPAGENT-TEST-C-14).
 *
 * This file previously held 20 `it()` blocks whose entire subject under test
 * was `PriorityQueue` — a class DEFINED LOCALLY in this file. Five top-level
 * describes ("priority queue insertion" 4, "priority queue ordering" 3,
 * "priority queue pop" 3, "priority queue peek" 3, "priority tie-breaking" 2)
 * plus 5 of the 7 blocks in "empty priority queue edge cases" asserted only
 * against the local queue's own push/pop/peek/size/toArray/isEmpty. (The
 * audit enumerated 15; the 5 in the edge-cases describe were undercounted and
 * are removed here too — the 2 blocks in that describe that drive real
 * `findWeakMemories` / `pruneStaleMemories` are kept.) A grep for
 * `PriorityQueue` over all non-test source in all 36 packages returns
 * nothing: no priority queue ships anywhere. The file's own header (`:49`)
 * already admitted this.
 *
 * The remaining 44 `it()` blocks in this file are NOT affected: they
 * legitimately exercise the real `decay-engine` (`scoreWithDecay`,
 * `findWeakMemories`) and `staleness-pruner` (`computeStaleness`,
 * `pruneStaleMemories`) modules.
 *
 * UNTESTED PRODUCTION SYMBOLS — memory ranking as actually shipped is
 * score-based, not queue-based; there is no shipped priority-queue data
 * structure to point at. Ordering/tie-breaking behaviour that DOES ship
 * lives in `scoreWithDecay` / `findWeakMemories`
 * (packages/memory/src/decay-engine.ts), which the surviving describes in
 * this file already cover.
 *
 * Removed 2026-08-14 (DZUPAGENT-TEST-C-14 / RF-07).
 */
describe.skip("priority queue (no production priority-queue symbol ships in @dzupagent/memory)", () => {
  it("needs a shipped queue symbol before insertion/ordering/pop/peek/tie-breaking can be covered", () => {});
});


describe("priority-based retrieval", () => {
  it("memories ranked by scoreWithDecay return highest score first", () => {
    const now = 1_000_000;
    const memories = [
      {
        key: "old",
        relevance: 0.9,
        meta: makeDecayMeta({ lastAccessedAt: now - 5 * MS_PER_DAY }),
      },
      {
        key: "fresh",
        relevance: 0.9,
        meta: makeDecayMeta({ lastAccessedAt: now - HOUR_MS }),
      },
      {
        key: "medium",
        relevance: 0.9,
        meta: makeDecayMeta({ lastAccessedAt: now - MS_PER_DAY }),
      },
    ];

    const scored = memories
      .map((m) => ({
        key: m.key,
        score: scoreWithDecay(m.relevance, m.meta, now),
      }))
      .sort((a, b) => b.score - a.score);

    expect(scored[0].key).toBe("fresh");
    expect(scored[scored.length - 1].key).toBe("old");
  });

  it("lower relevance but higher strength can outrank higher relevance old memory", () => {
    const now = 1_000_000;
    const freshLowRelevance = {
      relevance: 0.5,
      meta: makeDecayMeta({ lastAccessedAt: now, halfLifeMs: MS_PER_DAY }),
    };
    const oldHighRelevance = {
      relevance: 0.9,
      meta: makeDecayMeta({
        lastAccessedAt: now - 10 * MS_PER_DAY,
        halfLifeMs: MS_PER_DAY,
      }),
    };

    const freshScore = scoreWithDecay(
      freshLowRelevance.relevance,
      freshLowRelevance.meta,
      now
    );
    const oldScore = scoreWithDecay(
      oldHighRelevance.relevance,
      oldHighRelevance.meta,
      now
    );

    // Fresh at 0.5 * ~1.0 = ~0.5 vs old at 0.9 * ~e^(-10) ≈ 0.9 * 0.000045 ≈ 0.000041
    expect(freshScore).toBeGreaterThan(oldScore);
  });

  it("results maintain consistent ordering regardless of insertion order", () => {
    const now = 1_000_000;
    const makeScored = (key: string, lastAccess: number) => ({
      key,
      score: scoreWithDecay(
        1.0,
        makeDecayMeta({ lastAccessedAt: lastAccess }),
        now
      ),
    });

    const unordered = [
      makeScored("third", now - 3 * HOUR_MS),
      makeScored("first", now - HOUR_MS),
      makeScored("second", now - 2 * HOUR_MS),
    ];
    unordered.sort((a, b) => b.score - a.score);
    expect(unordered.map((s) => s.key)).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// 10. Priority update — accessing a memory increases its priority
// ---------------------------------------------------------------------------

describe("priority update on access", () => {
  it("reinforcing a memory resets strength to 1", () => {
    const meta = makeDecayMeta({ strength: 0.3 });
    const updated = reinforceMemory(meta);
    expect(updated.strength).toBe(1);
  });

  it("reinforcing increments access count", () => {
    const meta = makeDecayMeta({ accessCount: 2 });
    const updated = reinforceMemory(meta);
    expect(updated.accessCount).toBe(3);
  });

  it("reinforced memory has higher score than non-reinforced at same future time", () => {
    const now = 1_000_000;
    const base = makeDecayMeta({ lastAccessedAt: now, halfLifeMs: MS_PER_DAY });
    const reinforced = reinforceMemory(base);

    // After 2 days
    const future = now + 2 * MS_PER_DAY;
    const baseScore = scoreWithDecay(1.0, base, future);
    const reinforcedScore = scoreWithDecay(
      1.0,
      { ...reinforced, lastAccessedAt: now },
      future
    );
    expect(reinforcedScore).toBeGreaterThan(baseScore);
  });

  it("multiple reinforcements accumulate higher access count", () => {
    let meta = makeDecayMeta({ accessCount: 0 });
    for (let i = 0; i < 5; i++) {
      meta = reinforceMemory(meta);
    }
    expect(meta.accessCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 11. Priority decay — old memories lose priority over time (fake timers)
// ---------------------------------------------------------------------------

describe("priority decay with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("strength decreases as time advances", () => {
    const createdAt = Date.now();
    const meta = makeDecayMeta({
      lastAccessedAt: createdAt,
      halfLifeMs: MS_PER_DAY,
    });

    const s0 = calculateStrength(meta, Date.now());

    // Advance 12 hours
    vi.advanceTimersByTime(12 * HOUR_MS);
    const s12 = calculateStrength(meta, Date.now());

    // Advance another 12 hours (total 24h = one half-life equivalent)
    vi.advanceTimersByTime(12 * HOUR_MS);
    const s24 = calculateStrength(meta, Date.now());

    expect(s0).toBeCloseTo(1, 5);
    expect(s12).toBeLessThan(s0);
    expect(s24).toBeLessThan(s12);
  });

  it("memory is found weak after sufficient time", () => {
    const start = Date.now();
    const meta = makeDecayMeta({ lastAccessedAt: start, halfLifeMs: HOUR_MS });

    // Advance 24 hours — very low strength
    vi.advanceTimersByTime(24 * HOUR_MS);

    const records = [{ key: "old-mem", meta }];
    const weak = findWeakMemories(records, 0.5);
    expect(weak).toHaveLength(1);
    expect(weak[0].key).toBe("old-mem");
  });

  it("freshly created memory is not weak", () => {
    const meta = makeDecayMeta();
    const records = [{ key: "fresh", meta }];
    const weak = findWeakMemories(records, 0.5);
    expect(weak).toHaveLength(0);
  });

  it("weak memories are sorted weakest first", () => {
    const start = Date.now();
    const veryOld = makeDecayMeta({
      lastAccessedAt: start - 48 * HOUR_MS,
      halfLifeMs: HOUR_MS,
    });
    const old = makeDecayMeta({
      lastAccessedAt: start - 12 * HOUR_MS,
      halfLifeMs: HOUR_MS,
    });
    const records = [
      { key: "old", meta: old },
      { key: "very-old", meta: veryOld },
    ];
    const weak = findWeakMemories(records, 0.01);
    expect(weak[0].strength).toBeLessThan(weak[1].strength);
    expect(weak[0].key).toBe("very-old");
  });
});

// ---------------------------------------------------------------------------
// 12. Pinned memory — always has maximum priority (never pruned)
// ---------------------------------------------------------------------------

describe("pinned memory protection", () => {
  it("pinned entry is never pruned regardless of staleness", () => {
    const now = Date.now();
    const staleButPinned = makeEntry("pinned", "important fact", {
      pinned: true,
      createdAt: now - 200 * MS_PER_DAY,
      accessCount: 1,
    });
    const result = pruneStaleMemories([staleButPinned], {
      maxStaleness: 0,
      now,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.pruned).toHaveLength(0);
  });

  it("pinned entry with very low access count survives aggressive pruning", () => {
    const now = Date.now();
    const pinned = makeEntry("p", "pinned", {
      pinned: true,
      createdAt: now - 365 * MS_PER_DAY,
      accessCount: 1,
    });
    const result = pruneStaleMemories([pinned], {
      maxStaleness: 0.001,
      maxAgeDays: 1,
      now,
    });
    expect(result.kept).toContainEqual(pinned);
  });

  it("non-pinned stale entry is pruned when pinned entry is kept", () => {
    const now = Date.now();
    const stale = makeEntry("stale", "old fact", {
      createdAt: now - 100 * MS_PER_DAY,
      accessCount: 1,
    });
    const pinned = makeEntry("pinned", "vital fact", {
      pinned: true,
      createdAt: now - 100 * MS_PER_DAY,
      accessCount: 1,
    });
    const result = pruneStaleMemories([stale, pinned], {
      maxStaleness: 0,
      now,
    });
    expect(result.kept).toContainEqual(pinned);
    expect(result.pruned).toContainEqual(stale);
  });

  it("multiple pinned entries all survive pruning", () => {
    const now = Date.now();
    const entries = [1, 2, 3].map((i) =>
      makeEntry(`pinned-${i}`, `fact ${i}`, {
        pinned: true,
        createdAt: now - 200 * MS_PER_DAY,
        accessCount: 1,
      })
    );
    const result = pruneStaleMemories(entries, { maxStaleness: 0, now });
    expect(result.kept).toHaveLength(3);
    expect(result.pruned).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Priority filter — only return memories above minimum threshold
// ---------------------------------------------------------------------------

describe("priority filter", () => {
  it("findWeakMemories with threshold 0.5 keeps strong memories out", () => {
    const now = Date.now();
    const strong = makeDecayMeta({ lastAccessedAt: now });
    const weak = makeDecayMeta({
      lastAccessedAt: now - 48 * HOUR_MS,
      halfLifeMs: HOUR_MS,
    });
    const records = [
      { key: "strong", meta: strong },
      { key: "weak", meta: weak },
    ];
    const result = findWeakMemories(records, 0.5);
    expect(result.map((r) => r.key)).toContain("weak");
    expect(result.map((r) => r.key)).not.toContain("strong");
  });

  it("threshold 0 returns no memories as weak", () => {
    const records = [
      { key: "a", meta: makeDecayMeta({ lastAccessedAt: 0, halfLifeMs: 1 }) },
    ];
    const result = findWeakMemories(records, 0);
    expect(result).toHaveLength(0);
  });

  it("threshold 1 returns every memory as weak", () => {
    const now = Date.now();
    const records = [
      { key: "fresh", meta: makeDecayMeta({ lastAccessedAt: now }) },
      {
        key: "old",
        meta: makeDecayMeta({
          lastAccessedAt: now - MS_PER_DAY,
          halfLifeMs: HOUR_MS,
        }),
      },
    ];
    // strength = e^(0) = 1 for fresh, which is NOT < 1, so fresh should NOT be returned
    const result = findWeakMemories(records, 1);
    // Only the one with strength strictly < 1 should appear
    expect(result.map((r) => r.key)).toContain("old");
  });

  it("pruneStaleMemories importance threshold protects high-importance entries", () => {
    const now = Date.now();
    const important = makeEntry("imp", "vital", {
      importance: 0.9,
      createdAt: now - 50 * MS_PER_DAY,
      accessCount: 1,
    });
    const unimportant = makeEntry("unimp", "trivial", {
      importance: 0.1,
      createdAt: now - 50 * MS_PER_DAY,
      accessCount: 1,
    });
    const result = pruneStaleMemories([important, unimportant], {
      maxStaleness: 0,
      importanceThreshold: 0.8,
      now,
    });
    expect(result.kept).toContainEqual(important);
    expect(result.pruned).toContainEqual(unimportant);
  });
});

// ---------------------------------------------------------------------------
// 14. Priority-weighted sampling — higher priority memories more likely sampled
// ---------------------------------------------------------------------------

describe("priority-weighted sampling", () => {
  /**
   * Weighted random selection: draws one item proportional to priority.
   * Pure helper for testing — not production code.
   */
  function weightedSample<T>(
    items: Array<{ value: T; priority: number }>,
    seed: number
  ): T {
    const total = items.reduce((sum, i) => sum + i.priority, 0);
    let target = ((seed % 1000) / 1000) * total;
    for (const item of items) {
      target -= item.priority;
      if (target <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }

  it("high-priority items are sampled more often in simulation", () => {
    const items = [
      { value: "high", priority: 0.9 },
      { value: "low", priority: 0.1 },
    ];

    const counts = { high: 0, low: 0 };
    for (let seed = 0; seed < 1000; seed++) {
      const sampled = weightedSample(items, seed) as "high" | "low";
      counts[sampled]++;
    }
    expect(counts.high).toBeGreaterThan(counts.low);
  });

  it("equal priority items are sampled roughly equally", () => {
    const items = [
      { value: "a", priority: 0.5 },
      { value: "b", priority: 0.5 },
    ];
    const counts = { a: 0, b: 0 };
    for (let seed = 0; seed < 1000; seed++) {
      const sampled = weightedSample(items, seed) as "a" | "b";
      counts[sampled]++;
    }
    // Each should be ~50% — allow wide tolerance (30-70%)
    expect(counts.a).toBeGreaterThan(250);
    expect(counts.b).toBeGreaterThan(250);
  });

  it("zero-priority item is never sampled when others have positive priority", () => {
    const items = [
      { value: "alive", priority: 1.0 },
      { value: "dead", priority: 0.0 },
    ];
    const results = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      results.add(weightedSample(items, seed) as string);
    }
    expect(results.has("dead")).toBe(false);
    expect(results.has("alive")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. Priority serialization — priority values preserved in serialize/deserialize
// ---------------------------------------------------------------------------

describe("priority serialization", () => {
  it("DecayMetadata round-trips through JSON serialization", () => {
    const original = makeDecayMeta({
      strength: 0.75,
      accessCount: 3,
      halfLifeMs: 2 * MS_PER_DAY,
    });
    const serialized = JSON.stringify(original);
    const restored: DecayMetadata = JSON.parse(serialized);
    expect(restored.strength).toBe(original.strength);
    expect(restored.accessCount).toBe(original.accessCount);
    expect(restored.halfLifeMs).toBe(original.halfLifeMs);
    expect(restored.lastAccessedAt).toBe(original.lastAccessedAt);
    expect(restored.createdAt).toBe(original.createdAt);
  });

  it("MemoryEntry with importance round-trips through JSON serialization", () => {
    const entry: MemoryEntry = {
      key: "test",
      text: "important fact",
      importance: 0.8,
      pinned: true,
      accessCount: 5,
      createdAt: 1_000_000,
      lastAccessedAt: 2_000_000,
    };
    const serialized = JSON.stringify(entry);
    const restored: MemoryEntry = JSON.parse(serialized);
    expect(restored.importance).toBe(0.8);
    expect(restored.pinned).toBe(true);
    expect(restored.accessCount).toBe(5);
  });

  it("calculateStrength on restored DecayMetadata gives same result", () => {
    const now = 5_000_000;
    const original = makeDecayMeta({
      lastAccessedAt: now - HOUR_MS,
      halfLifeMs: MS_PER_DAY,
    });
    const restored: DecayMetadata = JSON.parse(JSON.stringify(original));
    expect(calculateStrength(original, now)).toBeCloseTo(
      calculateStrength(restored, now),
      10
    );
  });

  it("scoring after deserialization produces consistent priority ordering", () => {
    const now = 5_000_000;
    const metas = [
      { key: "a", meta: makeDecayMeta({ lastAccessedAt: now - HOUR_MS }) },
      { key: "b", meta: makeDecayMeta({ lastAccessedAt: now - 3 * HOUR_MS }) },
    ];
    // Serialize and restore
    const restored = JSON.parse(JSON.stringify(metas)) as typeof metas;

    const originalOrder = metas
      .map((m) => ({ key: m.key, score: scoreWithDecay(1.0, m.meta, now) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.key);

    const restoredOrder = restored
      .map((m) => ({ key: m.key, score: scoreWithDecay(1.0, m.meta, now) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.key);

    expect(restoredOrder).toEqual(originalOrder);
  });
});

// ---------------------------------------------------------------------------
// 16. Empty priority queue — edge cases handled gracefully
// ---------------------------------------------------------------------------

describe("empty priority-queue-adjacent edge cases (production helpers only)", () => {
  it("findWeakMemories on empty records returns empty array", () => {
    const result = findWeakMemories([], 0.5);
    expect(result).toEqual([]);
  });

  it("pruneStaleMemories on empty array returns zero pruned and kept", () => {
    const result = pruneStaleMemories([]);
    expect(result.pruned).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.prunedCount).toBe(0);
  });
});
