import type {
  RecursiveScopedCommitInputV1,
  RecursiveScopedCommitV1,
  RecursiveScopedContinuationV1,
  RecursiveScopedFrameKindV1,
  RecursiveScopedFrameV1,
  RecursiveScopedJsonObject,
  RecursiveScopedMergeV1,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

export type RecursiveBranchFrameKindV1 = Extract<
  RecursiveScopedFrameKindV1,
  "branch" | "fork-branch"
>;

export interface RecursiveBranchDefinitionV1 {
  readonly branchOrdinal: number;
  readonly branchIdentity: string;
  readonly childScopeId: string;
  readonly scopedDefinitionId: string;
  readonly scopedDefinitionDigest: RecursiveScopedSha256Digest;
  readonly nodeInventory: readonly string[];
  readonly continuation: Omit<RecursiveScopedContinuationV1, "edgeOrdinal">;
  readonly checkpoint: RecursiveScopedJsonObject;
}

export interface RecursiveBranchPlanInputV1 {
  readonly frameKind: RecursiveBranchFrameKindV1;
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly ownerNodeId: string;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly branches: readonly RecursiveBranchDefinitionV1[];
}

export interface RecursiveBranchPlanV1 {
  readonly frameKind: RecursiveBranchFrameKindV1;
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly ownerNodeId: string;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  /** Strictly ordered by the definition-owned branch ordinal. */
  readonly frames: readonly RecursiveScopedFrameV1[];
}

export type RecursiveDurableWriteResultV1 =
  | {
      readonly status: "committed";
      readonly storedIdentity: RecursiveScopedSha256Digest;
    }
  | { readonly status: "acknowledgement-lost" }
  | { readonly status: "conflict" };

export interface RecursiveFrameCompareAndSaveInputV1 {
  readonly childScopeId: string;
  readonly expectedFrameIdentity: RecursiveScopedSha256Digest | undefined;
  readonly frameIdentity: RecursiveScopedSha256Digest;
  readonly serializedFrame: string;
}

export interface RecursiveCommitCompareAndSaveInputV1 {
  readonly childScopeId: string;
  readonly expectedCommitIdentity: RecursiveScopedSha256Digest | undefined;
  readonly commitIdentity: RecursiveScopedSha256Digest;
  readonly serializedCommit: string;
}

/**
 * Minimal durable boundary for W3-C1. Implementations own transport and CAS;
 * this packet deliberately provides no database or host adapter.
 */
export interface RecursiveBranchDurablePortV1 {
  loadFrame(childScopeId: string): Promise<string | undefined>;
  compareAndSaveFrame(
    input: RecursiveFrameCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1>;
  loadCommittedChild(childScopeId: string): Promise<string | undefined>;
  compareAndSaveCommittedChild(
    input: RecursiveCommitCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1>;
}

export type RecursiveBranchChildCommitPayloadV1 = Omit<
  RecursiveScopedCommitInputV1,
  "frame"
>;

export type RecursiveDeferredControlV1 =
  | "interaction"
  | "suspension"
  | "terminal"
  | "error";

export type RecursiveBranchChildExecutionV1 =
  | {
      readonly status: "completed";
      readonly commit: RecursiveBranchChildCommitPayloadV1;
    }
  | {
      readonly status: "suspended-for-later";
      readonly control: RecursiveDeferredControlV1;
      readonly checkpoint?: RecursiveScopedJsonObject;
    }
  | {
      readonly status: "blocked";
      readonly reason: "child-policy-blocked" | "invalid-child-state";
    };

export interface RecursiveBranchChildExecutionInputV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly persistCheckpoint: (
    checkpoint: RecursiveScopedJsonObject,
  ) => Promise<RecursiveScopedFrameV1>;
}

export interface RecursiveBranchChildExecutorV1 {
  execute(
    input: RecursiveBranchChildExecutionInputV1,
  ): Promise<RecursiveBranchChildExecutionV1>;
}

export type RecursiveBranchChildExecutorFactoryV1 = (
  input: Readonly<{ frame: RecursiveScopedFrameV1 }>,
) => RecursiveBranchChildExecutorV1;

export interface RecursiveBranchDispatcherDepsV1 {
  readonly durable: RecursiveBranchDurablePortV1;
  readonly createChildExecutor: RecursiveBranchChildExecutorFactoryV1;
}

export interface RecursiveBranchDispatchInputV1 {
  readonly mode: "initial" | "restart";
  readonly plan: RecursiveBranchPlanInputV1;
}

export interface RecursiveBranchDispatchProgressV1 {
  readonly dispatchedChildScopeIds: readonly string[];
  readonly restoredChildScopeIds: readonly string[];
  readonly skippedCommittedChildScopeIds: readonly string[];
}

export type RecursiveBranchBlockedReasonV1 =
  | "missing-frame"
  | "frame-save-conflict"
  | "frame-acknowledgement-unknown-after-dispatch"
  | "commit-save-conflict"
  | "commit-acknowledgement-unknown"
  | "operation-acknowledgement-unknown"
  | "storage-error"
  | "child-execution-failed"
  | "child-policy-blocked"
  | "merge-conflict";

export type RecursiveBranchCorruptReasonV1 =
  | "invalid-plan"
  | "frame-corrupt"
  | "frame-drift"
  | "commit-corrupt"
  | "commit-drift"
  | "child-commit-corrupt";

export type RecursiveBranchDispatchOutcomeV1 =
  | {
      readonly status: "completed";
      readonly progress: RecursiveBranchDispatchProgressV1;
      readonly commits: readonly RecursiveScopedCommitV1[];
      readonly merge: RecursiveScopedMergeV1;
    }
  | {
      readonly status: "retryable-before-dispatch";
      readonly progress: RecursiveBranchDispatchProgressV1;
      readonly childScopeId: string;
      readonly reason: "frame-acknowledgement-lost-without-evidence";
    }
  | {
      readonly status: "suspended-for-later";
      readonly progress: RecursiveBranchDispatchProgressV1;
      readonly childScopeId: string;
      readonly control: RecursiveDeferredControlV1;
    }
  | {
      readonly status: "blocked";
      readonly progress: RecursiveBranchDispatchProgressV1;
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveBranchBlockedReasonV1;
    }
  | {
      readonly status: "corrupt";
      readonly progress: RecursiveBranchDispatchProgressV1;
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveBranchCorruptReasonV1;
    };
