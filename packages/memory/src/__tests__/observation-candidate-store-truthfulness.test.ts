/**
 * Store-truthfulness coverage for the observation candidate store.
 *
 * The existing suite asserts `expect(removed).toBe(2)` — the count the prune
 * *reported*. That is the assertion every one of the six record-key defects
 * satisfied while leaving the store untouched, so on its own it cannot
 * distinguish a working prune from a no-op that returns the right number.
 *
 * These tests assert against the namespace instead, using the shared harness.
 * They also cover the tombstone-fallback path, where a delete-incapable store
 * overwrites records in place: if the tombstone ever landed on a derived key
 * rather than the real one, the namespace would grow on every pass while
 * reporting progress — the compounding failure that hit shared-space retention.
 */

import { describe, expect, it } from "vitest";
import { createMemoryHarness } from "../testing/memory-harness.js";
import {
  censusOf,
  expectRepeatedPassesDoNotGrow,
} from "../testing/report-truthfulness.js";
import { MemoryServiceObservationCandidateStore } from "../observation-candidate-store.js";
import type { StagedRecord } from "../staged-writer.js";

const STORE_NS = "observation-candidates";
const SCOPE = { tenantId: "t1", workspaceId: "w1" };

function harness() {
  return createMemoryHarness({ namespace: STORE_NS, scope: SCOPE });
}

function candidate(
  key: string,
  overrides: Partial<StagedRecord> = {}
): StagedRecord {
  return {
    key,
    namespace: "observations",
    scope: { ...SCOPE },
    value: { text: `Observation ${key}` },
    stage: "candidate",
    confidence: 0.85,
    createdAt: 1_000,
    promotedAt: 1_100,
    ...overrides,
  };
}

describe("observation candidate prune reports the truth", () => {
  it("removes from the store exactly what it reports removing", async () => {
    const h = harness();
    const candidates = new MemoryServiceObservationCandidateStore(
      h.memory,
      STORE_NS
    );

    await candidates.put(
      candidate("old-rejected", { stage: "rejected", createdAt: 100 })
    );
    await candidates.put(candidate("older-active", { createdAt: 800 }));
    await candidates.put(candidate("newer-active", { createdAt: 900 }));

    const before = await censusOf(h);
    expect(before.total).toBe(3);

    const removed = await candidates.prune("observations", SCOPE, {
      now: () => 1_000,
      maxRecords: 1,
      maxAgeMs: 10_000,
      rejectedMaxAgeMs: 500,
    });

    const after = await censusOf(h);

    // The reported count must match the observed delta, not merely be plausible.
    expect(removed).toBe(2);
    expect(before.total - after.total).toBe(removed);
    expect(after.keys).toEqual(["candidate:newer-active"]);
  });

  it("does not grow the namespace when pruning repeatedly", async () => {
    const h = harness();
    const candidates = new MemoryServiceObservationCandidateStore(
      h.memory,
      STORE_NS
    );

    await candidates.put(candidate("a", { createdAt: 100 }));
    await candidates.put(candidate("b", { createdAt: 200 }));

    // A prune that writes to a fabricated key adds records instead of removing
    // them; the first pass looks correct and every later pass compounds.
    await expectRepeatedPassesDoNotGrow(h, () =>
      candidates.prune("observations", SCOPE, {
        now: () => 1_000,
        maxRecords: 1,
        maxAgeMs: 10_000,
        rejectedMaxAgeMs: 500,
      })
    );
  });
});

describe("tombstone fallback when the store cannot delete", () => {
  /** A store that advertises no delete support, forcing the tombstone path. */
  function noDeleteHarness() {
    return createMemoryHarness({
      namespace: STORE_NS,
      scope: SCOPE,
      capabilities: { supportsDelete: false },
    });
  }

  it("overwrites the record in place rather than adding a new one", async () => {
    const h = noDeleteHarness();
    const candidates = new MemoryServiceObservationCandidateStore(
      h.memory,
      STORE_NS
    );
    const record = candidate("c3");
    await candidates.put(record);

    const before = await censusOf(h);
    expect(before.total).toBe(1);

    expect(await candidates.remove(record)).toBe(true);

    const after = await censusOf(h);
    // Same slot, now a tombstone — not a second record beside the original.
    expect(after.total).toBe(1);
    expect(after.keys).toEqual(before.keys);
    expect(await candidates.load("observations", SCOPE)).toEqual([]);
  });

  it("stays flat when the same record is removed repeatedly", async () => {
    const h = noDeleteHarness();
    const candidates = new MemoryServiceObservationCandidateStore(
      h.memory,
      STORE_NS
    );
    const record = candidate("c4");
    await candidates.put(record);

    await expectRepeatedPassesDoNotGrow(h, () => candidates.remove(record));
    expect(await candidates.load("observations", SCOPE)).toEqual([]);
  });
});
