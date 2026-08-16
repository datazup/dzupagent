/**
 * for_each ordered-prefix merge — the algorithm that turns per-item completions
 * into the loop's durable cursor and its ordered aggregates.
 *
 * Extracted from `for-each-loop.ts` for doc 27 §8's minimum proofs 2 and 3
 * ("out-of-order completion without redispatch", "concurrent commit
 * preservation"). Those proofs are about what happens when item N+1 finishes
 * before item N — a state the runtime CANNOT currently reach, because
 * `concurrency` is pinned to exactly 1 by the admission gate. Driven only
 * through the loop, the gap-filling branch of this algorithm is structurally
 * unreachable and any test claiming to cover it would be vacuous.
 *
 * Extracting it makes the branch reachable as a unit while leaving the
 * admission gate untouched: this module changes no runtime behaviour at
 * concurrency 1, and admits nothing.
 *
 * @module pipeline/loop-executor/for-each-merge
 */

/**
 * The mutable merge state owned by one `for_each` execution.
 *
 * Deliberately a plain object rather than a class: the loop already owns these
 * arrays and the point of the extraction is to let a test construct an
 * arbitrary completion pattern directly, including patterns the sequential
 * runtime cannot produce.
 */
export interface ForEachMergeState {
  /**
   * Doc 27 §8 prereq 3: completed-item MEMBERSHIP, kept separate from the
   * input-order merge cursor below. `completed[i]` is true once item `i`'s
   * work is done, whatever order that happened in.
   */
  readonly completed: boolean[];
  /**
   * The input-order merge cursor: the length of the contiguous completed
   * prefix. Only this advances the durable checkpoint. An item completed out
   * of order is remembered in `completed` but does not move the cursor until
   * every earlier item has also completed.
   */
  flushedPrefix: number;
  /** Per-index value contributed to `collect`, indexed by input position. */
  readonly collected: unknown[];
  /** Source items, enriched in place when `attachAs` is authored. */
  readonly enrichedItems: unknown[];
  /** Per-index value to attach, indexed by input position. */
  readonly attachedValues: unknown[];
  /** Per-index value to accumulate, indexed by input position. */
  readonly accumulatorItems: unknown[];
  /** Ordered accumulator, appended to strictly in input order. */
  accumulatorValues: unknown[];
}

/** The aggregation shape the merge needs from the authored contract. */
export interface ForEachMergeContract {
  readonly attachAs?: string | undefined;
  readonly accumulator?: { readonly window?: number | undefined } | undefined;
}

/**
 * Advance the ordered prefix over every contiguous completed item, folding
 * each newly-retired item into the ordered aggregates exactly once.
 *
 * Returns the number of items retired by this call. Zero means the cursor did
 * not move — the caller must then NOT write a checkpoint, because a checkpoint
 * at an unchanged cursor claims durable progress that did not happen.
 *
 * The gap rule is the load-bearing property: the loop stops at the first
 * incomplete index even when later indices are complete. Retiring past a gap
 * would record a cursor whose prefix includes an item that never ran, and
 * resume would then skip it entirely — silent data loss, the mirror image of
 * the redispatch defect in §3.1.
 *
 * Exactly-once is the second property: an item already inside the prefix must
 * never be folded again. A merge that re-folded on a second call would double
 * every accumulator entry, which is how a retry loop corrupts an aggregate.
 */
export function advanceCompletedPrefix(
  state: ForEachMergeState,
  contract: ForEachMergeContract
): number {
  const startedAt = state.flushedPrefix;
  while (state.completed[state.flushedPrefix] === true) {
    if (contract.attachAs !== undefined) {
      state.enrichedItems[state.flushedPrefix] = attachIterationValue(
        state.enrichedItems[state.flushedPrefix],
        contract.attachAs,
        state.attachedValues[state.flushedPrefix]
      );
    }
    if (contract.accumulator !== undefined) {
      state.accumulatorValues = appendAccumulatorValue(
        state.accumulatorValues,
        state.accumulatorItems[state.flushedPrefix],
        contract.accumulator.window
      );
    }
    state.flushedPrefix++;
  }
  return state.flushedPrefix - startedAt;
}

/**
 * Append one value to the ordered accumulator, honouring a sliding window.
 *
 * Copies rather than mutating: the loop publishes `accumulatorValues` into
 * pipeline state, and an in-place push would retroactively mutate a value a
 * previous flush already handed out.
 */
export function appendAccumulatorValue(
  values: unknown[],
  value: unknown,
  window?: number | undefined
): unknown[] {
  const next = [...values, value];
  return window === undefined ? next : next.slice(-window);
}

/**
 * Attach a per-item value to an object item under `attachAs`.
 *
 * Non-object items (primitives, arrays, null) are returned unchanged rather
 * than being coerced into objects: `attachAs` over a scalar source has no
 * meaningful shape, and inventing one would silently rewrite the author's data.
 */
export function attachIterationValue(
  item: unknown,
  attachAs: string,
  value: unknown
): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return item;
  }
  return { ...(item as Record<string, unknown>), [attachAs]: value };
}
