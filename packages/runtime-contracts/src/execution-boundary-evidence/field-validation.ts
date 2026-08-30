import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  EXECUTION_LEAF_KINDS,
  type ExecutionLeafKind,
} from "../execution-leaf-kind.js";
import {
  ACCESS_REASONS,
  exactKeys,
  isoInstant,
  issue,
  nonEmpty,
  record,
  sha256,
  validStateKey,
  validateOwnDigest,
} from "./internals.js";
import {
  ADAPTER_POLICY_REF_SCHEMA_V1,
  EXECUTION_STATE_ACCESS_INVENTORY_SCHEMA_V1,
  WORKSPACE_HANDLE_REF_SCHEMA_V1,
  type ExecutionBoundaryIssue,
  type ExecutionStateAccessUnknownReasonV1,
} from "./types.js";

export function validateStateInventory(
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

export function validateAdapterPolicy(
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

export function validateWorkspace(
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

export function validateOwner(
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
  if (!EXECUTION_LEAF_KINDS.includes(value.executionKind as ExecutionLeafKind)) {
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
