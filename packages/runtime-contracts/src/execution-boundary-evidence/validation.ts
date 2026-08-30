import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  validateAdapterPolicy,
  validateOwner,
  validateStateInventory,
  validateWorkspace,
} from "./field-validation.js";
import {
  compareCanonical,
  exactKeys,
  isoInstant,
  issue,
  record,
  validateOwnDigest,
} from "./internals.js";
import {
  EXECUTION_BOUNDARY_EVIDENCE_SCHEMA_V1,
  type AdapterPolicyRefV1,
  type ExecutionBoundaryAdmissionExpectationV1,
  type ExecutionBoundaryEvidenceV1,
  type ExecutionBoundaryIssue,
  type ExecutionBoundaryValidation,
  type WorkspaceHandleRefV1,
} from "./types.js";

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
