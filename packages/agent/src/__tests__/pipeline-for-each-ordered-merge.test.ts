/**
 * Doc 27 §8 minimum proofs 2 and 3 for `for_each`:
 * "out-of-order completion without redispatch" and "concurrent commit
 * preservation".
 *
 * WHY THESE WERE UNIT TESTS. Both proofs describe behaviour under concurrency
 * greater than one. When they were written the admission gate pinned `for_each`
 * concurrency to exactly 1 (`for-each-loop.ts`), so a single worker completed
 * items strictly in input order and the merge's gap-filling branch was
 * structurally unreachable end-to-end. A test driving the runtime and
 * *claiming* to prove out-of-order behaviour would have been vacuous: it would
 * pass against a merge that ignored order entirely, because no gap would ever
 * exist to mishandle.
 *
 * 24-I RE-DATED. That premise no longer holds: N>1 is admitted and
 * `for-each-loop.ts` spawns `concurrency` real workers, so a genuine gap is
 * now constructible end-to-end. Proof 3 is discharged that way in
 * `pipeline-for-each-concurrent-frame-preservation.test.ts`, which kills a
 * mutant these unit tests cannot reach.
 *
 * These tests are KEPT and still earn their place: they qualify
 * `advanceCompletedPrefix` against completion orders a scheduler cannot be
 * made to produce on demand, which is coverage a run-based test trades away
 * for realism. What must NOT be claimed of them is that they prove the loop
 * schedules concurrently — see the paragraph below, which was already careful
 * about exactly that.
 *
 * `advanceCompletedPrefix` was therefore extracted so the completion pattern
 * becomes an input rather than an emergent property of the scheduler. That is
 * the same construction `restoreLoopStateAfterLostCommit` uses in the G2a
 * suite, and for the same stated reason.
 *
 * WHAT THIS DOES NOT PROVE. These tests qualify the merge ALGORITHM against
 * out-of-order input. They do not prove the loop schedules concurrently, that
 * item frames are durable across a crash at N>1, or that reservations settle
 * correctly under parallel dispatch — those need prereqs 2 and 4 and the
 * scheduler work in packet 24-G. Nothing here admits concurrency, and the
 * exact-1 guard is untouched.
 *
 * 24-I: the last clause is now stale in one direction only. Nothing in THIS
 * file admits concurrency — that remains true and is the point. But the
 * exact-1 guard itself no longer exists anywhere: 24-I replaced it with a
 * positive-integer check at all six sites. The prereqs named above (24-F, 24-G,
 * 24-H) shipped, which is what made that relaxation admissible.
 */
import { describe, expect, it } from "vitest";
import {
  advanceCompletedPrefix,
  appendAccumulatorValue,
  attachIterationValue,
  type ForEachMergeContract,
  type ForEachMergeState,
} from "../pipeline/loop-executor/for-each-merge.js";

/**
 * Build merge state for `size` items, with `completedIndices` already done.
 *
 * The per-index payloads are derived from the index so an aggregate assertion
 * names WHICH item contributed — a merge that folded the wrong index would
 * otherwise still produce an array of the right length.
 */
function mergeState(
  size: number,
  completedIndices: number[],
  overrides: Partial<ForEachMergeState> = {}
): ForEachMergeState {
  const completed = new Array<boolean>(size).fill(false);
  for (const index of completedIndices) completed[index] = true;
  return {
    completed,
    flushedPrefix: 0,
    collected: Array.from({ length: size }, (_v, i) => `collected-${i}`),
    enrichedItems: Array.from({ length: size }, (_v, i) => ({
      id: `item-${i}`,
    })),
    attachedValues: Array.from({ length: size }, (_v, i) => `attached-${i}`),
    accumulatorItems: Array.from({ length: size }, (_v, i) => `acc-${i}`),
    accumulatorValues: [],
    ...overrides,
  };
}

const AGGREGATING: ForEachMergeContract = {
  attachAs: "result",
  accumulator: {},
};

describe("for_each out-of-order completion (doc 27 §8 proof 2)", () => {
  it("does not retire an item whose predecessor is still running", () => {
    // The canonical concurrent interleaving: two workers, item 1 finishes
    // first. Retiring it would advance the durable cursor past item 0, and a
    // resume from that checkpoint would never run item 0 at all.
    const state = mergeState(3, [1]);

    const retired = advanceCompletedPrefix(state, AGGREGATING);

    expect(retired).toBe(0);
    expect(state.flushedPrefix).toBe(0);
    // The completion is remembered — prereq 3 keeps membership separate from
    // the cursor — so item 1 is not redispatched once item 0 lands.
    expect(state.completed[1]).toBe(true);
  });

  it("retires the whole run of completions once the gap closes", () => {
    // Items 1 and 2 finished while 0 was still running. When 0 lands, all
    // three retire in ONE advance: the cursor jumps to 3, not to 1.
    const state = mergeState(4, [1, 2]);
    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(0);

    state.completed[0] = true;
    const retired = advanceCompletedPrefix(state, AGGREGATING);

    expect(retired).toBe(3);
    expect(state.flushedPrefix).toBe(3);
  });

  it("folds aggregates in input order, not completion order", () => {
    // The load-bearing assertion for "ordered aggregation". Completion order
    // here is 2, 1, 0 — the exact reverse of input order. A merge that
    // appended on completion would produce acc-2, acc-1, acc-0.
    const state = mergeState(3, []);

    state.completed[2] = true;
    advanceCompletedPrefix(state, AGGREGATING);
    state.completed[1] = true;
    advanceCompletedPrefix(state, AGGREGATING);
    state.completed[0] = true;
    advanceCompletedPrefix(state, AGGREGATING);

    expect(state.accumulatorValues).toEqual(["acc-0", "acc-1", "acc-2"]);
    expect(state.flushedPrefix).toBe(3);
  });

  it("attaches each item its own value when completions interleave", () => {
    // Index-correctness under gap-filling: item i must receive attached-i.
    // An off-by-one in the gap loop would shift every attachment by one and
    // still yield a full, plausible-looking array.
    const state = mergeState(3, [2, 1]);
    state.completed[0] = true;

    advanceCompletedPrefix(state, AGGREGATING);

    expect(state.enrichedItems).toEqual([
      { id: "item-0", result: "attached-0" },
      { id: "item-1", result: "attached-1" },
      { id: "item-2", result: "attached-2" },
    ]);
  });

  it("never folds an already-retired item twice", () => {
    // Exactly-once. The loop calls the merge after EVERY item, so a
    // second call over an unchanged prefix is the common case, not an edge
    // case. Re-folding would duplicate every accumulator entry.
    const state = mergeState(2, [0]);
    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(1);

    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(0);
    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(0);

    expect(state.accumulatorValues).toEqual(["acc-0"]);
    expect(state.enrichedItems[0]).toEqual({
      id: "item-0",
      result: "attached-0",
    });
  });

  it("stops at the first gap even when every later item is complete", () => {
    // The strongest form of the gap rule: only index 0 is outstanding, and
    // everything after it is done. A merge that scanned for completions
    // rather than walking the contiguous prefix would retire all four.
    const state = mergeState(5, [1, 2, 3, 4]);

    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(0);
    expect(state.flushedPrefix).toBe(0);
    expect(state.accumulatorValues).toEqual([]);
  });

  it("resumes from a mid-run cursor without re-folding the earlier prefix", () => {
    // Resume path: `flushedPrefix` starts at the checkpoint's cursor. Items
    // 0 and 1 were retired in a previous run and must NOT be folded again,
    // even though their `completed` flags are absent this run.
    const state = mergeState(4, [2, 3], { flushedPrefix: 2 });

    const retired = advanceCompletedPrefix(state, AGGREGATING);

    expect(retired).toBe(2);
    expect(state.flushedPrefix).toBe(4);
    // Only the items completed in THIS run contribute.
    expect(state.accumulatorValues).toEqual(["acc-2", "acc-3"]);
  });
});

describe("for_each merge cursor vs membership (doc 27 §8 proof 3)", () => {
  it("reports zero retired when the cursor cannot move", () => {
    // Proof-3 relevance: the return value is what the loop uses to decide
    // whether to write a checkpoint. A merge that reported progress on an
    // unchanged cursor would have the loop commit a checkpoint claiming
    // durable progress that did not happen — and, under a lost CAS race,
    // resynchronize against a rival's version on a write it never needed.
    const state = mergeState(3, [2]);

    expect(advanceCompletedPrefix(state, {})).toBe(0);
    expect(state.flushedPrefix).toBe(0);
  });

  it("reports exactly the number of items the cursor advanced over", () => {
    const state = mergeState(4, [0, 1]);
    expect(advanceCompletedPrefix(state, {})).toBe(2);
    expect(state.flushedPrefix).toBe(2);
  });

  it("keeps membership intact across a merge that cannot advance", () => {
    // Prereq 3 verbatim: completed-item membership is separate from the
    // input-order merge cursor. A merge that cleared or consumed the
    // membership flags to mark them "handled" would lose the knowledge that
    // item 2 is done, and resume would redispatch it — the §3.1 defect.
    const state = mergeState(3, [2]);

    advanceCompletedPrefix(state, AGGREGATING);
    advanceCompletedPrefix(state, AGGREGATING);

    expect(state.completed).toEqual([false, false, true]);
  });

  it("keeps membership intact for items the cursor HAS retired", () => {
    // The case above only observes items the cursor never reached. This one
    // observes the retired prefix itself: a merge that cleared each flag as it
    // consumed it passes every other test here, because nothing else reads a
    // retired index's membership. It is not a harmless bookkeeping detail —
    // the loop's failure path filters `collected` and `enrichedItems` by
    // `completed[index]` to build its partial output, so cleared flags would
    // silently drop every successful item from a partially-failed run.
    const state = mergeState(3, [0, 1]);

    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(2);

    expect(state.completed).toEqual([true, true, false]);
  });
});

describe("for_each merge with no aggregation authored", () => {
  it("advances the cursor without touching items or accumulator", () => {
    // The default contract: no `attachAs`, no `accumulator`. The cursor must
    // still advance (it is the durable checkpoint), but nothing else changes.
    const state = mergeState(3, [0, 1, 2]);

    expect(advanceCompletedPrefix(state, {})).toBe(3);
    expect(state.flushedPrefix).toBe(3);
    expect(state.accumulatorValues).toEqual([]);
    expect(state.enrichedItems).toEqual([
      { id: "item-0" },
      { id: "item-1" },
      { id: "item-2" },
    ]);
  });

  it("advances over an empty completion set as a no-op", () => {
    const state = mergeState(3, []);
    expect(advanceCompletedPrefix(state, AGGREGATING)).toBe(0);
    expect(state.flushedPrefix).toBe(0);
  });
});

describe("appendAccumulatorValue", () => {
  it("does not mutate the array it was given", () => {
    // The loop publishes `accumulatorValues` into pipeline state on every
    // flush. An in-place push would retroactively mutate the array a previous
    // flush already handed to the host.
    const original = ["a"];
    const next = appendAccumulatorValue(original, "b");

    expect(original).toEqual(["a"]);
    expect(next).toEqual(["a", "b"]);
    expect(next).not.toBe(original);
  });

  it("keeps only the last `window` values", () => {
    expect(appendAccumulatorValue(["a", "b"], "c", 2)).toEqual(["b", "c"]);
  });

  it("keeps every value when no window is set", () => {
    expect(appendAccumulatorValue(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("applies the window while the merge advances over a gap", () => {
    // The window interacts with gap-filling: three items retire in one call,
    // and the window must be applied per append rather than once at the end.
    const state = mergeState(3, [0, 1, 2]);
    advanceCompletedPrefix(state, { accumulator: { window: 2 } });

    expect(state.accumulatorValues).toEqual(["acc-1", "acc-2"]);
  });
});

describe("attachIterationValue", () => {
  it("adds the value under the authored key", () => {
    expect(attachIterationValue({ id: "a" }, "result", 42)).toEqual({
      id: "a",
      result: 42,
    });
  });

  it("does not mutate the source item", () => {
    const item = { id: "a" };
    attachIterationValue(item, "result", 42);
    expect(item).toEqual({ id: "a" });
  });

  it("overwrites a colliding key rather than dropping the attachment", () => {
    expect(attachIterationValue({ result: "old" }, "result", "new")).toEqual({
      result: "new",
    });
  });

  it("returns non-object items unchanged", () => {
    // Coercing a scalar into an object here would silently rewrite the
    // author's source array into a shape they never declared.
    expect(attachIterationValue("scalar", "result", 42)).toBe("scalar");
    expect(attachIterationValue(null, "result", 42)).toBeNull();
    expect(attachIterationValue([1, 2], "result", 42)).toEqual([1, 2]);
  });
});
