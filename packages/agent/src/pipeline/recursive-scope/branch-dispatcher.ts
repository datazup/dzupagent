import {
  materializeRecursiveScopedCommitV1,
  mergeRecursiveScopedCommitsV1,
  type RecursiveScopedCommitV1,
} from "@dzupagent/runtime-contracts/recursive-scope";

import { materializeRecursiveBranchPlanV1 } from "./branch-plan.js";
import {
  RecursiveControlAbort,
  restoreRecursiveControlDecisionV1,
  settleRecursiveControlDecisionV1,
} from "./control-ownership.js";
import type {
  RecursiveControlCandidateV1,
  RecursiveControlPreparedChildV1,
  RecursiveControlScopeBindingV1,
} from "./control-types.js";
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
  | {
      readonly status: "completed";
      readonly frame: RecursivePreparedChildV1["frame"];
      readonly commit: RecursiveScopedCommitV1;
    }
  | {
      readonly status: "structured-control";
      readonly candidate: RecursiveControlCandidateV1;
    }
  | {
      readonly status: "suspended-for-later";
      readonly frame: RecursivePreparedChildV1["frame"];
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
      if (result.intent !== undefined) {
        if (result.intent.kind !== result.control) {
          return {
            status: "aborted",
            abort: new RecursiveScopedDispatchAbort({
              status: "corrupt",
              childScopeId: currentFrame.childScopeId,
              reason: "control-intent-corrupt",
            }),
          };
        }
        return {
          status: "structured-control",
          candidate: {
            frame: currentFrame,
            intent: result.intent,
            ...(result.commit === undefined ? {} : { commit: result.commit }),
          },
        };
      }
      return {
        status: "suspended-for-later",
        frame: currentFrame,
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
      frame: currentFrame,
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

  const controlBinding: RecursiveControlScopeBindingV1 = {
    rootDefinitionDigest: plan.rootDefinitionDigest,
    ownerPath: plan.ownerPath,
    parentCommitIdentity: plan.parentCommitIdentity,
  };
  if (
    (deps.control === undefined) !== (input.controlPolicy === undefined)
  ) {
    return {
      status: "blocked",
      childScopeId: undefined,
      reason: "control-policy-unavailable",
      progress: progress(),
    };
  }
  if (deps.control !== undefined && input.controlPolicy !== undefined) {
    try {
      const restored = await restoreRecursiveControlDecisionV1(
        { durable: deps.durable, control: deps.control },
        controlBinding,
        input.controlPolicy,
        prepared,
      );
      if (restored.status === "restored") {
        return {
          status: "suspended-for-later",
          childScopeId: restored.decision.ownerChildScopeId,
          control: restored.decision.kind,
          decision: restored.decision,
          progress: progress(),
        };
      }
    } catch (error) {
      if (error instanceof RecursiveControlAbort) {
        return { ...error.state, progress: progress() };
      }
      return {
        status: "blocked",
        childScopeId: undefined,
        reason: "storage-error",
        progress: progress(),
      };
    }
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
  const structured = childResults.filter(
    (
      result,
    ): result is Extract<BranchChildRunResult, { status: "structured-control" }> =>
      result.status === "structured-control",
  );
  const suspended = childResults.find(
    (
      result,
    ): result is Extract<
      BranchChildRunResult,
      { status: "suspended-for-later" }
    > => result.status === "suspended-for-later",
  );
  if (structured.length > 0) {
    if (
      deps.control === undefined ||
      input.controlPolicy === undefined
    ) {
      return {
        status: "blocked",
        childScopeId: undefined,
        reason: "control-policy-unavailable",
        progress: progress(),
      };
    }
    const soleStructured = structured.length === 1 ? structured[0] : undefined;
    if (
      suspended !== undefined &&
      soleStructured?.candidate.intent.kind !== "terminal"
    ) {
      return {
        status: "blocked",
        childScopeId: undefined,
        reason: "ambiguous-control-owner",
        progress: progress(),
      };
    }
    const latestByScope = new Map<string, RecursiveControlPreparedChildV1>();
    for (const result of childResults) {
      if (result.status === "completed") {
        latestByScope.set(result.frame.childScopeId, {
          frame: result.frame,
          committed: result.commit,
        });
      } else if (result.status === "structured-control") {
        latestByScope.set(result.candidate.frame.childScopeId, {
          frame: result.candidate.frame,
          committed: undefined,
        });
      } else if (result.status === "suspended-for-later") {
        latestByScope.set(result.frame.childScopeId, {
          frame: result.frame,
          committed: undefined,
        });
      }
    }
    const controlChildren: RecursiveControlPreparedChildV1[] = prepared.map(
      (child) => latestByScope.get(child.frame.childScopeId) ?? child,
    );
    try {
      const decision = await settleRecursiveControlDecisionV1(
        { durable: deps.durable, control: deps.control },
        controlBinding,
        input.controlPolicy,
        controlChildren,
        structured.map(({ candidate }) => candidate),
      );
      return {
        status: "suspended-for-later",
        childScopeId: decision.ownerChildScopeId,
        control: decision.kind,
        decision,
        progress: progress(),
      };
    } catch (error) {
      if (error instanceof RecursiveControlAbort) {
        return { ...error.state, progress: progress() };
      }
      return {
        status: "blocked",
        childScopeId: undefined,
        reason: "storage-error",
        progress: progress(),
      };
    }
  }
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
