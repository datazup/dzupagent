import type {
  RecursiveIntentKindV1,
  RecursiveScopedCommitInputV1,
  RecursiveScopedCommitV1,
  RecursiveScopedFrameV1,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

export interface RecursiveControlIntentV1 {
  readonly kind: RecursiveIntentKindV1;
  readonly intentKey: string;
  readonly nodeId: string;
}

export interface RecursiveControlCatchRouteV1 {
  readonly errorNodeId: string;
  readonly catchNodeId: string;
  readonly catchOwnerPath: readonly string[];
}

export interface RecursiveControlPolicyV1 {
  readonly catchRoutes?: readonly RecursiveControlCatchRouteV1[];
}

export interface RecursiveControlScopeBindingV1 {
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveControlDecisionV1 {
  readonly schema: "dzupagent.recursiveControlDecision/v1";
  readonly controlScopeIdentity: RecursiveScopedSha256Digest;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly kind: RecursiveIntentKindV1;
  readonly intentKey: string;
  readonly nodeId: string;
  readonly ownerChildScopeId: string;
  readonly ownerFrameIdentity: RecursiveScopedSha256Digest;
  readonly ownerCommitIdentity: RecursiveScopedSha256Digest;
  readonly catchRoute: {
    readonly catchNodeId: string;
    readonly catchOwnerPath: readonly string[];
  } | null;
  readonly decisionIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveControlCandidateSetEntryV1 {
  readonly childScopeId: string;
  readonly frameIdentity: RecursiveScopedSha256Digest;
  readonly commitIdentity: RecursiveScopedSha256Digest;
  readonly serializedCommit: string;
}

/**
 * Complete control-candidate inventory written before any individual claim.
 * It prevents process death between claim commits from collapsing ambiguity.
 */
export interface RecursiveControlCandidateSetV1 {
  readonly schema: "dzupagent.recursiveControlCandidateSet/v1";
  readonly controlScopeIdentity: RecursiveScopedSha256Digest;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly candidates: readonly RecursiveControlCandidateSetEntryV1[];
  readonly candidateSetIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveControlCancellationV1 {
  readonly schema: "dzupagent.recursiveControlCancellation/v1";
  readonly controlScopeIdentity: RecursiveScopedSha256Digest;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly decisionIdentity: RecursiveScopedSha256Digest;
  readonly ownerCommitIdentity: RecursiveScopedSha256Digest;
  readonly childScopeId: string;
  readonly childFrameIdentity: RecursiveScopedSha256Digest;
  readonly cancellationIdentity: RecursiveScopedSha256Digest;
}

export type RecursiveControlDurableWriteResultV1 =
  | {
      readonly status: "committed";
      readonly storedIdentity: RecursiveScopedSha256Digest;
    }
  | { readonly status: "acknowledgement-lost" }
  | { readonly status: "conflict" };

export interface RecursiveControlDecisionCompareAndSaveInputV1 {
  readonly controlScopeIdentity: RecursiveScopedSha256Digest;
  readonly expectedDecisionIdentity: RecursiveScopedSha256Digest | undefined;
  readonly decisionIdentity: RecursiveScopedSha256Digest;
  readonly serializedDecision: string;
}

export interface RecursiveControlCancellationCompareAndSaveInputV1 {
  readonly childScopeId: string;
  readonly expectedCancellationIdentity:
    | RecursiveScopedSha256Digest
    | undefined;
  readonly cancellationIdentity: RecursiveScopedSha256Digest;
  readonly serializedCancellation: string;
}

export interface RecursiveControlCandidateSetCompareAndSaveInputV1 {
  readonly controlScopeIdentity: RecursiveScopedSha256Digest;
  readonly expectedCandidateSetIdentity:
    | RecursiveScopedSha256Digest
    | undefined;
  readonly candidateSetIdentity: RecursiveScopedSha256Digest;
  readonly serializedCandidateSet: string;
}

/** Private W3-C3 custody boundary; no database or host adapter is provided. */
export interface RecursiveControlDurablePortV1 {
  loadControlCandidateSet(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined>;
  compareAndSaveControlCandidateSet(
    input: RecursiveControlCandidateSetCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1>;
  loadControlDecision(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined>;
  compareAndSaveControlDecision(
    input: RecursiveControlDecisionCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1>;
  loadControlCancellation(childScopeId: string): Promise<string | undefined>;
  compareAndSaveControlCancellation(
    input: RecursiveControlCancellationCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1>;
}

export interface RecursiveControlCoordinatorV1 {
  readonly durable: RecursiveControlDurablePortV1;
}

export interface RecursiveControlPreparedChildV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly committed: RecursiveScopedCommitV1 | undefined;
}

export interface RecursiveControlCandidateV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly intent: RecursiveControlIntentV1;
  readonly commit?: Omit<RecursiveScopedCommitInputV1, "frame">;
  readonly committed?: RecursiveScopedCommitV1;
}

export type RecursiveControlBlockedReasonV1 =
  | "control-policy-unavailable"
  | "ambiguous-control-owner"
  | "catch-owner-missing"
  | "control-candidate-set-save-conflict"
  | "control-candidate-set-acknowledgement-unknown"
  | "control-decision-save-conflict"
  | "control-decision-acknowledgement-unknown"
  | "cancellation-save-conflict"
  | "cancellation-acknowledgement-unknown";

export type RecursiveControlCorruptReasonV1 =
  | "control-intent-corrupt"
  | "control-candidate-set-missing"
  | "control-candidate-set-corrupt"
  | "control-candidate-set-drift"
  | "catch-owner-ambiguous"
  | "control-decision-corrupt"
  | "control-decision-drift"
  | "control-owner-commit-missing"
  | "control-owner-commit-drift"
  | "control-cancellation-corrupt"
  | "control-cancellation-drift"
  | "control-cancellation-commit-conflict"
  | "orphan-control-cancellation";

export type RecursiveControlAbortStateV1 =
  | {
      readonly status: "blocked";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveControlBlockedReasonV1 | "storage-error";
    }
  | {
      readonly status: "corrupt";
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveControlCorruptReasonV1;
    };

export type RecursiveControlRestoreV1 =
  | { readonly status: "none" }
  | {
      readonly status: "restored";
      readonly decision: RecursiveControlDecisionV1;
    };
