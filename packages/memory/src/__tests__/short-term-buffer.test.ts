/**
 * Comprehensive tests for ShortTermBuffer — short-term memory buffer with:
 *   - Add / peek / pop / clear
 *   - Capacity limits and oldest-item eviction
 *   - Recency scoring and decay
 *   - Flush-to-long-term (full and partial)
 *   - Auto-flush at threshold
 *   - Serialization / deserialization
 *   - Edge cases (capacity=1, empty buffer, etc.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ShortTermBuffer } from "../short-term-buffer.js";
import type { MemoryService } from "../memory-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(): {
  service: MemoryService;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  records: Map<string, Record<string, unknown>>;
} {
  const records = new Map<string, Record<string, unknown>>();
  const makeKey = (ns: string, scope: Record<string, string>, key: string) =>
    `${ns}::${JSON.stringify(scope)}::${key}`;
  const put = vi
    .fn()
    .mockImplementation(
      (
        ns: string,
        scope: Record<string, string>,
        key: string,
        value: Record<string, unknown>,
      ) => {
        records.set(makeKey(ns, scope, key), structuredClone(value));
        return Promise.resolve();
      },
    );
  const get = vi
    .fn()
    .mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        if (key) {
          const val = records.get(makeKey(ns, scope, key));
          return Promise.resolve(val ? [structuredClone(val)] : []);
        }
        const prefix = `${ns}::${JSON.stringify(scope)}::`;
        const results: Record<string, unknown>[] = [];
        for (const [k, v] of records) {
          if (k.startsWith(prefix)) results.push(structuredClone(v));
        }
        return Promise.resolve(results);
      },
    );
  const service = {
    put,
    get,
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(""),
  } as unknown as MemoryService;
  return { service, put, get, records };
}

function makeBuffer(
  opts: {
    capacity?: number;
    flushThreshold?: number;
    autoFlush?: boolean;
  } = {},
  store?: MemoryService,
) {
  const mock = store ?? createMockStore().service;
  return new ShortTermBuffer({
    capacity: opts.capacity ?? 5,
    flushThreshold: opts.flushThreshold,
    autoFlush: opts.autoFlush,
    store: mock,
    namespace: "stm",
  });
}

const SCOPE = { tenantId: "t1" };

// ---------------------------------------------------------------------------
// add / peek / size
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – add and peek", () => {
  let buf: ShortTermBuffer;

  beforeEach(() => {
    buf = makeBuffer({ capacity: 5, autoFlush: false });
  });

  it("added item is retrievable via peek", async () => {
    await buf.add({ text: "hello", turn: 1 }, SCOPE);
    const items = buf.peek();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("hello");
    expect(items[0].turn).toBe(1);
  });

  it("peek returns items in insertion order", async () => {
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    const items = buf.peek();
    expect(items.map((i) => i.text)).toEqual(["a", "b", "c"]);
  });

  it("peek does not remove items", async () => {
    await buf.add({ text: "x", turn: 1 }, SCOPE);
    buf.peek();
    expect(buf.size).toBe(1);
  });

  it("size reflects the number of buffered items", async () => {
    expect(buf.size).toBe(0);
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    expect(buf.size).toBe(1);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    expect(buf.size).toBe(2);
  });

  it("peek returns defensive copies (mutations do not affect buffer)", async () => {
    await buf.add({ text: "original", turn: 1 }, SCOPE);
    const items = buf.peek();
    items[0]!.text = "mutated";
    expect(buf.peek()[0]!.text).toBe("original");
  });

  it("insertedAt is set automatically when not provided", async () => {
    const before = Date.now();
    await buf.add({ text: "ts-check", turn: 1 }, SCOPE);
    const after = Date.now();
    const item = buf.peek()[0]!;
    expect(item.insertedAt).toBeGreaterThanOrEqual(before);
    expect(item.insertedAt).toBeLessThanOrEqual(after);
  });

  it("insertedAt is preserved when explicitly provided", async () => {
    const fixedTs = 1_000_000;
    await buf.add({ text: "fixed", turn: 1, insertedAt: fixedTs }, SCOPE);
    expect(buf.peek()[0]!.insertedAt).toBe(fixedTs);
  });

  it("optional tag is stored and retrievable", async () => {
    await buf.add({ text: "tagged", turn: 1, tag: "user" }, SCOPE);
    expect(buf.peek()[0]!.tag).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Buffer capacity and eviction
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – capacity limits", () => {
  it("buffer does not exceed capacity", async () => {
    const buf = makeBuffer({ capacity: 3, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    await buf.add({ text: "d", turn: 4 }, SCOPE);
    expect(buf.size).toBe(3);
  });

  it("adding beyond capacity evicts the oldest item", async () => {
    const buf = makeBuffer({ capacity: 3, autoFlush: false });
    await buf.add({ text: "oldest", turn: 1 }, SCOPE);
    await buf.add({ text: "middle", turn: 2 }, SCOPE);
    await buf.add({ text: "newest-a", turn: 3 }, SCOPE);
    await buf.add({ text: "newest-b", turn: 4 }, SCOPE);
    const texts = buf.peek().map((i) => i.text);
    expect(texts).not.toContain("oldest");
    expect(texts).toContain("newest-b");
  });

  it("capacity=1 always holds only the most recent item", async () => {
    const buf = makeBuffer({ capacity: 1, autoFlush: false });
    await buf.add({ text: "first", turn: 1 }, SCOPE);
    await buf.add({ text: "second", turn: 2 }, SCOPE);
    await buf.add({ text: "third", turn: 3 }, SCOPE);
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("third");
  });

  it("exactly at capacity does not evict", async () => {
    const buf = makeBuffer({ capacity: 3, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    expect(buf.size).toBe(3);
    const texts = buf.peek().map((i) => i.text);
    expect(texts).toEqual(["a", "b", "c"]);
  });

  it("eviction order is FIFO (oldest inserted first)", async () => {
    const buf = makeBuffer({ capacity: 2, autoFlush: false });
    await buf.add({ text: "first", turn: 1 }, SCOPE);
    await buf.add({ text: "second", turn: 2 }, SCOPE);
    await buf.add({ text: "third", turn: 3 }, SCOPE); // evicts 'first'
    const texts = buf.peek().map((i) => i.text);
    expect(texts).toEqual(["second", "third"]);
  });

  it("multiple evictions leave correct survivors", async () => {
    const buf = makeBuffer({ capacity: 2, autoFlush: false });
    for (let i = 1; i <= 6; i++) {
      await buf.add({ text: `item-${i}`, turn: i }, SCOPE);
    }
    const texts = buf.peek().map((i) => i.text);
    expect(texts).toEqual(["item-5", "item-6"]);
  });
});

// ---------------------------------------------------------------------------
// pop
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – pop", () => {
  it("pop removes and returns the most recent item", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    const popped = buf.pop();
    expect(popped?.text).toBe("b");
    expect(buf.size).toBe(1);
  });

  it("pop returns undefined on empty buffer", () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    expect(buf.pop()).toBeUndefined();
  });

  it("successive pops drain the buffer in reverse order", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    expect(buf.pop()?.text).toBe("c");
    expect(buf.pop()?.text).toBe("b");
    expect(buf.pop()?.text).toBe("a");
    expect(buf.pop()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – clear", () => {
  it("clear removes all items", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.peek()).toEqual([]);
  });

  it("buffer is usable after clear", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "old", turn: 1 }, SCOPE);
    buf.clear();
    await buf.add({ text: "new", turn: 2 }, SCOPE);
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("new");
  });

  it("clear on empty buffer is a no-op", () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    expect(() => buf.clear()).not.toThrow();
    expect(buf.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recency scoring
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – recency scoring", () => {
  it("most recently added item has the highest recency score (1.0)", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    const scores = buf.recencyScores();
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    expect(sorted[0]!.item.text).toBe("c");
    expect(sorted[0]!.score).toBe(1);
  });

  it("item added long ago has lower recency score than recent item", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "old", turn: 1 }, SCOPE);
    await buf.add({ text: "recent", turn: 100 }, SCOPE);
    const scores = buf.recencyScores();
    const oldScore = scores.find((s) => s.item.text === "old")!.score;
    const recentScore = scores.find((s) => s.item.text === "recent")!.score;
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("oldest item has recency score 0 when two items present", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "old", turn: 1 }, SCOPE);
    await buf.add({ text: "new", turn: 5 }, SCOPE);
    const scores = buf.recencyScores();
    const oldScore = scores.find((s) => s.item.text === "old")!.score;
    expect(oldScore).toBe(0);
  });

  it("single item always has recency score 1.0", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "only", turn: 7 }, SCOPE);
    const scores = buf.recencyScores();
    expect(scores).toHaveLength(1);
    expect(scores[0]!.score).toBe(1);
  });

  it("recency scores are in [0, 1] range", async () => {
    const buf = makeBuffer({ capacity: 10, autoFlush: false });
    for (let i = 1; i <= 8; i++) {
      await buf.add({ text: `item-${i}`, turn: i * 3 }, SCOPE);
    }
    const scores = buf.recencyScores();
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("scores decrease monotonically from newest to oldest", async () => {
    const buf = makeBuffer({ capacity: 10, autoFlush: false });
    for (let i = 1; i <= 5; i++) {
      await buf.add({ text: `item-${i}`, turn: i }, SCOPE);
    }
    const scores = buf.recencyScores();
    // Items are in insertion order; scores should be ascending
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]!.score).toBeLessThan(scores[i + 1]!.score);
    }
  });

  it("returns empty array when buffer is empty", () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    expect(buf.recencyScores()).toEqual([]);
  });

  it("equal turns produce equal scores", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 5 }, SCOPE);
    await buf.add({ text: "b", turn: 5 }, SCOPE);
    const scores = buf.recencyScores();
    // Both have same turn so both score 1
    expect(scores[0]!.score).toBe(1);
    expect(scores[1]!.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flush-to-long-term
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – flush", () => {
  it("flush moves all items to the long-term store", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.flush(SCOPE);
    // Two records should be in the store
    const prefix = `stm::${JSON.stringify(SCOPE)}::`;
    const stored = [...records.keys()].filter((k) => k.startsWith(prefix));
    expect(stored).toHaveLength(2);
  });

  it("flush clears the buffer", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "x", turn: 1 }, SCOPE);
    await buf.flush(SCOPE);
    expect(buf.size).toBe(0);
  });

  it("flushed items appear in long-term store with correct text", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "hello world", turn: 3 }, SCOPE);
    await buf.flush(SCOPE);
    const allValues = [...records.values()];
    expect(allValues.some((v) => v["text"] === "hello world")).toBe(true);
  });

  it("flush returns the count of flushed items", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    const count = await buf.flush(SCOPE);
    expect(count).toBe(3);
  });

  it("flush on empty buffer is a no-op returning 0", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    const count = await buf.flush(SCOPE);
    expect(count).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it("after flush, new items can be added to the buffer", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "pre-flush", turn: 1 }, SCOPE);
    await buf.flush(SCOPE);
    await buf.add({ text: "post-flush", turn: 2 }, SCOPE);
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("post-flush");
  });

  it("each flush call uses a unique flush key prefix", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.flush(SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.flush(SCOPE);
    // Two flushes = two distinct flush IDs
    const keys = [...records.keys()];
    const flush1Keys = keys.filter((k) => k.includes("stm-flush-1-"));
    const flush2Keys = keys.filter((k) => k.includes("stm-flush-2-"));
    expect(flush1Keys).toHaveLength(1);
    expect(flush2Keys).toHaveLength(1);
  });

  it("flushed record contains turn and tag metadata", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "tagged item", turn: 7, tag: "assistant" }, SCOPE);
    await buf.flush(SCOPE);
    const allValues = [...records.values()];
    const rec = allValues.find((v) => v["text"] === "tagged item")!;
    expect(rec["turn"]).toBe(7);
    expect(rec["tag"]).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// Auto-flush threshold
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – auto-flush threshold", () => {
  it("auto-flush triggers when buffer reaches flushThreshold", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      flushThreshold: 3,
      store: service,
      namespace: "stm",
      autoFlush: true,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    expect(put).not.toHaveBeenCalled();
    await buf.add({ text: "c", turn: 3 }, SCOPE); // hits threshold
    expect(put).toHaveBeenCalled();
  });

  it("buffer is empty after auto-flush", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      flushThreshold: 2,
      store: service,
      namespace: "stm",
      autoFlush: true,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE); // auto-flush
    expect(buf.size).toBe(0);
  });

  it("auto-flush disabled: threshold has no effect", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      flushThreshold: 2,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    expect(put).not.toHaveBeenCalled();
    expect(buf.size).toBe(3);
  });

  it("threshold equal to capacity auto-flushes at full buffer", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 3,
      flushThreshold: 3,
      store: service,
      namespace: "stm",
      autoFlush: true,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    expect(put).not.toHaveBeenCalled();
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    expect(put).toHaveBeenCalledTimes(3);
    expect(buf.size).toBe(0);
  });

  it("multiple auto-flush cycles work correctly", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      flushThreshold: 2,
      store: service,
      namespace: "stm",
      autoFlush: true,
    });
    // Cycle 1
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    // Cycle 2
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    await buf.add({ text: "d", turn: 4 }, SCOPE);
    const keys = [...records.keys()];
    expect(keys.length).toBe(4); // 2 items per flush × 2 cycles
  });
});

// ---------------------------------------------------------------------------
// Partial flush
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – partial flush", () => {
  it("partial flush only removes items older than the threshold", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "old-a", turn: 1 }, SCOPE);
    await buf.add({ text: "old-b", turn: 2 }, SCOPE);
    await buf.add({ text: "recent", turn: 10 }, SCOPE);
    // oldThreshold=5: cutoff = 10-5 = 5; items with turn<=5 flushed
    const count = await buf.partialFlush(5, SCOPE);
    expect(count).toBe(2);
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("recent");
  });

  it("partial flush keeps all items when none are old enough", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 8 }, SCOPE);
    await buf.add({ text: "b", turn: 9 }, SCOPE);
    await buf.add({ text: "c", turn: 10 }, SCOPE);
    // threshold=2: cutoff=8; items with turn<=8 flushed → 'a' only
    const count = await buf.partialFlush(2, SCOPE);
    expect(count).toBe(1);
    expect(buf.size).toBe(2);
  });

  it("partial flush on empty buffer returns 0", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    const count = await buf.partialFlush(5, SCOPE);
    expect(count).toBe(0);
  });

  it("partial flush persists evicted items to long-term store", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "flush-me", turn: 1 }, SCOPE);
    await buf.add({ text: "keep-me", turn: 10 }, SCOPE);
    await buf.partialFlush(5, SCOPE);
    const allValues = [...records.values()];
    expect(allValues.some((v) => v["text"] === "flush-me")).toBe(true);
    expect(allValues.some((v) => v["text"] === "keep-me")).toBe(false);
  });

  it("partial flush with threshold=0 flushes nothing", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    // threshold=0: cutoff = newest - 0 = 2; items with turn<=2 all flushed
    // Actually cutoff = newest(2) - 0 = 2, so turn<=2 → both items flushed
    const count = await buf.partialFlush(0, SCOPE);
    // All items have turn <= cutoff (2), so both flushed
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Long-term store integration
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – long-term store integration", () => {
  it("flushed items are searchable by text in the store", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "the quick brown fox", turn: 1 }, SCOPE);
    await buf.add({ text: "jumped over the lazy dog", turn: 2 }, SCOPE);
    await buf.flush(SCOPE);
    const allValues = [...records.values()];
    const texts = allValues.map((v) => v["text"] as string);
    expect(texts).toContain("the quick brown fox");
    expect(texts).toContain("jumped over the lazy dog");
  });

  it("store.put is called once per flushed item", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    await buf.flush(SCOPE);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it("flushed records carry flushId and flushIndex metadata", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "first", turn: 1 }, SCOPE);
    await buf.add({ text: "second", turn: 2 }, SCOPE);
    await buf.flush(SCOPE);
    const allValues = [...records.values()];
    const firstRec = allValues.find((v) => v["text"] === "first")!;
    const secondRec = allValues.find((v) => v["text"] === "second")!;
    expect(firstRec["flushId"]).toBe(1);
    expect(firstRec["flushIndex"]).toBe(0);
    expect(secondRec["flushIndex"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Serialization / deserialization
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – serialization", () => {
  it("serialize produces a snapshot with items and capacity", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    const snap = buf.serialize();
    expect(snap.capacity).toBe(5);
    expect(snap.items).toHaveLength(2);
    expect(snap.items[0]!.text).toBe("a");
    expect(snap.items[1]!.text).toBe("b");
  });

  it("serialize preserves all item fields", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add(
      { text: "hello", turn: 3, tag: "sys", insertedAt: 9999 },
      SCOPE,
    );
    const snap = buf.serialize();
    expect(snap.items[0]).toMatchObject({
      text: "hello",
      turn: 3,
      tag: "sys",
      insertedAt: 9999,
    });
  });

  it("deserialize restores all items", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    const snap = {
      items: [
        { text: "x", turn: 1, insertedAt: 100 },
        { text: "y", turn: 2, insertedAt: 200 },
      ],
      flushCounter: 0,
    };
    buf.deserialize(snap);
    expect(buf.size).toBe(2);
    expect(buf.peek()[0]!.text).toBe("x");
    expect(buf.peek()[1]!.text).toBe("y");
  });

  it("deserialize truncates to current capacity if snapshot is larger", () => {
    const buf = makeBuffer({ capacity: 2, autoFlush: false });
    const snap = {
      items: [
        { text: "a", turn: 1 },
        { text: "b", turn: 2 },
        { text: "c", turn: 3 },
        { text: "d", turn: 4 },
      ],
      flushCounter: 0,
    };
    buf.deserialize(snap);
    expect(buf.size).toBe(2);
    // Most recent items kept
    const texts = buf.peek().map((i) => i.text);
    expect(texts).toEqual(["c", "d"]);
  });

  it("serialize/deserialize round-trip preserves flushCounter", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.flush(SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.flush(SCOPE);
    const snap = buf.serialize();
    expect(snap.flushCounter).toBe(2);

    const buf2 = makeBuffer({ capacity: 5, autoFlush: false }, service);
    buf2.deserialize(snap);
    // After deserialize, the next flush should continue from counter 2
    await buf2.add({ text: "c", turn: 3 }, SCOPE);
    // Verify flushCounter is restored
    const snap2 = buf2.serialize();
    expect(snap2.flushCounter).toBe(2);
  });

  it("deserialize on empty snapshot produces empty buffer", () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    buf.deserialize({ items: [], flushCounter: 0 });
    expect(buf.size).toBe(0);
  });

  it("serialize returns a defensive copy (mutations do not affect buffer)", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "original", turn: 1 }, SCOPE);
    const snap = buf.serialize();
    snap.items[0]!.text = "mutated";
    expect(buf.peek()[0]!.text).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// Buffer ordering
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – buffer ordering", () => {
  it("items are returned in insertion order", async () => {
    const buf = makeBuffer({ capacity: 10, autoFlush: false });
    const texts = ["first", "second", "third", "fourth", "fifth"];
    for (let i = 0; i < texts.length; i++) {
      await buf.add({ text: texts[i]!, turn: i + 1 }, SCOPE);
    }
    const result = buf.peek().map((i) => i.text);
    expect(result).toEqual(texts);
  });

  it("ordering is preserved after eviction", async () => {
    const buf = makeBuffer({ capacity: 3, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 2 }, SCOPE);
    await buf.add({ text: "c", turn: 3 }, SCOPE);
    await buf.add({ text: "d", turn: 4 }, SCOPE); // evicts 'a'
    const result = buf.peek().map((i) => i.text);
    expect(result).toEqual(["b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("ShortTermBuffer – additional edge cases", () => {
  it("add without explicit scope works (defaults to empty scope)", async () => {
    const { service } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "no-scope", turn: 1 });
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("no-scope");
  });

  it("flush without explicit scope writes to empty-scope namespace", async () => {
    const { service, put } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 5,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "item", turn: 1 });
    await buf.flush();
    expect(put).toHaveBeenCalledWith(
      "stm",
      {},
      expect.stringContaining("stm-flush"),
      expect.any(Object),
    );
  });

  it("recency scores reference items by value, not by position mutation", async () => {
    const buf = makeBuffer({ capacity: 5, autoFlush: false });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.add({ text: "b", turn: 3 }, SCOPE);
    const scores = buf.recencyScores();
    // Mutating the returned score items does not affect internal buffer
    scores[0]!.item.text = "mutated";
    expect(buf.peek()[0]!.text).toBe("a");
  });

  it("capacity defaults to 20 when not specified", async () => {
    const { service } = createMockStore();
    // autoFlush: false so we can inspect size after filling beyond default capacity
    const buf = new ShortTermBuffer({
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    // Fill 21 items — the first should be evicted leaving 20
    for (let i = 1; i <= 21; i++) {
      await buf.add({ text: `item-${i}`, turn: i });
    }
    expect(buf.size).toBe(20);
    // Oldest item (item-1) should have been evicted
    const texts = buf.peek().map((it) => it.text);
    expect(texts).not.toContain("item-1");
    expect(texts).toContain("item-21");
  });

  it("partial flush uses a different key prefix than full flush", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "old", turn: 1 }, SCOPE);
    await buf.add({ text: "new", turn: 100 }, SCOPE);
    await buf.partialFlush(50, SCOPE); // flushes 'old'
    const keys = [...records.keys()];
    expect(keys.some((k) => k.includes("stm-partial-"))).toBe(true);
    expect(keys.some((k) => k.includes("stm-flush-"))).toBe(false);
  });

  it("size returns 0 on a freshly constructed buffer", () => {
    const buf = makeBuffer({ capacity: 10, autoFlush: false });
    expect(buf.size).toBe(0);
  });

  it("full flush followed by partial flush works independently", async () => {
    const { service, records } = createMockStore();
    const buf = new ShortTermBuffer({
      capacity: 10,
      store: service,
      namespace: "stm",
      autoFlush: false,
    });
    await buf.add({ text: "a", turn: 1 }, SCOPE);
    await buf.flush(SCOPE); // full flush — counter becomes 1
    await buf.add({ text: "b", turn: 5 }, SCOPE);
    await buf.add({ text: "c", turn: 20 }, SCOPE);
    await buf.partialFlush(10, SCOPE); // partial — flushes 'b' (turn 5 <= 10)
    expect(buf.size).toBe(1);
    expect(buf.peek()[0]!.text).toBe("c");
    const allValues = [...records.values()];
    expect(allValues.some((v) => v["text"] === "b")).toBe(true);
  });
});
