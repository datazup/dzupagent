import {
  deserializeRecursiveScopedCommitV1,
  deserializeRecursiveScopedFrameV1,
  materializeRecursiveScopedFrameV1,
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

import type {
  RecursiveBranchBlockedReasonV1,
  RecursiveBranchCorruptReasonV1,
  RecursiveDurableWriteResultV1,
  RecursiveScopedDurablePortV1,
} from "./types.js";

export type RecursiveScopedDispatchAbortStateV1 =
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

export class RecursiveScopedDispatchAbort extends Error {
  override readonly name = "RecursiveScopedDispatchAbort";

  constructor(readonly state: RecursiveScopedDispatchAbortStateV1) {
    super(`${state.status}:${state.reason}`);
  }
}

export interface RecursivePreparedChildV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly committed: RecursiveScopedCommitV1 | undefined;
}

export interface RecursiveScopedDurableDepsV1 {
  readonly durable: RecursiveScopedDurablePortV1;
}

export function abortRecursiveScopedDispatch(
  state: RecursiveScopedDispatchAbortStateV1,
): never {
  throw new RecursiveScopedDispatchAbort(state);
}

async function storageCall<T>(
  childScopeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId,
      reason: "storage-error",
    });
  }
}

export function parseRecursiveStoredFrameV1(
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
    return abortRecursiveScopedDispatch({
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

export function parseRecursiveStoredCommitV1(
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
    return abortRecursiveScopedDispatch({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: drift ? "commit-drift" : "commit-corrupt",
    });
  }
}

export function assertRecursiveAcknowledgementsKnownV1(
  commit: RecursiveScopedCommitV1,
): void {
  const evidence = [
    ...Object.values(commit.effects).map((entry) => entry.acknowledgement),
    ...Object.values(commit.charges).map((entry) => entry.acknowledgement),
  ];
  if (
    evidence.some(
      (entry) => resolveRecursiveAcknowledgementLossV1(entry).status === "blocked",
    )
  ) {
    abortRecursiveScopedDispatch({
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
  return {
    kind: "for-each-item",
    forEachNodeId: frame.ownership.forEachNodeId,
    itemOrdinal: frame.ownership.itemOrdinal,
    itemIdentity: frame.ownership.itemIdentity,
  };
}

export function recursiveFrameWithCheckpointV1(
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
    return abortRecursiveScopedDispatch({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "frame-corrupt",
    });
  }
}

async function reconcileInitialFrameSave(
  deps: RecursiveScopedDurableDepsV1,
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
      return abortRecursiveScopedDispatch({
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
      return abortRecursiveScopedDispatch({
        status: "retryable-before-dispatch",
        childScopeId: frame.childScopeId,
        reason: "frame-acknowledgement-lost-without-evidence",
      });
    }
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "frame-save-conflict",
    });
  }
  const restored = parseRecursiveStoredFrameV1(observed, frame);
  if (restored.frameIdentity !== frame.frameIdentity) {
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "frame-save-conflict",
    });
  }
  return restored;
}

export async function reconcileRecursiveCheckpointSaveV1(
  deps: RecursiveScopedDurableDepsV1,
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
      return abortRecursiveScopedDispatch({
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
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId: next.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "frame-acknowledgement-unknown-after-dispatch"
          : "frame-save-conflict",
    });
  }
  const restored = parseRecursiveStoredFrameV1(observed, next);
  if (restored.frameIdentity !== next.frameIdentity) {
    return abortRecursiveScopedDispatch({
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

export async function reconcileRecursiveCommitSaveV1(
  deps: RecursiveScopedDurableDepsV1,
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
      return abortRecursiveScopedDispatch({
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
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "commit-acknowledgement-unknown"
          : "commit-save-conflict",
    });
  }
  const restored = parseRecursiveStoredCommitV1(observed, frame);
  if (restored.commitIdentity !== commit.commitIdentity) {
    return abortRecursiveScopedDispatch({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "commit-save-conflict",
    });
  }
  assertRecursiveAcknowledgementsKnownV1(restored);
  return restored;
}

export async function prepareRecursiveChildV1(
  deps: RecursiveScopedDurableDepsV1,
  mode: "initial" | "restart",
  planned: RecursiveScopedFrameV1,
  restoredChildScopeIds: string[],
  skippedCommittedChildScopeIds: string[],
): Promise<RecursivePreparedChildV1> {
  const storedFrame = await storageCall(planned.childScopeId, () =>
    deps.durable.loadFrame(planned.childScopeId),
  );
  let frame: RecursiveScopedFrameV1;
  if (storedFrame === undefined) {
    if (mode === "restart") {
      return abortRecursiveScopedDispatch({
        status: "blocked",
        childScopeId: planned.childScopeId,
        reason: "missing-frame",
      });
    }
    frame = await reconcileInitialFrameSave(deps, planned);
  } else {
    frame = parseRecursiveStoredFrameV1(storedFrame, planned);
    if (mode === "initial" && frame.frameIdentity !== planned.frameIdentity) {
      return abortRecursiveScopedDispatch({
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

  const committed = parseRecursiveStoredCommitV1(storedCommit, frame);
  assertRecursiveAcknowledgementsKnownV1(committed);
  skippedCommittedChildScopeIds.push(planned.childScopeId);
  return { frame, committed };
}

export function isRecursiveDurableWriteResultV1(
  value: unknown,
): value is RecursiveDurableWriteResultV1 {
  return typeof value === "object" && value !== null && "status" in value;
}
