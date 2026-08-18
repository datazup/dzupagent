import type { CANONICAL_JSON_VERSION } from "../idempotency.js";

export const RECURSIVE_SCOPED_FRAME_SCHEMA_V1 =
  "dzupagent.recursiveScopedFrame/v1" as const;
export const RECURSIVE_SCOPED_COMMIT_SCHEMA_V1 =
  "dzupagent.recursiveScopedCommit/v1" as const;
export const RECURSIVE_SCOPED_MERGE_SCHEMA_V1 =
  "dzupagent.recursiveScopedMerge/v1" as const;
export const RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1 =
  "dzupagent.recursiveAcknowledgement/v1" as const;

export type RecursiveScopedSha256Digest = `sha256:${string}`;

export type RecursiveScopedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RecursiveScopedJsonValue[]
  | RecursiveScopedJsonObject;

export interface RecursiveScopedJsonObject {
  readonly [key: string]: RecursiveScopedJsonValue;
}

export type RecursiveScopedFrameKindV1 =
  | "branch"
  | "fork-branch"
  | "for-each-item";

export interface RecursiveScopedDefinitionBindingV1 {
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly scopedDefinitionId: string;
  readonly scopedDefinitionDigest: RecursiveScopedSha256Digest;
}

export interface RecursiveScopedContinuationV1 {
  readonly kind: "node" | "fork-join" | "for-each-join";
  readonly nodeId: string;
  readonly edgeOrdinal: number;
}

export interface RecursiveBranchOwnershipV1 {
  readonly kind: "branch";
  readonly branchNodeId: string;
  readonly branchOrdinal: number;
  readonly branchIdentity: string;
  readonly ordinalIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveForkBranchOwnershipV1 {
  readonly kind: "fork-branch";
  readonly forkNodeId: string;
  readonly branchOrdinal: number;
  readonly branchIdentity: string;
  readonly ordinalIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveForEachItemOwnershipV1 {
  readonly kind: "for-each-item";
  readonly forEachNodeId: string;
  readonly itemOrdinal: number;
  readonly itemIdentity: RecursiveScopedSha256Digest;
  readonly ordinalIdentity: RecursiveScopedSha256Digest;
}

export type RecursiveScopedOwnershipV1 =
  | RecursiveBranchOwnershipV1
  | RecursiveForkBranchOwnershipV1
  | RecursiveForEachItemOwnershipV1;

export type RecursiveScopedOwnershipInputV1 =
  | Omit<RecursiveBranchOwnershipV1, "ordinalIdentity">
  | Omit<RecursiveForkBranchOwnershipV1, "ordinalIdentity">
  | Omit<RecursiveForEachItemOwnershipV1, "ordinalIdentity">;

export interface RecursiveScopedFrameV1 {
  readonly schema: typeof RECURSIVE_SCOPED_FRAME_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly frameKind: RecursiveScopedFrameKindV1;
  readonly definition: RecursiveScopedDefinitionBindingV1;
  /** Definition-owned path of the parent that owns this child scope. */
  readonly ownerPath: readonly string[];
  readonly childScopeId: string;
  readonly childScopeIdentity: RecursiveScopedSha256Digest;
  readonly ownership: RecursiveScopedOwnershipV1;
  /** Canonically sorted, unique inventory of nodes owned by the child scope. */
  readonly nodeInventory: readonly string[];
  readonly nodeInventoryDigest: RecursiveScopedSha256Digest;
  readonly continuation: RecursiveScopedContinuationV1;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly checkpoint: RecursiveScopedJsonObject;
  readonly frameIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveScopedFrameInputV1 {
  readonly frameKind: RecursiveScopedFrameKindV1;
  readonly definition: RecursiveScopedDefinitionBindingV1;
  readonly ownerPath: readonly string[];
  readonly childScopeId: string;
  readonly ownership: RecursiveScopedOwnershipInputV1;
  readonly nodeInventory: readonly string[];
  readonly continuation: RecursiveScopedContinuationV1;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly checkpoint: RecursiveScopedJsonObject;
}

export type RecursiveScopedFrameBindingV1 = Pick<
  RecursiveScopedFrameV1,
  | "frameKind"
  | "definition"
  | "ownerPath"
  | "childScopeId"
  | "childScopeIdentity"
  | "ownership"
  | "nodeInventoryDigest"
  | "continuation"
  | "parentCommitIdentity"
>;

export type RecursiveIntentKindV1 =
  | "interaction"
  | "suspension"
  | "terminal"
  | "error";

export interface RecursiveIntentClaimV1 {
  readonly kind: RecursiveIntentKindV1;
  readonly intentKey: string;
  readonly nodeId: string;
  readonly ownerFrameIdentity: RecursiveScopedSha256Digest;
  readonly claimIdentity: RecursiveScopedSha256Digest;
}

export type RecursiveIntentClaimInputV1 = Pick<
  RecursiveIntentClaimV1,
  "kind" | "intentKey" | "nodeId"
>;

export type RecursiveAcknowledgementBoundaryV1 = "effect" | "charge";
export type RecursiveAcknowledgementStatusV1 =
  | "committed"
  | "retryable"
  | "blocked";

export type RecursiveAcknowledgementObservationV1 =
  | {
      readonly kind: "durable-commit";
      readonly committedIdentity: RecursiveScopedSha256Digest;
      readonly evidenceDigest: RecursiveScopedSha256Digest;
    }
  | {
      readonly kind: "confirmed-absent";
      readonly evidenceDigest: RecursiveScopedSha256Digest;
    }
  | {
      readonly kind: "uncertain";
      readonly evidenceDigest: RecursiveScopedSha256Digest;
    };

export interface RecursiveAcknowledgementEvidenceV1 {
  readonly schema: typeof RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly boundary: RecursiveAcknowledgementBoundaryV1;
  readonly operationIdentity: RecursiveScopedSha256Digest;
  readonly ownerFrameIdentity: RecursiveScopedSha256Digest;
  readonly status: RecursiveAcknowledgementStatusV1;
  readonly observation: RecursiveAcknowledgementObservationV1;
  readonly observedAt: string;
  readonly reconciliationIdentity: RecursiveScopedSha256Digest;
}

export type RecursiveAcknowledgementEvidenceInputV1 = Pick<
  RecursiveAcknowledgementEvidenceV1,
  "status" | "observation" | "observedAt"
>;

export interface RecursiveEffectCommitEvidenceV1 {
  readonly effectIdentity: RecursiveScopedSha256Digest;
  readonly idempotencyKey: string;
  readonly intentDigest: RecursiveScopedSha256Digest;
  readonly acknowledgement: RecursiveAcknowledgementEvidenceV1;
  readonly effectCommitIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveEffectCommitInputV1 {
  readonly idempotencyKey: string;
  readonly intentDigest: RecursiveScopedSha256Digest;
  readonly acknowledgement: RecursiveAcknowledgementEvidenceInputV1;
}

export interface RecursiveChargeCommitEvidenceV1 {
  readonly chargeIdentity: RecursiveScopedSha256Digest;
  readonly reservationIdentity: RecursiveScopedSha256Digest;
  readonly measurementDigest: RecursiveScopedSha256Digest;
  readonly settledCostMicros: number;
  readonly currency: string;
  readonly acknowledgement: RecursiveAcknowledgementEvidenceV1;
  readonly chargeCommitIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveChargeCommitInputV1 {
  readonly reservationIdentity: RecursiveScopedSha256Digest;
  readonly measurementDigest: RecursiveScopedSha256Digest;
  readonly settledCostMicros: number;
  readonly currency: string;
  readonly acknowledgement: RecursiveAcknowledgementEvidenceInputV1;
}

export interface RecursiveScopedCommitV1 {
  readonly schema: typeof RECURSIVE_SCOPED_COMMIT_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly childScopeId: string;
  readonly childScopeIdentity: RecursiveScopedSha256Digest;
  readonly frameKind: RecursiveScopedFrameKindV1;
  readonly ownership: RecursiveScopedOwnershipV1;
  readonly frameIdentity: RecursiveScopedSha256Digest;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly state: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly results: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly idempotencyKeys: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, RecursiveEffectCommitEvidenceV1>>;
  readonly charges: Readonly<Record<string, RecursiveChargeCommitEvidenceV1>>;
  readonly intentClaims: readonly RecursiveIntentClaimV1[];
  readonly commitIdentity: RecursiveScopedSha256Digest;
}

export interface RecursiveScopedCommitInputV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly state?: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly results?: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly idempotencyKeys?: Readonly<Record<string, string>>;
  readonly effects?: Readonly<Record<string, RecursiveEffectCommitInputV1>>;
  readonly charges?: Readonly<Record<string, RecursiveChargeCommitInputV1>>;
  readonly intentClaims?: readonly RecursiveIntentClaimInputV1[];
}

export type RecursiveScopedCommitBindingV1 = Pick<
  RecursiveScopedCommitV1,
  | "rootDefinitionDigest"
  | "ownerPath"
  | "childScopeId"
  | "childScopeIdentity"
  | "frameKind"
  | "ownership"
  | "frameIdentity"
  | "parentCommitIdentity"
>;

export interface RecursiveScopedMergeV1 {
  readonly schema: typeof RECURSIVE_SCOPED_MERGE_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  /** Sorted commit identities make merge bytes independent of arrival order. */
  readonly childCommitIdentities: readonly RecursiveScopedSha256Digest[];
  /** Sorted frame identities bind every owner referenced by merged evidence. */
  readonly childFrameIdentities: readonly RecursiveScopedSha256Digest[];
  readonly state: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly results: Readonly<Record<string, RecursiveScopedJsonValue>>;
  readonly idempotencyKeys: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, RecursiveEffectCommitEvidenceV1>>;
  readonly charges: Readonly<Record<string, RecursiveChargeCommitEvidenceV1>>;
  readonly intentClaims: readonly RecursiveIntentClaimV1[];
  readonly mergeIdentity: RecursiveScopedSha256Digest;
}

export type RecursiveScopedMergeBindingV1 = Pick<
  RecursiveScopedMergeV1,
  | "rootDefinitionDigest"
  | "ownerPath"
  | "parentCommitIdentity"
  | "childCommitIdentities"
  | "childFrameIdentities"
>;

export type RecursiveScopeContractIssueCode =
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_VERSION"
  | "DIGEST_MISMATCH"
  | "BINDING_MISMATCH"
  | "OWNERSHIP_CONFLICT"
  | "MERGE_CONFLICT";

export interface RecursiveScopeContractIssue {
  readonly code: RecursiveScopeContractIssueCode;
  readonly path: string;
  readonly message: string;
}

export type RecursiveScopeContractValidation<T> =
  | {
      readonly valid: true;
      readonly value: T;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly issues: readonly RecursiveScopeContractIssue[];
    };

export type RecursiveAcknowledgementResolutionV1 =
  | {
      readonly status: "committed";
      readonly committedIdentity: RecursiveScopedSha256Digest;
      readonly evidenceDigest: RecursiveScopedSha256Digest;
    }
  | {
      readonly status: "retryable";
      readonly evidenceDigest: RecursiveScopedSha256Digest;
    }
  | {
      readonly status: "blocked";
      readonly reason: "uncertain" | "invalid-evidence";
      readonly evidenceDigest?: RecursiveScopedSha256Digest;
    };
