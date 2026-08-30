import type { CANONICAL_JSON_VERSION } from "../idempotency.js";
import type { ExecutionLeafKind } from "../execution-leaf-kind.js";

export const EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1 =
  "dzupagent.executionStateAccessInventory/v1" as const;
export const ADAPTER_POLICY_REF_SCHEMA_V1 =
  "dzupagent.adapterPolicyRef/v1" as const;
export const WORKSPACE_HANDLE_REF_SCHEMA_V1 =
  "dzupagent.workspaceHandleRef/v1" as const;
export const EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1 =
  "dzupagent.executionBoundaryEvidence/v1" as const;

export type ExecutionBoundarySha256Digest = `sha256:${string}`;

/** Definition-owned identity shared by compiler, host admission, and restart. */
export interface ExecutionDefinitionOwnerV1 {
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: ExecutionBoundarySha256Digest;
  readonly scopedDefinitionId: string;
  readonly scopedDefinitionDigest: ExecutionBoundarySha256Digest;
  readonly executionKind: ExecutionLeafKind;
  readonly nodeId: string;
  readonly nodePath: string;
}

export type ExecutionDefinitionBindingV1 = Pick<
  ExecutionDefinitionOwnerV1,
  | "rootDefinitionId"
  | "rootDefinitionDigest"
  | "scopedDefinitionId"
  | "scopedDefinitionDigest"
>;

export type ExecutionStateAccessUnknownReasonV1 =
  | "not-declared"
  | "runtime-observation-unavailable"
  | "observation-incomplete";

export type ExecutionStateAccessSnapshotV1 =
  | {
      readonly status: "exact";
      /** Digest of the compiler source or runtime observation that proves exactness. */
      readonly basisDigest: ExecutionBoundarySha256Digest;
      readonly reads: readonly string[];
      readonly writes: readonly string[];
    }
  | {
      readonly status: "incomplete";
      readonly reason: ExecutionStateAccessUnknownReasonV1;
      readonly basisDigest?: ExecutionBoundarySha256Digest;
      readonly reads: readonly string[];
      readonly writes: readonly string[];
    }
  | {
      readonly status: "unknown";
      readonly reason: ExecutionStateAccessUnknownReasonV1;
    };

export interface ExecutionStateAccessSnapshotInputV1 {
  readonly status: "exact" | "incomplete" | "unknown";
  readonly basisDigest?: ExecutionBoundarySha256Digest;
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly reason?: ExecutionStateAccessUnknownReasonV1;
}

export interface ExecutionStateAccessInventoryV1 {
  readonly schema: typeof EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly owner: ExecutionDefinitionOwnerV1;
  readonly declared: ExecutionStateAccessSnapshotV1;
  readonly observed: ExecutionStateAccessSnapshotV1;
  readonly inventoryDigest: ExecutionBoundarySha256Digest;
}

export interface ExecutionStateAccessInventoryInputV1 {
  readonly owner: ExecutionDefinitionOwnerV1;
  readonly declared: ExecutionStateAccessSnapshotInputV1;
  readonly observed: ExecutionStateAccessSnapshotInputV1;
}

export interface AdapterPolicyTargetV1 {
  readonly executionKind: "adapter.run";
  readonly nodeId: string;
}

/** Persistable identity of host-owned adapter policy contents. */
export interface AdapterPolicyRefV1 {
  readonly schema: typeof ADAPTER_POLICY_REF_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly policyId: string;
  readonly authorityId: string;
  readonly revision: string;
  readonly policyDigest: ExecutionBoundarySha256Digest;
  readonly target: AdapterPolicyTargetV1;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
  readonly referenceDigest: ExecutionBoundarySha256Digest;
}

export type AdapterPolicyRefInputV1 = Omit<
  AdapterPolicyRefV1,
  "schema" | "canonicalization" | "referenceDigest"
>;

/** Opaque host reference. No filesystem path or repository locator is retained. */
export interface WorkspaceHandleRefV1 {
  readonly schema: typeof WORKSPACE_HANDLE_REF_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly handleId: string;
  readonly authorityId: string;
  readonly revision: string;
  /** Digest of host-owned scope, not the scope name or resolved path. */
  readonly scopeDigest: ExecutionBoundarySha256Digest;
  readonly referenceDigest: ExecutionBoundarySha256Digest;
}

export type WorkspaceHandleRefInputV1 = Omit<
  WorkspaceHandleRefV1,
  "schema" | "canonicalization" | "referenceDigest"
>;

/** One restart-comparable boundary record attached to a canonical request. */
export interface ExecutionBoundaryEvidenceV1 {
  readonly schema: typeof EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly owner: ExecutionDefinitionOwnerV1;
  readonly state: ExecutionStateAccessInventoryV1;
  readonly adapterPolicy?: AdapterPolicyRefV1;
  readonly workspace?: WorkspaceHandleRefV1;
  readonly boundaryDigest: ExecutionBoundarySha256Digest;
}

export interface ExecutionBoundaryEvidenceInputV1 {
  readonly owner: ExecutionDefinitionOwnerV1;
  readonly state: ExecutionStateAccessInventoryV1;
  readonly adapterPolicy?: AdapterPolicyRefV1;
  readonly workspace?: WorkspaceHandleRefV1;
}

export type ExecutionBoundaryIssueCode =
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_VERSION"
  | "DIGEST_MISMATCH"
  | "BINDING_MISMATCH"
  | "AUTHORITY_MISMATCH"
  | "POLICY_NOT_EFFECTIVE"
  | "POLICY_EXPIRED"
  | "REQUIRED_EVIDENCE_MISSING";

export interface ExecutionBoundaryIssue {
  readonly code: ExecutionBoundaryIssueCode;
  readonly path: string;
  readonly message: string;
}

export type ExecutionBoundaryValidation<T> =
  | { readonly valid: true; readonly value: T; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly ExecutionBoundaryIssue[];
    };

export interface ExecutionBoundaryAdmissionExpectationV1 {
  readonly owner: ExecutionDefinitionOwnerV1;
  readonly stateInventoryDigest?: ExecutionBoundarySha256Digest;
  /** Current host-authorized policy ref. Absence never authorizes a retained ref. */
  readonly adapterPolicy?: AdapterPolicyRefV1;
  /** Current host-authorized workspace ref. Absence never authorizes a retained ref. */
  readonly workspace?: WorkspaceHandleRefV1;
  readonly admittedAt: string;
  readonly requireDeclaredExact?: boolean;
  readonly requireObservedExact?: boolean;
  readonly requireAdapterPolicy?: boolean;
  readonly requireWorkspace?: boolean;
}
