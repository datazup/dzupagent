/**
 * Ordered-prefix publication for the `for_each` loop executor, split out of
 * `for-each-loop.ts` (DZUPAGENT-CODE-H-11) with its logic unchanged.
 *
 * @module pipeline/loop-executor/for-each-flush
 */

import type { NodeExecutionContext } from "../pipeline-runtime-types.js";
import type { LoopResumeOptions } from "./types.js";
import { setStatePath } from "./state-path.js";
import {
  advanceCompletedPrefix,
  type ForEachMergeState,
} from "./for-each-merge.js";
import type { ForEachContract } from "./for-each-aggregate-receipt.js";

/**
 * Build the flush that advances the ordered completed prefix and publishes
 * the aggregate outputs for it.
 */
export function createForEachPrefixFlush(input: {
  merge: ForEachMergeState;
  contract: ForEachContract;
  context: NodeExecutionContext;
  collected: unknown[];
  resume: LoopResumeOptions | undefined;
}): () => Promise<void> {
  const { merge, contract, context, collected, resume } = input;
  return async (): Promise<void> => {
    // The merge itself is synchronous and lives in `for-each-merge.ts`; only
    // the publish-and-checkpoint tail below is async. A zero return means the
    // cursor did not move, and no checkpoint may be written for it.
    const retired = advanceCompletedPrefix(merge, contract);
    if (retired === 0) return;

    if (contract.collect !== undefined) {
      setStatePath(
        context.state,
        contract.collect.into,
        collected.slice(0, merge.flushedPrefix)
      );
    }
    if (contract.attachAs !== undefined) {
      setStatePath(context.state, contract.source, merge.enrichedItems);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(
        context.state,
        contract.accumulator.key,
        merge.accumulatorValues
      );
    }
    await resume?.onIterationComplete?.(merge.flushedPrefix);
  };
}
