/**
 * Validation for the memory test harness and the report-truthfulness assertions.
 *
 * These tests are written the way the guard itself must be validated: each one
 * either exercises the real retention code (which must now pass) or replays the
 * *original defective behaviour* inline and asserts that the guard rejects it.
 *
 * The second half matters more than the first. A guard validated only against
 * fixed code proves nothing — it can be inert and still report success. Every
 * `rejects` case below reproduces a defect that actually shipped, so a
 * regression in the assertions themselves shows up as a failing test here.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryHarness } from "../memory-harness.js";
import {
  censusOf,
  expectCompactedCountIsTruthful,
  expectNoDuplicateAfterRewrite,
  expectPrunedCountIsTruthful,
  expectRepeatedPassesDoNotGrow,
  expectScopeIsPopulated,
} from "../report-truthfulness.js";
import {
  compactTombstonesForSpace,
  enforceRetentionForSpace,
} from "../../sharing/space-retention.js";
import type { SharedMemorySpace } from "../../sharing/types.js";

const SPACE_ID = "s1";

function spaceHarness() {
  return createMemoryHarness({
    namespace: `space:${SPACE_ID}`,
    scope: { _space: SPACE_ID },
  });
}

function makeSpace(
  retentionPolicy?: SharedMemorySpace["retentionPolicy"]
): SharedMemorySpace {
  return {
    id: SPACE_ID,
    name: "Space One",
    owner: "forge://agent/owner",
    participants: [],
    conflictResolution: "last-write-wins",
    createdAt: new Date(0).toISOString(),
    ...(retentionPolicy ? { retentionPolicy } : {}),
  } as SharedMemorySpace;
}

/** A record old enough that any positive `maxAgeMs` prunes it. */
function agedRecord(text: string): Record<string, unknown> {
  return { text, createdAt: new Date(1).toISOString() };
}

describe("memory harness", () => {
  it("exposes real store keys, not fabricated ones", async () => {
    const h = spaceHarness();
    await h.seed({ alpha: { text: "a" }, beta: { text: "b" } });

    // The defect class began here: callers derived `record-0`, `record-1`
    // because `get()` drops the key. The harness reads them back for real.
    expect(await h.keys()).toEqual(["alpha", "beta"]);
  });

  it("separates live records from tombstones", async () => {
    const h = spaceHarness();
    await h.seed({
      live: { text: "here" },
      dead: { _tombstone: true, _deletedAt: new Date(1).toISOString() },
    });

    expect(await h.liveKeys()).toEqual(["live"]);
    expect(await h.tombstoneKeys()).toEqual(["dead"]);
    expect(await h.size()).toBe(2);
  });

  it("never injects the store key into the record value", async () => {
    const h = spaceHarness();
    await h.seed({ k1: { text: "payload" } });

    const [record] = await h.snapshot();
    // The key travels alongside the value, never inside it. Writing `_key`
    // into the record would change what export signatures are computed over —
    // which is precisely why `getKeyed` exists instead.
    expect(record?.key).toBe("k1");
    expect(record?.value).not.toHaveProperty("_key");
    expect(record?.value["text"]).toBe("payload");
    // `put()` does enrich records with decay metadata; that is a documented
    // write-path behaviour, distinct from the read path fabricating identity.
    expect(record?.value).toHaveProperty("_decay");
  });
});

describe("retention reports the truth", () => {
  it("prunes the live set by exactly the count it reports", async () => {
    const h = spaceHarness();
    await h.seed({
      a: agedRecord("a"),
      b: agedRecord("b"),
      c: agedRecord("c"),
    });
    const space = makeSpace({ maxAgeMs: 1 });

    await expectPrunedCountIsTruthful(h, 3, async () => {
      const result = await enforceRetentionForSpace(h.memory, space);
      return result.pruned;
    });

    expect(await h.liveKeys()).toEqual([]);
    expect(await h.tombstoneKeys()).toEqual(["a", "b", "c"]);
  });

  it("does not grow the namespace across repeated passes", async () => {
    const h = spaceHarness();
    await h.seed({ a: agedRecord("a"), b: agedRecord("b") });
    const space = makeSpace({ maxAgeMs: 1 });

    // The original defect only showed itself here: pass 1 looked correct and
    // every later pass added two more tombstones under fabricated keys.
    await expectRepeatedPassesDoNotGrow(h, () =>
      enforceRetentionForSpace(h.memory, space)
    );

    expect(await h.size()).toBe(2);
  });

  it("compaction removes exactly the records it reports", async () => {
    const h = spaceHarness();
    await h.seed({
      t1: { _tombstone: true, _deletedAt: new Date(1).toISOString() },
      t2: { _tombstone: true, _deletedAt: new Date(2).toISOString() },
    });
    const space = makeSpace({ maxAgeMs: 1 });

    await expectCompactedCountIsTruthful(h, 2, async () => {
      const result = await compactTombstonesForSpace(h.memory, space, 0);
      return result.tombstonesCompacted;
    });

    expect(await h.size()).toBe(0);
  });

  it("holds fresh tombstones until they age past maxAgeMs", async () => {
    const h = spaceHarness();
    await h.seed({ a: agedRecord("a"), b: agedRecord("b") });
    const space = makeSpace({ maxAgeMs: 60_000 });

    await enforceRetentionForSpace(h.memory, space);

    // Retention stamps `_deletedAt` with the current time, so a tombstone is
    // ~0ms old when compaction runs. It is deliberately retained until it
    // ages past the policy window — reclaiming immediately would erase the
    // deletion record before any peer could observe it.
    const result = await compactTombstonesForSpace(h.memory, space, 0);

    expect(result.tombstonesFound).toBe(2);
    expect(result.tombstonesCompacted).toBe(0);
    expect(await h.tombstoneKeys()).toEqual(["a", "b"]);
  });

  it("retention followed by compaction reclaims aged tombstones", async () => {
    const h = spaceHarness();
    await h.seed({ a: agedRecord("a"), b: agedRecord("b") });
    const space = makeSpace({ maxAgeMs: 1 });

    // Chained is where the defect actually bit: compaction reported
    // `compacted: 1` while deleting nothing, because retention had written
    // its tombstones to keys that held no record.
    await enforceRetentionForSpace(h.memory, space);
    expect(await h.tombstoneKeys()).toEqual(["a", "b"]);

    // Age the tombstones past the 1ms window. Compaction compares
    // `Date.now()` against the stamped `_deletedAt`, so moving the clock is
    // enough — and unlike a real sleep it cannot flake under load.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10);
    let result;
    try {
      result = await compactTombstonesForSpace(h.memory, space, 0);
    } finally {
      vi.useRealTimers();
    }

    expect(result.tombstonesCompacted).toBe(2);
    expect(await h.size()).toBe(0);
  });
});

describe("the assertions reject the defects that shipped", () => {
  it("rejects a prune that reports progress but touches nothing", async () => {
    const h = spaceHarness();
    await h.seed({ a: { text: "a" }, b: { text: "b" } });

    await expect(
      expectPrunedCountIsTruthful(h, 2, async () => 2)
    ).rejects.toThrow(/live record count went 2 -> 2/);
  });

  it("rejects a prune that grows the namespace with fabricated keys", async () => {
    const h = spaceHarness();
    await h.seed({ real1: { text: "a" }, real2: { text: "b" } });

    // Verbatim replay of the original bug: tombstones written to `record-N`,
    // which no record occupies, so both originals survive and the namespace
    // grows — while the report claims two were pruned.
    await expect(
      expectPrunedCountIsTruthful(h, 2, async () => {
        for (let i = 0; i < 2; i++) {
          await h.memory.put(h.namespace, h.scope, `record-${i}`, {
            _tombstone: true,
            _deletedAt: new Date(1).toISOString(),
          });
        }
        return 2;
      })
    ).rejects.toThrow(/live record count went/);

    // Confirm the replay really did reproduce the growth.
    expect(await h.size()).toBe(4);
    expect(await h.liveKeys()).toEqual(["real1", "real2"]);
  });

  it("rejects compaction that reports success but reclaims nothing", async () => {
    const h = spaceHarness();
    await h.seed({
      t1: { _tombstone: true, _deletedAt: new Date(1).toISOString() },
    });

    await expect(
      expectCompactedCountIsTruthful(h, 1, async () => 1)
    ).rejects.toThrow(/store went 1 -> 1 records/);
  });

  it("rejects a maintenance pass that grows on every run", async () => {
    const h = spaceHarness();
    let n = 0;

    await expect(
      expectRepeatedPassesDoNotGrow(h, async () => {
        await h.memory.put(h.namespace, h.scope, `junk-${n++}`, { text: "x" });
      })
    ).rejects.toThrow(/namespace grew on pass 2/);
  });

  it("rejects a rewrite that leaves the original behind", async () => {
    const h = spaceHarness();
    await h.seed({ "key-v1": { sealed: "under-old-key" } });

    // The encrypted key-rotation defect: it reported `{ rotated: 1, failed: 0 }`
    // while writing the new copy and leaving the superseded one in place.
    await expect(
      expectNoDuplicateAfterRewrite(h, async () => {
        await h.memory.put(h.namespace, h.scope, "key-v2", {
          sealed: "under-new-key",
        });
      })
    ).rejects.toThrow(/rewrite grew the namespace 1 -> 2/);
  });

  it("accepts a rewrite that replaces in place", async () => {
    const h = spaceHarness();
    await h.seed({ "key-v1": { sealed: "old" } });

    await expectNoDuplicateAfterRewrite(h, async () => {
      await h.memory.put(h.namespace, h.scope, "key-v1", { sealed: "new" });
    });
  });
});

describe("census", () => {
  it("counts live, tombstone, and total records", async () => {
    const h = spaceHarness();
    await h.seed({
      a: { text: "a" },
      b: { _tombstone: true, _deletedAt: new Date(1).toISOString() },
    });

    expect(await censusOf(h)).toEqual({
      total: 2,
      live: 1,
      tombstones: 1,
      keys: ["a", "b"],
    });
  });
});

describe("expectScopeIsPopulated", () => {
  it("passes when the scope under test really was written to", async () => {
    const h = createMemoryHarness({
      namespace: "facts",
      scope: { tenantId: "t1" },
    });
    await h.memory.put("facts", { tenantId: "t1" }, "k1", { text: "hello" });

    await expectScopeIsPopulated(h);
  });

  it("rejects the silent-empty read: written to one scope, read from another", async () => {
    // The defect this guard exists for. Both scopes are valid and both tuples
    // are well-formed, so nothing in the stack objects — the record is simply
    // somewhere else, and the read returns [].
    const h = createMemoryHarness({
      namespace: "facts",
      scope: { tenantId: "t1" },
    });
    await h.memory.put("facts", { tenantId: "t1" }, "k1", { text: "hello" });

    await expect(
      expectScopeIsPopulated(h, { scope: { tenantId: "t2" } }),
    ).rejects.toThrow(/nothing was ever written/);
  });

  it("demonstrates what it protects: assertions over the empty read pass vacuously", async () => {
    const h = createMemoryHarness({
      namespace: "facts",
      scope: { tenantId: "t1" },
    });
    await h.memory.put("facts", { tenantId: "t1" }, "k1", { text: "hello" });

    const wrongScope = await h.liveKeys({ scope: { tenantId: "t2" } });

    // Every one of these passes against a population that does not exist,
    // which is exactly why the guard has to run before them.
    expect(wrongScope).toHaveLength(0);
    // eslint-disable-next-line no-restricted-syntax -- deliberately vacuous: this
    // line IS the hazard being demonstrated. It passes against a population that
    // does not exist, which is the reason expectScopeIsPopulated has to run first.
    expect(wrongScope.every((k) => k.startsWith("never-matches-"))).toBe(true);

    // The guard is what turns that silence into a failure.
    await expect(
      expectScopeIsPopulated(h, { scope: { tenantId: "t2" } }),
    ).rejects.toThrow();
  });
});
