import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  validateAdapterPolicy,
  validateStateInventory,
  validateWorkspace,
} from "../execution-boundary-evidence/field-validation.js";
import {
  assertValid,
  copyOwner,
  digest,
  sortedUnique,
} from "../execution-boundary-evidence/internals.js";
import {
  ADAPTER_POLICY_REF_SCHEMA_V1,
  EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1,
  EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1,
  WORKSPACE_HANDLE_REF_SCHEMA_V1,
  type AdapterPolicyRefInputV1,
  type AdapterPolicyRefV1,
  type ExecutionBoundaryEvidenceInputV1,
  type ExecutionBoundaryEvidenceV1,
  type ExecutionBoundaryIssue,
  type ExecutionBoundarySha256Digest,
  type ExecutionStateAccessInventoryInputV1,
  type ExecutionStateAccessInventoryV1,
  type ExecutionStateAccessSnapshotInputV1,
  type ExecutionStateAccessSnapshotV1,
  type WorkspaceHandleRefInputV1,
  type WorkspaceHandleRefV1,
} from "../execution-boundary-evidence/types.js";
import { validateExecutionBoundaryEvidenceV1 } from "../execution-boundary-evidence/validation.js";

export function materializeExecutionStateAccessInventoryV1(
  input: ExecutionStateAccessInventoryInputV1,
): ExecutionStateAccessInventoryV1 {
  const core = {
    schema: EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: copyOwner(input.owner),
    declared: normalizeAccessSnapshot(input.declared),
    observed: normalizeAccessSnapshot(input.observed),
  };
  const value: ExecutionStateAccessInventoryV1 = {
    ...core,
    inventoryDigest: digest(core),
  };
  const issues: ExecutionBoundaryIssue[] = [];
  validateStateInventory(value, "$.state", issues);
  assertValid("State-access inventory materialization failed", issues);
  return value;
}

export function materializeAdapterPolicyRefV1(
  input: AdapterPolicyRefInputV1,
): AdapterPolicyRefV1 {
  const core = {
    schema: ADAPTER_POLICY_REF_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    policyId: input.policyId,
    authorityId: input.authorityId,
    revision: input.revision,
    policyDigest: input.policyDigest,
    target: { ...input.target },
    ...(input.effectiveAt === undefined
      ? {}
      : { effectiveAt: input.effectiveAt }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
  const value: AdapterPolicyRefV1 = {
    ...core,
    referenceDigest: digest(core),
  };
  const issues: ExecutionBoundaryIssue[] = [];
  validateAdapterPolicy(value, "$.adapterPolicy", issues);
  assertValid("Adapter-policy reference materialization failed", issues);
  return value;
}

export function materializeWorkspaceHandleRefV1(
  input: WorkspaceHandleRefInputV1,
): WorkspaceHandleRefV1 {
  const core = {
    schema: WORKSPACE_HANDLE_REF_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    handleId: input.handleId,
    authorityId: input.authorityId,
    revision: input.revision,
    scopeDigest: input.scopeDigest,
  };
  const value: WorkspaceHandleRefV1 = {
    ...core,
    referenceDigest: digest(core),
  };
  const issues: ExecutionBoundaryIssue[] = [];
  validateWorkspace(value, "$.workspace", issues);
  assertValid("Workspace-handle reference materialization failed", issues);
  return value;
}

export function materializeExecutionBoundaryEvidenceV1(
  input: ExecutionBoundaryEvidenceInputV1,
): ExecutionBoundaryEvidenceV1 {
  const core = {
    schema: EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: copyOwner(input.owner),
    state: input.state,
    ...(input.adapterPolicy === undefined
      ? {}
      : { adapterPolicy: input.adapterPolicy }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  };
  const value: ExecutionBoundaryEvidenceV1 = {
    ...core,
    boundaryDigest: digest(core),
  };
  const validation = validateExecutionBoundaryEvidenceV1(value);
  assertValid(
    "Execution-boundary evidence materialization failed",
    validation.valid ? [] : validation.issues,
  );
  return value;
}

function normalizeAccessSnapshot(
  input: ExecutionStateAccessSnapshotInputV1,
): ExecutionStateAccessSnapshotV1 {
  if (input.status === "unknown") {
    return {
      status: "unknown",
      reason: input.reason ?? "runtime-observation-unavailable",
    };
  }
  const reads = sortedUnique(input.reads ?? []);
  const writes = sortedUnique(input.writes ?? []);
  if (input.status === "exact") {
    return {
      status: "exact",
      basisDigest: input.basisDigest as ExecutionBoundarySha256Digest,
      reads,
      writes,
    };
  }
  return {
    status: "incomplete",
    reason: input.reason ?? "observation-incomplete",
    ...(input.basisDigest === undefined
      ? {}
      : { basisDigest: input.basisDigest }),
    reads,
    writes,
  };
}
