import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
} from "./idempotency.js";
import type { ExecutionLeafKind } from "./execution-leaf-kind.js";

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

const ACCESS_REASONS: readonly ExecutionStateAccessUnknownReasonV1[] = [
  "not-declared",
  "runtime-observation-unavailable",
  "observation-incomplete",
];
const EXECUTION_KINDS: readonly ExecutionLeafKind[] = [
  "prompt",
  "agent",
  "adapter.run",
  "worker.dispatch",
];

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

export function validateExecutionBoundaryEvidenceV1(
  value: unknown,
): ExecutionBoundaryValidation<ExecutionBoundaryEvidenceV1> {
  const issues: ExecutionBoundaryIssue[] = [];
  if (!record(value)) {
    return {
      valid: false,
      issues: [
        issue(
          "INVALID_TYPE",
          "$",
          "Execution-boundary evidence must be an object.",
        ),
      ],
    };
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "owner",
      "state",
      "adapterPolicy",
      "workspace",
      "boundaryDigest",
    ],
    "$",
    issues,
  );
  if (value.schema !== EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1) {
    issues.push(
      issue(
        "UNKNOWN_VERSION",
        "$.schema",
        "Unsupported execution-boundary evidence schema.",
      ),
    );
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issues.push(
      issue(
        "UNKNOWN_VERSION",
        "$.canonicalization",
        "Unsupported canonicalization version.",
      ),
    );
  }
  validateOwner(value.owner, "$.owner", issues);
  validateStateInventory(value.state, "$.state", issues);
  if (value.adapterPolicy !== undefined) {
    validateAdapterPolicy(value.adapterPolicy, "$.adapterPolicy", issues);
  }
  if (value.workspace !== undefined) {
    validateWorkspace(value.workspace, "$.workspace", issues);
  }

  if (record(value.owner) && record(value.state)) {
    compareCanonical(
      value.owner,
      value.state.owner,
      "$.state.owner",
      "State inventory owner must match the boundary owner.",
      issues,
    );
  }
  if (record(value.owner) && record(value.adapterPolicy)) {
    const target = record(value.adapterPolicy.target)
      ? value.adapterPolicy.target
      : undefined;
    if (
      target?.nodeId !== value.owner.nodeId ||
      target?.executionKind !== value.owner.executionKind
    ) {
      issues.push(
        issue(
          "BINDING_MISMATCH",
          "$.adapterPolicy.target",
          "Adapter policy target must match the boundary node.",
        ),
      );
    }
  }
  validateOwnDigest(value, "boundaryDigest", "$.boundaryDigest", issues);

  return issues.length === 0
    ? {
        valid: true,
        value: value as unknown as ExecutionBoundaryEvidenceV1,
        issues: [],
      }
    : { valid: false, issues };
}

/**
 * Strict pre-dispatch/restart admission. The caller supplies current host
 * authority; retained evidence never grants authority by itself.
 */
export function admitExecutionBoundaryEvidenceV1(
  value: unknown,
  expected: ExecutionBoundaryAdmissionExpectationV1,
): ExecutionBoundaryValidation<ExecutionBoundaryEvidenceV1> {
  const structural = validateExecutionBoundaryEvidenceV1(value);
  if (!structural.valid) return structural;
  const evidence = structural.value;
  const issues: ExecutionBoundaryIssue[] = [];

  compareCanonical(
    evidence.owner,
    expected.owner,
    "$.owner",
    "Execution definition or node ownership changed since compilation.",
    issues,
  );
  if (
    expected.stateInventoryDigest !== undefined &&
    evidence.state.inventoryDigest !== expected.stateInventoryDigest
  ) {
    issues.push(
      issue(
        "BINDING_MISMATCH",
        "$.state.inventoryDigest",
        "State-access inventory differs from current admission evidence.",
      ),
    );
  }
  if (
    expected.requireDeclaredExact === true &&
    evidence.state.declared.status !== "exact"
  ) {
    issues.push(
      issue(
        "REQUIRED_EVIDENCE_MISSING",
        "$.state.declared",
        "Strict admission requires exact declared state access.",
      ),
    );
  }
  if (
    expected.requireObservedExact === true &&
    evidence.state.observed.status !== "exact"
  ) {
    issues.push(
      issue(
        "REQUIRED_EVIDENCE_MISSING",
        "$.state.observed",
        "Strict admission requires exact observed state access.",
      ),
    );
  }

  compareAuthorizedRef(
    evidence.adapterPolicy,
    expected.adapterPolicy,
    expected.requireAdapterPolicy === true,
    "$.adapterPolicy",
    issues,
  );
  compareAuthorizedRef(
    evidence.workspace,
    expected.workspace,
    expected.requireWorkspace === true,
    "$.workspace",
    issues,
  );

  const admittedAt = isoInstant(expected.admittedAt)
    ? Date.parse(expected.admittedAt)
    : undefined;
  if (admittedAt === undefined) {
    issues.push(
      issue(
        "INVALID_VALUE",
        "$.admittedAt",
        "Admission time must be an ISO-8601 instant.",
      ),
    );
  } else if (evidence.adapterPolicy !== undefined) {
    if (
      evidence.adapterPolicy.effectiveAt !== undefined &&
      admittedAt < Date.parse(evidence.adapterPolicy.effectiveAt)
    ) {
      issues.push(
        issue(
          "POLICY_NOT_EFFECTIVE",
          "$.adapterPolicy.effectiveAt",
          "Adapter policy is not effective at admission time.",
        ),
      );
    }
    if (
      evidence.adapterPolicy.expiresAt !== undefined &&
      admittedAt >= Date.parse(evidence.adapterPolicy.expiresAt)
    ) {
      issues.push(
        issue(
          "POLICY_EXPIRED",
          "$.adapterPolicy.expiresAt",
          "Adapter policy is expired at admission time.",
        ),
      );
    }
  }

  return issues.length === 0
    ? { valid: true, value: evidence, issues: [] }
    : { valid: false, issues };
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

function validateStateInventory(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(issue("INVALID_TYPE", path, "State inventory must be an object."));
    return;
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "owner",
      "declared",
      "observed",
      "inventoryDigest",
    ],
    path,
    issues,
  );
  if (value.schema !== EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1) {
    issues.push(
      issue("UNKNOWN_VERSION", `${path}.schema`, "Unsupported state inventory schema."),
    );
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issues.push(
      issue(
        "UNKNOWN_VERSION",
        `${path}.canonicalization`,
        "Unsupported state inventory canonicalization.",
      ),
    );
  }
  validateOwner(value.owner, `${path}.owner`, issues);
  validateAccessSnapshot(value.declared, `${path}.declared`, issues);
  validateAccessSnapshot(value.observed, `${path}.observed`, issues);
  validateOwnDigest(value, "inventoryDigest", `${path}.inventoryDigest`, issues);
}

function validateAccessSnapshot(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(issue("INVALID_TYPE", path, "State access must be an object."));
    return;
  }
  if (value.status === "unknown") {
    exactKeys(value, ["status", "reason"], path, issues);
    if (!ACCESS_REASONS.includes(value.reason as ExecutionStateAccessUnknownReasonV1)) {
      issues.push(
        issue("INVALID_VALUE", `${path}.reason`, "Unknown state access needs a stable reason."),
      );
    }
    return;
  }
  if (value.status === "exact" || value.status === "incomplete") {
    exactKeys(
      value,
      value.status === "exact"
        ? ["status", "basisDigest", "reads", "writes"]
        : ["status", "reason", "basisDigest", "reads", "writes"],
      path,
      issues,
    );
    if (value.status === "exact" && !sha256(value.basisDigest)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}.basisDigest`,
          "Exact state access requires a SHA-256 basis digest.",
        ),
      );
    }
    if (
      value.status === "incomplete" &&
      !ACCESS_REASONS.includes(value.reason as ExecutionStateAccessUnknownReasonV1)
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}.reason`,
          "Incomplete state access needs a stable reason.",
        ),
      );
    }
    if (value.basisDigest !== undefined && !sha256(value.basisDigest)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}.basisDigest`,
          "State-access basis digest must be SHA-256.",
        ),
      );
    }
    validateSortedStateKeys(value.reads, `${path}.reads`, issues);
    validateSortedStateKeys(value.writes, `${path}.writes`, issues);
    return;
  }
  issues.push(
    issue(
      "INVALID_VALUE",
      `${path}.status`,
      "State access status must be exact, incomplete, or unknown.",
    ),
  );
}

function validateAdapterPolicy(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(
      issue("INVALID_TYPE", path, "Adapter-policy reference must be an object."),
    );
    return;
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "policyId",
      "authorityId",
      "revision",
      "policyDigest",
      "target",
      "effectiveAt",
      "expiresAt",
      "referenceDigest",
    ],
    path,
    issues,
  );
  if (value.schema !== ADAPTER_POLICY_REF_SCHEMA_V1) {
    issues.push(
      issue("UNKNOWN_VERSION", `${path}.schema`, "Unsupported adapter-policy reference schema."),
    );
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issues.push(
      issue(
        "UNKNOWN_VERSION",
        `${path}.canonicalization`,
        "Unsupported adapter-policy canonicalization.",
      ),
    );
  }
  for (const key of ["policyId", "authorityId", "revision"] as const) {
    if (!nonEmpty(value[key])) {
      issues.push(
        issue("INVALID_VALUE", `${path}.${key}`, `${key} must be non-empty.`),
      );
    }
  }
  if (!sha256(value.policyDigest)) {
    issues.push(
      issue("INVALID_VALUE", `${path}.policyDigest`, "Policy digest must be SHA-256."),
    );
  }
  validatePolicyTarget(value.target, `${path}.target`, issues);
  for (const key of ["effectiveAt", "expiresAt"] as const) {
    if (value[key] !== undefined && !isoInstant(value[key])) {
      issues.push(
        issue("INVALID_VALUE", `${path}.${key}`, `${key} must be an ISO-8601 instant.`),
      );
    }
  }
  if (
    isoInstant(value.effectiveAt) &&
    isoInstant(value.expiresAt) &&
    Date.parse(value.expiresAt) <= Date.parse(value.effectiveAt)
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}.expiresAt`,
        "Policy expiry must be later than its effective time.",
      ),
    );
  }
  validateOwnDigest(value, "referenceDigest", `${path}.referenceDigest`, issues);
}

function validatePolicyTarget(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(issue("INVALID_TYPE", path, "Policy target must be an object."));
    return;
  }
  exactKeys(value, ["executionKind", "nodeId"], path, issues);
  if (value.executionKind !== "adapter.run") {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}.executionKind`,
        "Adapter-policy target kind must be adapter.run.",
      ),
    );
  }
  if (!nonEmpty(value.nodeId)) {
    issues.push(
      issue("INVALID_VALUE", `${path}.nodeId`, "Policy target node ID must be non-empty."),
    );
  }
}

function validateWorkspace(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(issue("INVALID_TYPE", path, "Workspace reference must be an object."));
    return;
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "handleId",
      "authorityId",
      "revision",
      "scopeDigest",
      "referenceDigest",
    ],
    path,
    issues,
  );
  if (value.schema !== WORKSPACE_HANDLE_REF_SCHEMA_V1) {
    issues.push(
      issue("UNKNOWN_VERSION", `${path}.schema`, "Unsupported workspace reference schema."),
    );
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issues.push(
      issue(
        "UNKNOWN_VERSION",
        `${path}.canonicalization`,
        "Unsupported workspace reference canonicalization.",
      ),
    );
  }
  for (const key of ["handleId", "authorityId", "revision"] as const) {
    if (!nonEmpty(value[key])) {
      issues.push(
        issue("INVALID_VALUE", `${path}.${key}`, `${key} must be non-empty.`),
      );
    }
  }
  if (!sha256(value.scopeDigest)) {
    issues.push(
      issue("INVALID_VALUE", `${path}.scopeDigest`, "Workspace scope digest must be SHA-256."),
    );
  }
  validateOwnDigest(value, "referenceDigest", `${path}.referenceDigest`, issues);
}

function validateOwner(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!record(value)) {
    issues.push(issue("INVALID_TYPE", path, "Definition owner must be an object."));
    return;
  }
  exactKeys(
    value,
    [
      "rootDefinitionId",
      "rootDefinitionDigest",
      "scopedDefinitionId",
      "scopedDefinitionDigest",
      "executionKind",
      "nodeId",
      "nodePath",
    ],
    path,
    issues,
  );
  for (const key of [
    "rootDefinitionId",
    "scopedDefinitionId",
    "nodeId",
    "nodePath",
  ] as const) {
    if (!nonEmpty(value[key])) {
      issues.push(
        issue("INVALID_VALUE", `${path}.${key}`, `${key} must be non-empty.`),
      );
    }
  }
  if (!EXECUTION_KINDS.includes(value.executionKind as ExecutionLeafKind)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}.executionKind`,
        "Definition owner execution kind is unsupported.",
      ),
    );
  }
  for (const key of ["rootDefinitionDigest", "scopedDefinitionDigest"] as const) {
    if (!sha256(value[key])) {
      issues.push(
        issue("INVALID_VALUE", `${path}.${key}`, `${key} must be SHA-256.`),
      );
    }
  }
}

function compareAuthorizedRef(
  retained: AdapterPolicyRefV1 | WorkspaceHandleRefV1 | undefined,
  current: AdapterPolicyRefV1 | WorkspaceHandleRefV1 | undefined,
  required: boolean,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (retained === undefined) {
    if (required || current !== undefined) {
      issues.push(
        issue(
          "REQUIRED_EVIDENCE_MISSING",
          path,
          "Current strict admission requires this exact reference.",
        ),
      );
    }
    return;
  }
  if (current === undefined) {
    issues.push(
      issue(
        "AUTHORITY_MISMATCH",
        path,
        "Retained reference has no current host authority.",
      ),
    );
    return;
  }
  if (retained.referenceDigest !== current.referenceDigest) {
    issues.push(
      issue(
        "BINDING_MISMATCH",
        `${path}.referenceDigest`,
        "Retained reference differs from current host admission evidence.",
      ),
    );
  }
}

function validateSortedStateKeys(
  value: unknown,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_TYPE", path, "State keys must be an array."));
    return;
  }
  const keys = value.filter((item): item is string => typeof item === "string");
  if (keys.length !== value.length || keys.some((key) => !validStateKey(key))) {
    issues.push(
      issue("INVALID_VALUE", path, "State keys must be stable non-empty identifiers."),
    );
    return;
  }
  if (keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? ""))) {
    issues.push(
      issue("INVALID_VALUE", path, "State keys must be sorted and duplicate-free."),
    );
  }
}

function validateOwnDigest(
  value: Record<string, unknown>,
  digestKey: string,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  const actual = value[digestKey];
  if (!sha256(actual)) {
    issues.push(issue("INVALID_VALUE", path, "Identity must be a SHA-256 digest."));
    return;
  }
  try {
    const core = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== digestKey),
    );
    if (actual !== digest(core)) {
      issues.push(
        issue("DIGEST_MISMATCH", path, "Digest does not match canonical content."),
      );
    }
  } catch {
    issues.push(
      issue("DIGEST_MISMATCH", path, "Content cannot be canonically hashed."),
    );
  }
}

function compareCanonical(
  left: unknown,
  right: unknown,
  path: string,
  message: string,
  issues: ExecutionBoundaryIssue[],
): void {
  try {
    if (canonicalInputDigest(left) !== canonicalInputDigest(right)) {
      issues.push(issue("BINDING_MISMATCH", path, message));
    }
  } catch {
    issues.push(issue("BINDING_MISMATCH", path, message));
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push(
        issue("UNKNOWN_FIELD", `${path}.${key}`, "Field is outside the V1 schema."),
      );
    }
  }
}

function copyOwner(owner: ExecutionDefinitionOwnerV1): ExecutionDefinitionOwnerV1 {
  return { ...owner };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validStateKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: unknown): value is ExecutionBoundarySha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: unknown): ExecutionBoundarySha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

function issue(
  code: ExecutionBoundaryIssueCode,
  path: string,
  message: string,
): ExecutionBoundaryIssue {
  return { code, path, message };
}

function assertValid(
  prefix: string,
  issues: readonly ExecutionBoundaryIssue[],
): void {
  if (issues.length > 0) {
    throw new TypeError(
      `${prefix}: ${issues.map((item) => `${item.path} ${item.code}`).join(", ")}`,
    );
  }
}
