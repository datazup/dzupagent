import {
  materializeRecursiveScopedCommitV1,
  mergeRecursiveScopedCommitsV1,
  resolveRecursiveAcknowledgementLossV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedJsonValue,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  RecursiveScopedDispatchAbort,
  assertRecursiveAcknowledgementsKnownV1,
  prepareRecursiveChildV1,
  reconcileRecursiveCheckpointSaveV1,
  reconcileRecursiveCommitSaveV1,
  recursiveFrameWithCheckpointV1,
} from "./durable-child.js";
import {
  bodyCompleteRecursiveForEachItemCheckpointV1,
  inFlightRecursiveForEachItemCheckpointV1,
  isRecursiveForEachItemCommitPayloadV1,
  parseRecursiveForEachItemCheckpointV1,
  type RecursiveForEachItemBodyCompleteCheckpointV1,
  type RecursiveForEachItemCheckpointV1,
} from "./for-each-item-checkpoint.js";
import { materializeRecursiveForEachItemPlanV1 } from "./for-each-item-plan.js";
import type {
  RecursiveForEachItemBlockedReasonV1,
  RecursiveForEachItemCorruptReasonV1,
  RecursiveForEachItemDispatchInputV1,
  RecursiveForEachItemDispatchOutcomeV1,
  RecursiveForEachItemDispatchProgressV1,
  RecursiveForEachItemDispatcherDepsV1,
  RecursiveForEachItemEconomicsBindingV1,
  RecursiveForEachPlannedItemV1,
} from "./for-each-item-types.js";
import type { RecursiveDeferredControlV1 } from "./types.js";

type ItemAbortState =
  | {
      readonly status: "retryable-before-dispatch";
      readonly childScopeId: string;
      readonly reason: "frame-acknowledgement-lost-without-evidence";
    }
  | {
      readonly status: "blocked";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveForEachItemBlockedReasonV1;
    }
  | {
      readonly status: "corrupt";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveForEachItemCorruptReasonV1;
    };

class RecursiveForEachItemDispatchAbort extends Error {
  override readonly name = "RecursiveForEachItemDispatchAbort";

  constructor(readonly state: ItemAbortState) {
    super(`${state.status}:${state.reason}`);
  }
}

interface PreparedItem {
  readonly planned: RecursiveForEachPlannedItemV1;
  readonly frame: RecursiveForEachPlannedItemV1["frame"];
  readonly committed: RecursiveScopedCommitV1 | undefined;
  readonly checkpoint: RecursiveForEachItemCheckpointV1;
}

interface CompletedItem {
  readonly commit: RecursiveScopedCommitV1;
  readonly orderedResult: RecursiveScopedJsonValue;
}

type ItemRunResult =
  | ({ readonly status: "completed" } & CompletedItem)
  | {
      readonly status: "suspended-for-later";
      readonly childScopeId: string;
      readonly control: RecursiveDeferredControlV1;
    }
  | { readonly status: "aborted"; readonly abort: RecursiveForEachItemDispatchAbort };

function abortItem(state: ItemAbortState): never {
  throw new RecursiveForEachItemDispatchAbort(state);
}

function asItemAbort(error: unknown, childScopeId?: string): RecursiveForEachItemDispatchAbort {
  if (error instanceof RecursiveForEachItemDispatchAbort) return error;
  if (error instanceof RecursiveScopedDispatchAbort) {
    return new RecursiveForEachItemDispatchAbort(error.state);
  }
  return new RecursiveForEachItemDispatchAbort({
    status: "blocked",
    childScopeId,
    reason: "child-execution-failed",
  });
}

function snapshotProgress(
  dispatched: readonly string[],
  restored: readonly string[],
  skippedBodyComplete: readonly string[],
  skippedCommitted: readonly string[],
): RecursiveForEachItemDispatchProgressV1 {
  return {
    dispatchedChildScopeIds: [...dispatched],
    restoredChildScopeIds: [...restored],
    skippedBodyCompleteChildScopeIds: [...skippedBodyComplete],
    skippedCommittedChildScopeIds: [...skippedCommitted],
  };
}

function parseItemCheckpoint(
  frame: RecursiveForEachPlannedItemV1["frame"],
  plan: Pick<RecursiveForEachItemDispatchInputV1["plan"], "collectionSourceDigest">,
  item: RecursiveForEachPlannedItemV1,
): RecursiveForEachItemCheckpointV1 {
  const parsed = parseRecursiveForEachItemCheckpointV1(
    frame,
    plan.collectionSourceDigest,
    item,
  );
  if (parsed.status !== "valid") {
    return abortItem({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason:
        parsed.status === "drift"
          ? "item-checkpoint-drift"
          : "item-checkpoint-corrupt",
    });
  }
  return parsed.checkpoint;
}

function materializeBodyCompleteCommit(
  item: PreparedItem,
  checkpoint: RecursiveForEachItemBodyCompleteCheckpointV1,
): RecursiveScopedCommitV1 {
  let commit: RecursiveScopedCommitV1;
  try {
    commit = materializeRecursiveScopedCommitV1({
      ...checkpoint.commit,
      frame: item.frame,
    });
  } catch {
    return abortItem({
      status: "corrupt",
      childScopeId: item.frame.childScopeId,
      reason: "child-commit-corrupt",
    });
  }
  assertRecursiveAcknowledgementsKnownV1(commit);
  assertItemEconomics(item.planned.economics, commit);
  return commit;
}

function assertItemEconomics(
  expected: RecursiveForEachItemEconomicsBindingV1 | undefined,
  commit: RecursiveScopedCommitV1,
): void {
  if (expected === undefined) return;
  const chargeKeys = Object.keys(commit.charges);
  const charge = commit.charges[expected.chargeKey];
  if (
    chargeKeys.length !== 1 ||
    charge === undefined ||
    charge.reservationIdentity !== expected.reservationIdentity ||
    charge.currency !== expected.currency ||
    charge.settledCostMicros > expected.hardCeilingMicros ||
    resolveRecursiveAcknowledgementLossV1(charge.acknowledgement).status !==
      "committed"
  ) {
    abortItem({
      status: "blocked",
      childScopeId: commit.childScopeId,
      reason: "item-economics-policy-blocked",
    });
  }
}

async function finalizeBodyComplete(
  deps: RecursiveForEachItemDispatcherDepsV1,
  item: PreparedItem,
): Promise<CompletedItem> {
  if (item.checkpoint.phase !== "body-complete") {
    return abortItem({
      status: "corrupt",
      childScopeId: item.frame.childScopeId,
      reason: "item-checkpoint-corrupt",
    });
  }
  const expectedCommit = materializeBodyCompleteCommit(item, item.checkpoint);
  if (
    item.committed !== undefined &&
    item.committed.commitIdentity !== expectedCommit.commitIdentity
  ) {
    return abortItem({
      status: "corrupt",
      childScopeId: item.frame.childScopeId,
      reason: "body-complete-commit-drift",
    });
  }
  return {
    commit:
      item.committed ??
      (await reconcileRecursiveCommitSaveV1(deps, item.frame, expectedCommit)),
    orderedResult: item.checkpoint.orderedResult,
  };
}

async function runItem(
  deps: RecursiveForEachItemDispatcherDepsV1,
  prepared: PreparedItem,
): Promise<ItemRunResult> {
  let currentFrame = prepared.frame;
  let currentCheckpoint = prepared.checkpoint;
  try {
    const executor = deps.createItemExecutor({
      frame: currentFrame,
      itemValue: prepared.planned.itemValue,
      checkpoint: currentCheckpoint.executorCheckpoint,
    });
    const result = await executor.execute({
      frame: currentFrame,
      itemValue: prepared.planned.itemValue,
      checkpoint: currentCheckpoint.executorCheckpoint,
      persistCheckpoint: async (checkpoint) => {
        const next = recursiveFrameWithCheckpointV1(
          currentFrame,
          inFlightRecursiveForEachItemCheckpointV1(
            currentCheckpoint,
            checkpoint,
          ),
        );
        currentFrame = await reconcileRecursiveCheckpointSaveV1(
          deps,
          currentFrame,
          next,
        );
        currentCheckpoint = parseItemCheckpoint(
          currentFrame,
          { collectionSourceDigest: prepared.checkpoint.collectionSourceDigest },
          prepared.planned,
        );
        return currentFrame;
      },
    });

    if (result.status === "blocked") {
      return {
        status: "aborted",
        abort: new RecursiveForEachItemDispatchAbort({
          status: "blocked",
          childScopeId: currentFrame.childScopeId,
          reason: "child-policy-blocked",
        }),
      };
    }
    if (result.status === "suspended-for-later") {
      if (result.checkpoint !== undefined) {
        const next = recursiveFrameWithCheckpointV1(
          currentFrame,
          inFlightRecursiveForEachItemCheckpointV1(
            currentCheckpoint,
            result.checkpoint,
          ),
        );
        currentFrame = await reconcileRecursiveCheckpointSaveV1(
          deps,
          currentFrame,
          next,
        );
      }
      return {
        status: "suspended-for-later",
        childScopeId: currentFrame.childScopeId,
        control: result.control,
      };
    }

    if (!isRecursiveForEachItemCommitPayloadV1(result.commit)) {
      return {
        status: "aborted",
        abort: new RecursiveForEachItemDispatchAbort({
          status: "corrupt",
          childScopeId: currentFrame.childScopeId,
          reason: "child-commit-corrupt",
        }),
      };
    }
    try {
      materializeRecursiveScopedCommitV1({
        ...result.commit,
        frame: currentFrame,
      });
    } catch {
      return {
        status: "aborted",
        abort: new RecursiveForEachItemDispatchAbort({
          status: "corrupt",
          childScopeId: currentFrame.childScopeId,
          reason: "child-commit-corrupt",
        }),
      };
    }

    const bodyCompleteFrame = recursiveFrameWithCheckpointV1(
      currentFrame,
      bodyCompleteRecursiveForEachItemCheckpointV1(
        currentCheckpoint,
        result.orderedResult,
        result.commit,
      ),
    );
    currentFrame = await reconcileRecursiveCheckpointSaveV1(
      deps,
      currentFrame,
      bodyCompleteFrame,
    );
    currentCheckpoint = parseItemCheckpoint(
      currentFrame,
      { collectionSourceDigest: prepared.checkpoint.collectionSourceDigest },
      prepared.planned,
    );
    if (currentCheckpoint.phase !== "body-complete") {
      return {
        status: "aborted",
        abort: new RecursiveForEachItemDispatchAbort({
          status: "corrupt",
          childScopeId: currentFrame.childScopeId,
          reason: "item-checkpoint-corrupt",
        }),
      };
    }
    const completed: PreparedItem = {
      ...prepared,
      frame: currentFrame,
      checkpoint: currentCheckpoint,
    };
    const finalized = await finalizeBodyComplete(deps, completed);
    return { status: "completed", ...finalized };
  } catch (error) {
    return {
      status: "aborted",
      abort: asItemAbort(error, currentFrame.childScopeId),
    };
  }
}

async function runBounded(
  items: readonly PreparedItem[],
  maxConcurrency: number,
  execute: (item: PreparedItem) => Promise<ItemRunResult>,
): Promise<readonly ItemRunResult[]> {
  const results = new Array<ItemRunResult>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await execute(items[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrency, items.length) },
      async () => worker(),
    ),
  );
  return results;
}

/**
 * Dispatch definition-bound recursive for_each items. This remains a private
 * Agent seam and is not called by public recursive admission in W3-C2.
 */
export async function dispatchRecursiveForEachItemsV1(
  deps: RecursiveForEachItemDispatcherDepsV1,
  input: RecursiveForEachItemDispatchInputV1,
): Promise<RecursiveForEachItemDispatchOutcomeV1> {
  const dispatchedChildScopeIds: string[] = [];
  const restoredChildScopeIds: string[] = [];
  const skippedBodyCompleteChildScopeIds: string[] = [];
  const skippedCommittedChildScopeIds: string[] = [];
  const progress = () =>
    snapshotProgress(
      dispatchedChildScopeIds,
      restoredChildScopeIds,
      skippedBodyCompleteChildScopeIds,
      skippedCommittedChildScopeIds,
    );
  const outcomeFromAbort = (
    abort: RecursiveForEachItemDispatchAbort,
  ): RecursiveForEachItemDispatchOutcomeV1 => ({
    ...abort.state,
    progress: progress(),
  });

  let plan;
  try {
    plan = materializeRecursiveForEachItemPlanV1(input.plan);
  } catch {
    return {
      status: "corrupt",
      childScopeId: undefined,
      reason: "invalid-plan",
      progress: progress(),
    };
  }

  const prepared: PreparedItem[] = [];
  try {
    for (const planned of plan.items) {
      const child = await prepareRecursiveChildV1(
        deps,
        input.mode,
        planned.frame,
        restoredChildScopeIds,
        skippedCommittedChildScopeIds,
      );
      const checkpoint = parseItemCheckpoint(child.frame, plan, planned);
      if (child.committed !== undefined && checkpoint.phase !== "body-complete") {
        return outcomeFromAbort(
          new RecursiveForEachItemDispatchAbort({
            status: "corrupt",
            childScopeId: child.frame.childScopeId,
            reason: "item-checkpoint-corrupt",
          }),
        );
      }
      prepared.push({ planned, ...child, checkpoint });
    }
  } catch (error) {
    return outcomeFromAbort(asItemAbort(error));
  }

  const completedByScope = new Map<string, CompletedItem>();
  try {
    for (const item of prepared) {
      if (item.checkpoint.phase !== "body-complete") continue;
      const completed = await finalizeBodyComplete(deps, item);
      completedByScope.set(item.frame.childScopeId, completed);
      if (item.committed === undefined) {
        skippedBodyCompleteChildScopeIds.push(item.frame.childScopeId);
      }
    }
  } catch (error) {
    return outcomeFromAbort(asItemAbort(error));
  }

  const eligible = prepared.filter(
    ({ checkpoint }) => checkpoint.phase === "in-flight",
  );
  dispatchedChildScopeIds.push(
    ...eligible.map(({ frame }) => frame.childScopeId),
  );
  const runResults = await runBounded(
    eligible,
    plan.maxConcurrency,
    async (item) => runItem(deps, item),
  );
  const stopped = runResults.find(
    (result): result is Extract<ItemRunResult, { status: "aborted" }> =>
      result.status === "aborted",
  );
  if (stopped !== undefined) return outcomeFromAbort(stopped.abort);
  const suspended = runResults.find(
    (
      result,
    ): result is Extract<ItemRunResult, { status: "suspended-for-later" }> =>
      result.status === "suspended-for-later",
  );
  if (suspended !== undefined) {
    return {
      status: "suspended-for-later",
      childScopeId: suspended.childScopeId,
      control: suspended.control,
      progress: progress(),
    };
  }
  eligible.forEach((item, index) => {
    const result = runResults[index];
    if (result?.status === "completed") {
      completedByScope.set(item.frame.childScopeId, result);
    }
  });

  const completed = prepared.map(({ frame }) =>
    completedByScope.get(frame.childScopeId),
  );
  if (completed.some((entry) => entry === undefined)) {
    return {
      status: "blocked",
      childScopeId: undefined,
      reason: "child-execution-failed",
      progress: progress(),
    };
  }
  const exact = completed as readonly CompletedItem[];
  const commits = exact.map(({ commit }) => commit);
  try {
    return {
      status: "completed",
      progress: progress(),
      orderedResults: exact.map(({ orderedResult }) => orderedResult),
      commits,
      merge: mergeRecursiveScopedCommitsV1(commits),
    };
  } catch {
    return {
      status: "blocked",
      childScopeId: undefined,
      reason: "merge-conflict",
      progress: progress(),
    };
  }
}
