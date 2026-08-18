import {
  materializeRecursiveScopedCommitV1,
  mergeRecursiveScopedCommitsV1,
  type RecursiveScopedCommitV1,
} from "@dzupagent/runtime-contracts/recursive-scope";

import { materializeRecursiveBranchPlanV1 } from "./branch-plan.js";
import {
  RecursiveScopedDispatchAbort,
  assertRecursiveAcknowledgementsKnownV1,
  prepareRecursiveChildV1,
  reconcileRecursiveCheckpointSaveV1,
  reconcileRecursiveCommitSaveV1,
  recursiveFrameWithCheckpointV1,
  type RecursivePreparedChildV1,
} from "./durable-child.js";
import type {
  RecursiveBranchDispatchInputV1,
  RecursiveBranchDispatchOutcomeV1,
  RecursiveBranchDispatchProgressV1,
  RecursiveBranchDispatcherDepsV1,
  RecursiveDeferredControlV1,
} from "./types.js";

type BranchChildRunResult =
  | { readonly status: "completed"; readonly commit: RecursiveScopedCommitV1 }
  | {
      readonly status: "suspended-for-later";
      readonly childScopeId: string;
      readonly control: RecursiveDeferredControlV1;
    }
  | { readonly status: "aborted"; readonly abort: RecursiveScopedDispatchAbort };

function snapshotProgress(
  dispatched: readonly string[],
  restored: readonly string[],
  skipped: readonly string[],
): RecursiveBranchDispatchProgressV1 {
  return {
    dispatchedChildScopeIds: [...dispatched],
    restoredChildScopeIds: [...restored],
    skippedCommittedChildScopeIds: [...skipped],
  };
}

function outcomeFromAbort(
  abort: RecursiveScopedDispatchAbort,
  progress: RecursiveBranchDispatchProgressV1,
): RecursiveBranchDispatchOutcomeV1 {
  return { ...abort.state, progress };
}

async function runChild(
  deps: RecursiveBranchDispatcherDepsV1,
  prepared: RecursivePreparedChildV1,
): Promise<BranchChildRunResult> {
  let currentFrame = prepared.frame;
  try {
    const executor = deps.createChildExecutor({ frame: currentFrame });
    const result = await executor.execute({
      frame: currentFrame,
      persistCheckpoint: async (checkpoint) => {
        const next = recursiveFrameWithCheckpointV1(currentFrame, checkpoint);
        currentFrame = await reconcileRecursiveCheckpointSaveV1(
          deps,
          currentFrame,
          next,
        );
        return currentFrame;
      },
    });

    if (result.status === "blocked") {
      return {
        status: "aborted",
        abort: new RecursiveScopedDispatchAbort({
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
          result.checkpoint,
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

    let commit: RecursiveScopedCommitV1;
    try {
      commit = materializeRecursiveScopedCommitV1({
        ...result.commit,
        frame: currentFrame,
      });
    } catch {
      return {
        status: "aborted",
        abort: new RecursiveScopedDispatchAbort({
          status: "corrupt",
          childScopeId: currentFrame.childScopeId,
          reason: "child-commit-corrupt",
        }),
      };
    }
    assertRecursiveAcknowledgementsKnownV1(commit);
    return {
      status: "completed",
      commit: await reconcileRecursiveCommitSaveV1(deps, currentFrame, commit),
    };
  } catch (error) {
    return {
      status: "aborted",
      abort:
        error instanceof RecursiveScopedDispatchAbort
          ? error
          : new RecursiveScopedDispatchAbort({
              status: "blocked",
              childScopeId: currentFrame.childScopeId,
              reason: "child-execution-failed",
            }),
    };
  }
}

/**
 * Dispatch a definition-bound normal branch/fork packet. No public pipeline
 * admission calls this function in W3-C1/W3-C2.
 */
export async function dispatchRecursiveBranchesV1(
  deps: RecursiveBranchDispatcherDepsV1,
  input: RecursiveBranchDispatchInputV1,
): Promise<RecursiveBranchDispatchOutcomeV1> {
  const dispatchedChildScopeIds: string[] = [];
  const restoredChildScopeIds: string[] = [];
  const skippedCommittedChildScopeIds: string[] = [];
  const progress = () =>
    snapshotProgress(
      dispatchedChildScopeIds,
      restoredChildScopeIds,
      skippedCommittedChildScopeIds,
    );

  let plan;
  try {
    plan = materializeRecursiveBranchPlanV1(input.plan);
  } catch {
    return {
      status: "corrupt",
      childScopeId: undefined,
      reason: "invalid-plan",
      progress: progress(),
    };
  }

  const prepared: RecursivePreparedChildV1[] = [];
  try {
    for (const frame of plan.frames) {
      prepared.push(
        await prepareRecursiveChildV1(
          deps,
          input.mode,
          frame,
          restoredChildScopeIds,
          skippedCommittedChildScopeIds,
        ),
      );
    }
  } catch (error) {
    const known =
      error instanceof RecursiveScopedDispatchAbort
        ? error
        : new RecursiveScopedDispatchAbort({
            status: "blocked",
            childScopeId: undefined,
            reason: "storage-error",
          });
    return outcomeFromAbort(known, progress());
  }

  const retainedCommits = prepared.flatMap(({ committed }) =>
    committed === undefined ? [] : [committed],
  );
  const eligible = prepared.filter(
    (child): child is RecursivePreparedChildV1 & { committed: undefined } =>
      child.committed === undefined,
  );
  dispatchedChildScopeIds.push(
    ...eligible.map(({ frame }) => frame.childScopeId),
  );

  const childResults = await Promise.all(
    eligible.map((child) => runChild(deps, child)),
  );
  const stopped = childResults.find(
    (result): result is Extract<BranchChildRunResult, { status: "aborted" }> =>
      result.status === "aborted",
  );
  if (stopped !== undefined) {
    return outcomeFromAbort(stopped.abort, progress());
  }
  const suspended = childResults.find(
    (
      result,
    ): result is Extract<
      BranchChildRunResult,
      { status: "suspended-for-later" }
    > => result.status === "suspended-for-later",
  );
  if (suspended !== undefined) {
    return {
      status: "suspended-for-later",
      childScopeId: suspended.childScopeId,
      control: suspended.control,
      progress: progress(),
    };
  }

  const commits = [
    ...retainedCommits,
    ...childResults.flatMap((result) =>
      result.status === "completed" ? [result.commit] : [],
    ),
  ];
  try {
    return {
      status: "completed",
      progress: progress(),
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
