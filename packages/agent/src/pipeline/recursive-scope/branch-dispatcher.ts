import {
  deserializeRecursiveScopedCommitV1,
  deserializeRecursiveScopedFrameV1,
  materializeRecursiveScopedCommitV1,
  materializeRecursiveScopedFrameV1,
  mergeRecursiveScopedCommitsV1,
  recursiveScopedFrameBindingV1,
  resolveRecursiveAcknowledgementLossV1,
  serializeRecursiveScopedCommitV1,
  serializeRecursiveScopedFrameV1,
  type RecursiveScopedCommitBindingV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedJsonObject,
  type RecursiveScopedOwnershipInputV1,
} from "@dzupagent/runtime-contracts/recursive-scope";

import { materializeRecursiveBranchPlanV1 } from "./branch-plan.js";
import type {
  RecursiveBranchBlockedReasonV1,
  RecursiveBranchCorruptReasonV1,
  RecursiveBranchDispatchInputV1,
  RecursiveBranchDispatchOutcomeV1,
  RecursiveBranchDispatchProgressV1,
  RecursiveBranchDispatcherDepsV1,
  RecursiveDeferredControlV1,
} from "./types.js";

type DispatchAbortState =
  | {
      readonly status: "retryable-before-dispatch";
      readonly childScopeId: string;
      readonly reason: "frame-acknowledgement-lost-without-evidence";
    }
  | {
      readonly status: "blocked";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveBranchBlockedReasonV1;
    }
  | {
      readonly status: "corrupt";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveBranchCorruptReasonV1;
    };

class RecursiveBranchDispatchAbort extends Error {
  override readonly name = "RecursiveBranchDispatchAbort";

  constructor(readonly state: DispatchAbortState) {
    super(`${state.status}:${state.reason}`);
  }
}

interface PreparedChild {
  readonly frame: RecursiveScopedFrameV1;
  readonly committed: RecursiveScopedCommitV1 | undefined;
}

type ChildRunResult =
  | { readonly status: "completed"; readonly commit: RecursiveScopedCommitV1 }
  | {
      readonly status: "suspended-for-later";
      readonly childScopeId: string;
      readonly control: RecursiveDeferredControlV1;
    }
  | { readonly status: "aborted"; readonly abort: RecursiveBranchDispatchAbort };

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
  abort: RecursiveBranchDispatchAbort,
  progress: RecursiveBranchDispatchProgressV1,
): RecursiveBranchDispatchOutcomeV1 {
  return { ...abort.state, progress };
}

function abort(state: DispatchAbortState): never {
  throw new RecursiveBranchDispatchAbort(state);
}

async function storageCall<T>(
  childScopeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    return abort({
      status: "blocked",
      childScopeId,
      reason: "storage-error",
    });
  }
}

function parseFrame(
  serialized: string,
  expected: RecursiveScopedFrameV1,
): RecursiveScopedFrameV1 {
  try {
    return deserializeRecursiveScopedFrameV1(
      serialized,
      recursiveScopedFrameBindingV1(expected),
    );
  } catch (error) {
    const drift = error instanceof Error && error.message.includes("binding failed");
    return abort({
      status: "corrupt",
      childScopeId: expected.childScopeId,
      reason: drift ? "frame-drift" : "frame-corrupt",
    });
  }
}

function commitBindingFor(
  frame: RecursiveScopedFrameV1,
): RecursiveScopedCommitBindingV1 {
  return {
    rootDefinitionDigest: frame.definition.rootDefinitionDigest,
    ownerPath: frame.ownerPath,
    childScopeId: frame.childScopeId,
    childScopeIdentity: frame.childScopeIdentity,
    frameKind: frame.frameKind,
    ownership: frame.ownership,
    frameIdentity: frame.frameIdentity,
    parentCommitIdentity: frame.parentCommitIdentity,
  };
}

function parseCommit(
  serialized: string,
  frame: RecursiveScopedFrameV1,
): RecursiveScopedCommitV1 {
  try {
    return deserializeRecursiveScopedCommitV1(
      serialized,
      commitBindingFor(frame),
    );
  } catch (error) {
    const drift = error instanceof Error && error.message.includes("binding failed");
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: drift ? "commit-drift" : "commit-corrupt",
    });
  }
}

function assertAcknowledgementsKnown(commit: RecursiveScopedCommitV1): void {
  const evidence = [
    ...Object.values(commit.effects).map((entry) => entry.acknowledgement),
    ...Object.values(commit.charges).map((entry) => entry.acknowledgement),
  ];
  if (
    evidence.some(
      (entry) => resolveRecursiveAcknowledgementLossV1(entry).status === "blocked",
    )
  ) {
    abort({
      status: "blocked",
      childScopeId: commit.childScopeId,
      reason: "operation-acknowledgement-unknown",
    });
  }
}

function ownershipInputFor(
  frame: RecursiveScopedFrameV1,
): RecursiveScopedOwnershipInputV1 {
  if (frame.ownership.kind === "branch") {
    return {
      kind: "branch",
      branchNodeId: frame.ownership.branchNodeId,
      branchOrdinal: frame.ownership.branchOrdinal,
      branchIdentity: frame.ownership.branchIdentity,
    };
  }
  if (frame.ownership.kind === "fork-branch") {
    return {
      kind: "fork-branch",
      forkNodeId: frame.ownership.forkNodeId,
      branchOrdinal: frame.ownership.branchOrdinal,
      branchIdentity: frame.ownership.branchIdentity,
    };
  }
  return abort({
    status: "corrupt",
    childScopeId: frame.childScopeId,
    reason: "frame-drift",
  });
}

function frameWithCheckpoint(
  frame: RecursiveScopedFrameV1,
  checkpoint: RecursiveScopedJsonObject,
): RecursiveScopedFrameV1 {
  try {
    return materializeRecursiveScopedFrameV1({
      frameKind: frame.frameKind,
      definition: frame.definition,
      ownerPath: frame.ownerPath,
      childScopeId: frame.childScopeId,
      ownership: ownershipInputFor(frame),
      nodeInventory: frame.nodeInventory,
      continuation: frame.continuation,
      parentCommitIdentity: frame.parentCommitIdentity,
      checkpoint,
    });
  } catch {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "frame-corrupt",
    });
  }
}

async function reconcileInitialFrameSave(
  deps: RecursiveBranchDispatcherDepsV1,
  frame: RecursiveScopedFrameV1,
): Promise<RecursiveScopedFrameV1> {
  const write = await storageCall(frame.childScopeId, () =>
    deps.durable.compareAndSaveFrame({
      childScopeId: frame.childScopeId,
      expectedFrameIdentity: undefined,
      frameIdentity: frame.frameIdentity,
      serializedFrame: serializeRecursiveScopedFrameV1(frame),
    }),
  );
  if (write.status === "committed") {
    if (write.storedIdentity !== frame.frameIdentity) {
      return abort({
        status: "blocked",
        childScopeId: frame.childScopeId,
        reason: "frame-save-conflict",
      });
    }
    return frame;
  }

  const observed = await storageCall(frame.childScopeId, () =>
    deps.durable.loadFrame(frame.childScopeId),
  );
  if (observed === undefined) {
    if (write.status === "acknowledgement-lost") {
      return abort({
        status: "retryable-before-dispatch",
        childScopeId: frame.childScopeId,
        reason: "frame-acknowledgement-lost-without-evidence",
      });
    }
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "frame-save-conflict",
    });
  }
  const restored = parseFrame(observed, frame);
  if (restored.frameIdentity !== frame.frameIdentity) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "frame-save-conflict",
    });
  }
  return restored;
}

async function reconcileCheckpointSave(
  deps: RecursiveBranchDispatcherDepsV1,
  previous: RecursiveScopedFrameV1,
  next: RecursiveScopedFrameV1,
): Promise<RecursiveScopedFrameV1> {
  const write = await storageCall(next.childScopeId, () =>
    deps.durable.compareAndSaveFrame({
      childScopeId: next.childScopeId,
      expectedFrameIdentity: previous.frameIdentity,
      frameIdentity: next.frameIdentity,
      serializedFrame: serializeRecursiveScopedFrameV1(next),
    }),
  );
  if (write.status === "committed") {
    if (write.storedIdentity !== next.frameIdentity) {
      return abort({
        status: "blocked",
        childScopeId: next.childScopeId,
        reason: "frame-save-conflict",
      });
    }
    return next;
  }

  const observed = await storageCall(next.childScopeId, () =>
    deps.durable.loadFrame(next.childScopeId),
  );
  if (observed === undefined) {
    return abort({
      status: "blocked",
      childScopeId: next.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "frame-acknowledgement-unknown-after-dispatch"
          : "frame-save-conflict",
    });
  }
  const restored = parseFrame(observed, next);
  if (restored.frameIdentity !== next.frameIdentity) {
    return abort({
      status: "blocked",
      childScopeId: next.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "frame-acknowledgement-unknown-after-dispatch"
          : "frame-save-conflict",
    });
  }
  return restored;
}

async function reconcileCommitSave(
  deps: RecursiveBranchDispatcherDepsV1,
  frame: RecursiveScopedFrameV1,
  commit: RecursiveScopedCommitV1,
): Promise<RecursiveScopedCommitV1> {
  const write = await storageCall(frame.childScopeId, () =>
    deps.durable.compareAndSaveCommittedChild({
      childScopeId: frame.childScopeId,
      expectedCommitIdentity: undefined,
      commitIdentity: commit.commitIdentity,
      serializedCommit: serializeRecursiveScopedCommitV1(commit),
    }),
  );
  if (write.status === "committed") {
    if (write.storedIdentity !== commit.commitIdentity) {
      return abort({
        status: "blocked",
        childScopeId: frame.childScopeId,
        reason: "commit-save-conflict",
      });
    }
    return commit;
  }

  const observed = await storageCall(frame.childScopeId, () =>
    deps.durable.loadCommittedChild(frame.childScopeId),
  );
  if (observed === undefined) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "commit-acknowledgement-unknown"
          : "commit-save-conflict",
    });
  }
  const restored = parseCommit(observed, frame);
  if (restored.commitIdentity !== commit.commitIdentity) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "commit-save-conflict",
    });
  }
  assertAcknowledgementsKnown(restored);
  return restored;
}

async function prepareChild(
  deps: RecursiveBranchDispatcherDepsV1,
  mode: RecursiveBranchDispatchInputV1["mode"],
  planned: RecursiveScopedFrameV1,
  restoredChildScopeIds: string[],
  skippedCommittedChildScopeIds: string[],
): Promise<PreparedChild> {
  const storedFrame = await storageCall(planned.childScopeId, () =>
    deps.durable.loadFrame(planned.childScopeId),
  );
  let frame: RecursiveScopedFrameV1;
  if (storedFrame === undefined) {
    if (mode === "restart") {
      return abort({
        status: "blocked",
        childScopeId: planned.childScopeId,
        reason: "missing-frame",
      });
    }
    frame = await reconcileInitialFrameSave(deps, planned);
  } else {
    frame = parseFrame(storedFrame, planned);
    if (mode === "initial" && frame.frameIdentity !== planned.frameIdentity) {
      return abort({
        status: "blocked",
        childScopeId: planned.childScopeId,
        reason: "frame-save-conflict",
      });
    }
    restoredChildScopeIds.push(planned.childScopeId);
  }

  const storedCommit = await storageCall(planned.childScopeId, () =>
    deps.durable.loadCommittedChild(planned.childScopeId),
  );
  if (storedCommit === undefined) return { frame, committed: undefined };

  const committed = parseCommit(storedCommit, frame);
  assertAcknowledgementsKnown(committed);
  skippedCommittedChildScopeIds.push(planned.childScopeId);
  return { frame, committed };
}

async function runChild(
  deps: RecursiveBranchDispatcherDepsV1,
  prepared: PreparedChild,
): Promise<ChildRunResult> {
  let currentFrame = prepared.frame;
  try {
    const executor = deps.createChildExecutor({ frame: currentFrame });
    const result = await executor.execute({
      frame: currentFrame,
      persistCheckpoint: async (checkpoint) => {
        const next = frameWithCheckpoint(currentFrame, checkpoint);
        currentFrame = await reconcileCheckpointSave(
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
        abort: new RecursiveBranchDispatchAbort({
          status: "blocked",
          childScopeId: currentFrame.childScopeId,
          reason: "child-policy-blocked",
        }),
      };
    }
    if (result.status === "suspended-for-later") {
      if (result.checkpoint !== undefined) {
        const next = frameWithCheckpoint(currentFrame, result.checkpoint);
        currentFrame = await reconcileCheckpointSave(
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
        abort: new RecursiveBranchDispatchAbort({
          status: "corrupt",
          childScopeId: currentFrame.childScopeId,
          reason: "child-commit-corrupt",
        }),
      };
    }
    assertAcknowledgementsKnown(commit);
    return {
      status: "completed",
      commit: await reconcileCommitSave(deps, currentFrame, commit),
    };
  } catch (error) {
    return {
      status: "aborted",
      abort:
        error instanceof RecursiveBranchDispatchAbort
          ? error
          : new RecursiveBranchDispatchAbort({
              status: "blocked",
              childScopeId: currentFrame.childScopeId,
              reason: "child-execution-failed",
            }),
    };
  }
}

/**
 * Dispatch a definition-bound normal branch/fork packet. No public pipeline
 * admission calls this function in W3-C1.
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

  const prepared: PreparedChild[] = [];
  try {
    for (const frame of plan.frames) {
      prepared.push(
        await prepareChild(
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
      error instanceof RecursiveBranchDispatchAbort
        ? error
        : new RecursiveBranchDispatchAbort({
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
    (child): child is PreparedChild & { committed: undefined } =>
      child.committed === undefined,
  );
  dispatchedChildScopeIds.push(
    ...eligible.map(({ frame }) => frame.childScopeId),
  );

  const childResults = await Promise.all(
    eligible.map((child) => runChild(deps, child)),
  );
  const stopped = childResults.find(
    (result): result is Extract<ChildRunResult, { status: "aborted" }> =>
      result.status === "aborted",
  );
  if (stopped !== undefined) {
    return outcomeFromAbort(stopped.abort, progress());
  }
  const suspended = childResults.find(
    (
      result,
    ): result is Extract<
      ChildRunResult,
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
