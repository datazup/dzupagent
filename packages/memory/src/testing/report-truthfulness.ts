/**
 * Assertions that check a maintenance operation's *reported* counts against
 * what actually happened to the store.
 *
 * ## The defect class
 *
 * Six defects found in the memory layer shared one symptom, and it was not a
 * crash. Each operation returned a confident, well-formed report while the
 * store was untouched:
 *
 * | Reported                      | Actually happened |
 * | ----------------------------- | ----------------- |
 * | `{ pruned: 2 }`               | 0 records pruned; namespace *grew* by 2 tombstones |
 * | `{ tombstonesCompacted: 1 }`  | 0 records deleted |
 * | `{ rotated: 1, failed: 0 }`   | original left sealed under the superseded key |
 *
 * Tests asserting `expect(result.pruned).toBe(2)` pass against every one of
 * these. The assertion is satisfied by the *claim*, and the claim is the thing
 * that is wrong.
 *
 * ## The fix
 *
 * Take a store snapshot before and after, then require the report to agree
 * with the observed delta. This is independent of key handling, of the
 * operation's internals, and of whichever mechanism (delete vs. tombstone) the
 * implementation chose — so it catches this class without re-encoding it.
 *
 * @example
 * ```ts
 * const h = createMemoryHarness()
 * await h.seed({ a: {}, b: {}, c: {} })
 *
 * await expectPrunedCountIsTruthful(h, 2, () =>
 *   enforceRetentionForSpace(h.memory, space).then(r => r.pruned),
 * )
 * ```
 */

import { expect } from "vitest";
import type { MemoryHarness } from "./memory-harness.js";

/** Where in the namespace to measure. Defaults to the harness primary. */
export interface TruthfulnessTarget {
  namespace?: string;
  scope?: Record<string, string>;
}

/** Store counts captured at a single point in time. */
export interface StoreCensus {
  /** All records, tombstones included. */
  total: number;
  /** Records that are not tombstones. */
  live: number;
  /** Tombstone records. */
  tombstones: number;
  /** All store keys, sorted. */
  keys: string[];
}

/** Count records in the namespace by category. */
export async function censusOf(
  harness: MemoryHarness,
  target?: TruthfulnessTarget,
): Promise<StoreCensus> {
  const snapshot = await harness.snapshot(target);
  const tombstones = await harness.tombstoneKeys(target);
  return {
    total: snapshot.length,
    live: snapshot.length - tombstones.length,
    tombstones: tombstones.length,
    keys: snapshot.map((r) => r.key).sort(),
  };
}

/**
 * Assert that an operation reporting "I pruned N records" actually removed N
 * records from the live set.
 *
 * Accepts either mechanism: a real delete (total shrinks) or a tombstone
 * overwrite (total holds, live shrinks). What it rejects is the case where
 * neither moved — or where the namespace *grew*, which is what a fabricated
 * key produces, since the tombstone lands on a key no record occupies.
 *
 * @param harness fixture wrapping the store under test
 * @param expected the count the operation is expected to report
 * @param operation runs the operation and resolves to its reported count
 */
export async function expectPrunedCountIsTruthful(
  harness: MemoryHarness,
  expected: number,
  operation: () => Promise<number>,
  target?: TruthfulnessTarget,
): Promise<void> {
  const before = await censusOf(harness, target);
  const reported = await operation();
  const after = await censusOf(harness, target);

  expect(
    reported,
    `operation reported ${reported} pruned, expected ${expected}`,
  ).toBe(expected);

  const liveRemoved = before.live - after.live;
  expect(
    liveRemoved,
    `reported ${reported} pruned but the live record count went ` +
      `${before.live} -> ${after.live} (removed ${liveRemoved}). ` +
      `A report that does not match the store is the defect.`,
  ).toBe(reported);

  // Fabricated keys write tombstones to slots no record occupies, so the
  // namespace grows on every pass while the report claims progress.
  expect(
    after.total,
    `namespace grew from ${before.total} to ${after.total} while reporting ` +
      `${reported} pruned — tombstones are landing on keys that hold no record.`,
  ).toBeLessThanOrEqual(before.total);
}

/**
 * Assert that an operation reporting "I compacted N tombstones" actually
 * removed N records from the store.
 *
 * Compaction reclaims space, so unlike pruning the total *must* shrink by
 * exactly the reported count.
 */
export async function expectCompactedCountIsTruthful(
  harness: MemoryHarness,
  expected: number,
  operation: () => Promise<number>,
  target?: TruthfulnessTarget,
): Promise<void> {
  const before = await censusOf(harness, target);
  const reported = await operation();
  const after = await censusOf(harness, target);

  expect(
    reported,
    `operation reported ${reported} compacted, expected ${expected}`,
  ).toBe(expected);

  const removed = before.total - after.total;
  expect(
    removed,
    `reported ${reported} tombstones compacted but the store went ` +
      `${before.total} -> ${after.total} records (removed ${removed}). ` +
      `Compaction that reclaims nothing is a no-op reporting success.`,
  ).toBe(reported);
}

/**
 * Assert that repeating an idempotent maintenance pass does not grow the
 * namespace.
 *
 * This is the regression test for the compounding failure: retention wrote
 * tombstones under fabricated keys, so each sweep *added* records while
 * reporting that it had removed them. One pass looks fine in isolation; the
 * growth only shows up on the second.
 *
 * @param passes how many times to run the operation (minimum 2)
 */
export async function expectRepeatedPassesDoNotGrow(
  harness: MemoryHarness,
  operation: () => Promise<unknown>,
  passes = 3,
  target?: TruthfulnessTarget,
): Promise<void> {
  await operation();
  const afterFirst = await censusOf(harness, target);

  for (let pass = 2; pass <= passes; pass++) {
    await operation();
    const now = await censusOf(harness, target);
    expect(
      now.total,
      `namespace grew on pass ${pass}: ${afterFirst.total} records after ` +
        `pass 1, ${now.total} after pass ${pass}. A maintenance pass that ` +
        `adds records every time it runs will grow without bound.`,
    ).toBeLessThanOrEqual(afterFirst.total);
  }
}

/**
 * Assert that an operation claiming to have rewritten a record under a new
 * form (key rotation, re-encryption, migration) left no copy behind under the
 * original key.
 *
 * The encrypted key-rotation defect reported `{ rotated: 1, failed: 0 }` while
 * leaving the original sealed under the superseded key *and* writing a
 * duplicate — so the count was right and the store was still wrong.
 */
export async function expectNoDuplicateAfterRewrite(
  harness: MemoryHarness,
  operation: () => Promise<unknown>,
  target?: TruthfulnessTarget,
): Promise<void> {
  const before = await censusOf(harness, target);
  await operation();
  const after = await censusOf(harness, target);

  expect(
    after.total,
    `rewrite grew the namespace ${before.total} -> ${after.total}: the ` +
      `original was left in place alongside the rewritten copy.`,
  ).toBe(before.total);
}
