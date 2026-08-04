/**
 * Tests for `MemoryPruner` (MC-02).
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryPruner } from "../memory-pruner.js";
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from "../consolidation-engine.js";

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
    search: vi.fn(async (): Promise<ConsolidationStoreItem[]> => {
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

/**
 * Store that honours `limit`/`offset` the way a real paginating backend does.
 * Used by the default-config regression test: the bug (DZUPAGENT-AGENT-C-20)
 * was that the pruner issued a single `search({ limit: pageSize })`, so with
 * pageSize 500 < maxEntries 1000 the capacity cap could never fire.
 */
function createPagingStore(
  records: Array<{ key: string; value: Record<string, unknown> }>,
): MockStore & { searchCalls: Array<{ limit?: number; offset?: number }> } {
  const data = new Map<string, Record<string, unknown>>();
  for (const { key, value } of records) data.set(key, value);
  const searchCalls: Array<{ limit?: number; offset?: number }> = [];
  return {
    data,
    searchCalls,
    search: vi.fn(
      async (
        _ns: string[],
        options?: { query?: string; limit?: number; offset?: number },
      ): Promise<ConsolidationStoreItem[]> => {
        searchCalls.push({ limit: options?.limit, offset: options?.offset });
        const all = [...data.entries()].map(([key, value]) => ({ key, value }));
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? all.length;
        return all.slice(offset, offset + limit);
      },
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

describe("MemoryPruner", () => {
  it("prunes TTL-expired entries", async () => {
    const now = 10_000_000;
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;

    const store = createMockStore([
      // Old: createdAt 10 days ago → expired
      {
        key: "old:1",
        value: {
          text: "old",
          _decay: { createdAt: now - tenDays, strength: 0.9 },
        },
      },
      {
        key: "old:2",
        value: {
          text: "old",
          _decay: { createdAt: now - tenDays, strength: 0.8 },
        },
      },
      // Fresh: 1 day ago
      {
        key: "fresh:1",
        value: {
          text: "fresh",
          _decay: { createdAt: now - oneDay, strength: 0.9 },
        },
      },
    ]);

    const pruner = new MemoryPruner();
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: () => now,
    });

    expect(result.expired).toBe(2);
    expect(result.evicted).toBe(0);
    expect(result.remaining).toBe(1);
    expect(store.data.has("old:1")).toBe(false);
    expect(store.data.has("old:2")).toBe(false);
    expect(store.data.has("fresh:1")).toBe(true);
  });

  it("evicts lowest-strength entries when over maxEntries ceiling", async () => {
    const now = 10_000_000;

    // 5 fresh entries with varying strengths; cap at 3
    const store = createMockStore([
      { key: "a", value: { _decay: { createdAt: now, strength: 0.9 } } },
      { key: "b", value: { _decay: { createdAt: now, strength: 0.1 } } },
      { key: "c", value: { _decay: { createdAt: now, strength: 0.5 } } },
      { key: "d", value: { _decay: { createdAt: now, strength: 0.05 } } },
      { key: "e", value: { _decay: { createdAt: now, strength: 0.7 } } },
    ]);

    const pruner = new MemoryPruner();
    const result = await pruner.prune(store, {
      maxEntries: 3,
      now: () => now,
    });

    expect(result.expired).toBe(0);
    expect(result.evicted).toBe(2);
    expect(result.remaining).toBe(3);
    // Weakest (d=0.05, b=0.1) should be evicted
    expect(store.data.has("d")).toBe(false);
    expect(store.data.has("b")).toBe(false);
    // Strongest survive
    expect(store.data.has("a")).toBe(true);
    expect(store.data.has("c")).toBe(true);
    expect(store.data.has("e")).toBe(true);
  });

  it("combines TTL expiry and capacity eviction in a single pass", async () => {
    const now = 10_000_000;
    const tenDays = 10 * 24 * 60 * 60 * 1000;

    const store = createMockStore([
      // Old → TTL expiry
      {
        key: "old",
        value: { _decay: { createdAt: now - tenDays, strength: 1 } },
      },
      // 4 fresh entries; cap at 2 → 2 evictions
      { key: "a", value: { _decay: { createdAt: now, strength: 0.9 } } },
      { key: "b", value: { _decay: { createdAt: now, strength: 0.1 } } },
      { key: "c", value: { _decay: { createdAt: now, strength: 0.5 } } },
      { key: "d", value: { _decay: { createdAt: now, strength: 0.05 } } },
    ]);

    const pruner = new MemoryPruner();
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 2,
      now: () => now,
    });

    expect(result.expired).toBe(1);
    expect(result.evicted).toBe(2);
    expect(result.remaining).toBe(2);
    expect(store.data.has("old")).toBe(false);
    expect(store.data.has("d")).toBe(false);
    expect(store.data.has("b")).toBe(false);
  });

  it("returns zero counts on empty store", async () => {
    const store = createMockStore();
    const result = await new MemoryPruner().prune(store);
    expect(result).toEqual({
      expired: 0,
      evicted: 0,
      remaining: 0,
      status: "completed",
      degradations: [],
    });
  });

  it("returns zero counts when search throws", async () => {
    const store: ConsolidationStore = {
      search: () => Promise.reject(new Error("boom")),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const result = await new MemoryPruner().prune(store);
    expect(result).toMatchObject({
      expired: 0,
      evicted: 0,
      remaining: 0,
      status: "degraded",
      degradations: [
        {
          operation: "search",
          impact: "source-unavailable",
          reason: "boom",
        },
      ],
    });
  });

  it("reports delete failures and keeps the failed record in remaining", async () => {
    const now = 10_000_000;
    const store = createMockStore([
      { key: "old", value: { _decay: { createdAt: 1, strength: 0.1 } } },
    ]);
    (store.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("delete failed"),
    );

    const result = await new MemoryPruner().prune(store, {
      ttlMs: 1,
      now: () => now,
    });

    expect(result).toMatchObject({
      expired: 0,
      remaining: 1,
      status: "degraded",
      degradations: [
        {
          operation: "delete",
          impact: "partial-result",
          reason: "delete failed",
          target: "old",
        },
      ],
    });
  });

  it("falls back to value.createdAt and item.createdAt when _decay is missing", async () => {
    const now = 10_000_000;
    const tenDays = 10 * 24 * 60 * 60 * 1000;

    const store: ConsolidationStore & {
      data: Map<string, Record<string, unknown>>;
    } = {
      data: new Map(),
      search: vi.fn(
        async (): Promise<ConsolidationStoreItem[]> => [
          { key: "a", value: { createdAt: now - tenDays } },
          { key: "b", value: {}, createdAt: new Date(now - tenDays) },
          { key: "c", value: { _decay: { createdAt: now, strength: 0.9 } } },
        ],
      ),
      put: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    const pruner = new MemoryPruner();
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: () => now,
    });

    expect(result.expired).toBe(2);
    expect(store.delete).toHaveBeenCalledWith([], "a");
    expect(store.delete).toHaveBeenCalledWith([], "b");
  });

  // -------------------------------------------------------------------------
  // DZUPAGENT-AGENT-C-20 regression: the capacity cap must be reachable with
  // the SHIPPED defaults. These tests deliberately do NOT pass `maxEntries`
  // or `pageSize` — overriding them is exactly what masked the original bug.
  // -------------------------------------------------------------------------
  describe("default configuration (no maxEntries/pageSize overrides)", () => {
    it("evicts down to the default maxEntries with 1500 fresh entries", async () => {
      const now = 10_000_000;
      const records = Array.from({ length: 1500 }, (_, i) => ({
        key: `entry:${String(i).padStart(4, "0")}`,
        // Strength ascending, so the weakest 500 are the first 500 keys.
        value: { _decay: { createdAt: now, strength: i / 1500 } },
      }));
      const store = createPagingStore(records);

      const result = await new MemoryPruner().prune(store, { now: () => now });

      // 1500 entries, default cap 1000 → 500 evictions.
      expect(result.expired).toBe(0);
      expect(result.evicted).toBe(500);
      expect(result.remaining).toBe(1000);
      expect(store.data.size).toBe(1000);
      expect(result.status).toBe("completed");

      // The weakest were removed, the strongest kept.
      expect(store.data.has("entry:0000")).toBe(false);
      expect(store.data.has("entry:0499")).toBe(false);
      expect(store.data.has("entry:0500")).toBe(true);
      expect(store.data.has("entry:1499")).toBe(true);

      // It genuinely paged: more than one search, each advancing `offset`.
      expect(store.searchCalls.length).toBeGreaterThan(1);
      expect(store.searchCalls[0]).toEqual({ limit: 500, offset: 0 });
      expect(store.searchCalls[1]).toEqual({ limit: 500, offset: 500 });
    });

    it("does not evict when the namespace is under the default ceiling", async () => {
      const now = 10_000_000;
      const records = Array.from({ length: 900 }, (_, i) => ({
        key: `entry:${i}`,
        value: { _decay: { createdAt: now, strength: i / 900 } },
      }));
      const store = createPagingStore(records);

      const result = await new MemoryPruner().prune(store, { now: () => now });

      expect(result.evicted).toBe(0);
      expect(result.remaining).toBe(900);
      expect(store.data.size).toBe(900);
      expect(result.status).toBe("completed");
    });

    it("reports degraded (never completed) when a later page fails mid-scan", async () => {
      const now = 10_000_000;
      const records = Array.from({ length: 1500 }, (_, i) => ({
        key: `entry:${i}`,
        value: { _decay: { createdAt: now, strength: i / 1500 } },
      }));
      const store = createPagingStore(records);
      const realSearch = store.search as unknown as (
        ns: string[],
        options?: { limit?: number; offset?: number },
      ) => Promise<ConsolidationStoreItem[]>;
      let call = 0;
      store.search = vi.fn(
        async (ns: string[], options?: { limit?: number; offset?: number }) => {
          call++;
          if (call === 3) throw new Error("page 3 exploded");
          return realSearch(ns, options);
        },
      ) as MockStore["search"];

      const result = await new MemoryPruner().prune(store, { now: () => now });

      // A partial scan must NOT be reported as a clean run.
      expect(result.status).toBe("degraded");
      expect(result.degradations).toContainEqual(
        expect.objectContaining({
          operation: "search",
          impact: "partial-result",
          reason: "page 3 exploded",
        }),
      );
    });

    it("terminates against a store that ignores offset", async () => {
      const now = 10_000_000;
      // Store always returns the same full page regardless of offset.
      const page: ConsolidationStoreItem[] = Array.from(
        { length: 500 },
        (_, i) => ({
          key: `entry:${i}`,
          value: { _decay: { createdAt: now, strength: 0.5 } },
        }),
      );
      const store: ConsolidationStore = {
        search: vi.fn(async () => page),
        put: vi.fn(),
        delete: vi.fn(async () => undefined),
      };

      const result = await new MemoryPruner().prune(store, { now: () => now });

      // Second page adds nothing new → scan stops; 500 < 1000 so no eviction.
      expect(result.remaining).toBe(500);
      expect(result.evicted).toBe(0);
      expect((store.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        2,
      );
    });
  });
});
