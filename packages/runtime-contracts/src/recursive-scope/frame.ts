import type {
  RecursiveScopeContractIssue,
  RecursiveScopeContractValidation,
  RecursiveScopedContinuationV1,
  RecursiveScopedDefinitionBindingV1,
  RecursiveScopedFrameBindingV1,
  RecursiveScopedFrameInputV1,
  RecursiveScopedFrameKindV1,
  RecursiveScopedFrameV1,
  RecursiveScopedOwnershipInputV1,
  RecursiveScopedOwnershipV1,
} from "./types.js";
import {
  CANONICAL_JSON_VERSION,
  digest,
  exactKeys,
  issue,
  jsonValue,
  nonEmptyString,
  nonNegativeInteger,
  record,
  safeDigest,
  sameCanonical,
  sha256,
} from "./internals.js";
import { RECURSIVE_SCOPED_FRAME_SCHEMA_V1 } from "./types.js";

const FRAME_KINDS: readonly RecursiveScopedFrameKindV1[] = [
  "branch",
  "fork-branch",
  "for-each-item",
];
const CONTINUATION_KINDS: readonly RecursiveScopedContinuationV1["kind"][] = [
  "node",
  "fork-join",
  "for-each-join",
];

function materializeOwnership(
  ownership: RecursiveScopedOwnershipInputV1,
): RecursiveScopedOwnershipV1 {
  return {
    ...ownership,
    ordinalIdentity: digest(ownership),
  } as RecursiveScopedOwnershipV1;
}

export function materializeRecursiveScopedFrameV1(
  input: RecursiveScopedFrameInputV1,
): RecursiveScopedFrameV1 {
  const nodeInventory = [...input.nodeInventory].sort();
  const ownership = materializeOwnership(input.ownership);
  const childScopeIdentity = digest({
    rootDefinitionDigest: input.definition.rootDefinitionDigest,
    scopedDefinitionDigest: input.definition.scopedDefinitionDigest,
    ownerPath: input.ownerPath,
    childScopeId: input.childScopeId,
    ordinalIdentity: ownership.ordinalIdentity,
  });
  const core = {
    schema: RECURSIVE_SCOPED_FRAME_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    frameKind: input.frameKind,
    definition: input.definition,
    ownerPath: [...input.ownerPath],
    childScopeId: input.childScopeId,
    childScopeIdentity,
    ownership,
    nodeInventory,
    nodeInventoryDigest: digest(nodeInventory),
    continuation: input.continuation,
    parentCommitIdentity: input.parentCommitIdentity,
    checkpoint: input.checkpoint,
  };
  const frame = { ...core, frameIdentity: digest(core) } as RecursiveScopedFrameV1;
  const validation = validateRecursiveScopedFrameV1(frame);
  if (!validation.valid) {
    throw new Error(formatIssues("Recursive scoped frame materialization failed", validation.issues));
  }
  return frame;
}

export function recursiveScopedFrameBindingV1(
  frame: RecursiveScopedFrameV1,
): RecursiveScopedFrameBindingV1 {
  return {
    frameKind: frame.frameKind,
    definition: frame.definition,
    ownerPath: frame.ownerPath,
    childScopeId: frame.childScopeId,
    childScopeIdentity: frame.childScopeIdentity,
    ownership: frame.ownership,
    nodeInventoryDigest: frame.nodeInventoryDigest,
    continuation: frame.continuation,
    parentCommitIdentity: frame.parentCommitIdentity,
  };
}

export function validateRecursiveScopedFrameV1(
  value: unknown,
): RecursiveScopeContractValidation<RecursiveScopedFrameV1> {
  const issues: RecursiveScopeContractIssue[] = [];
  if (!record(value)) return invalid("$", "Frame must be an object.");
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "frameKind",
      "definition",
      "ownerPath",
      "childScopeId",
      "childScopeIdentity",
      "ownership",
      "nodeInventory",
      "nodeInventoryDigest",
      "continuation",
      "parentCommitIdentity",
      "checkpoint",
      "frameIdentity",
    ],
    "$",
    issues,
  );
  if (value.schema !== RECURSIVE_SCOPED_FRAME_SCHEMA_V1) {
    issue(issues, "$.schema", "UNKNOWN_VERSION", "Unsupported recursive scoped-frame version.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issue(issues, "$.canonicalization", "UNKNOWN_VERSION", "Unsupported canonical JSON version.");
  }
  if (!FRAME_KINDS.includes(value.frameKind as RecursiveScopedFrameKindV1)) {
    issue(issues, "$.frameKind", "INVALID_VALUE", "Unknown recursive frame kind.");
  }
  validateDefinition(value.definition, issues);
  validateOwnerPathV1(value.ownerPath, "$.ownerPath", issues);
  if (!nonEmptyString(value.childScopeId)) {
    issue(issues, "$.childScopeId", "INVALID_VALUE", "Child scope ID must be non-empty.");
  }
  validateRecursiveScopedOwnershipV1(value.ownership, value.frameKind, issues);
  if (!sha256(value.childScopeIdentity)) {
    issue(issues, "$.childScopeIdentity", "INVALID_VALUE", "Child scope identity must be SHA-256.");
  } else if (record(value.definition) && record(value.ownership)) {
    const expectedScopeIdentity = safeDigest({
      rootDefinitionDigest: value.definition.rootDefinitionDigest,
      scopedDefinitionDigest: value.definition.scopedDefinitionDigest,
      ownerPath: value.ownerPath,
      childScopeId: value.childScopeId,
      ordinalIdentity: value.ownership.ordinalIdentity,
    });
    if (value.childScopeIdentity !== expectedScopeIdentity) {
      issue(issues, "$.childScopeIdentity", "DIGEST_MISMATCH", "Child scope identity does not match definition and ownership bindings.");
    }
  }
  validateInventory(value.nodeInventory, issues);
  if (!sha256(value.nodeInventoryDigest)) {
    issue(issues, "$.nodeInventoryDigest", "INVALID_VALUE", "Node inventory digest must be SHA-256.");
  } else if (Array.isArray(value.nodeInventory) && value.nodeInventoryDigest !== safeDigest(value.nodeInventory)) {
    issue(issues, "$.nodeInventoryDigest", "DIGEST_MISMATCH", "Node inventory digest does not match canonical inventory.");
  }
  validateContinuation(value.continuation, issues);
  if (!sha256(value.parentCommitIdentity)) {
    issue(issues, "$.parentCommitIdentity", "INVALID_VALUE", "Parent commit identity must be SHA-256.");
  }
  if (!record(value.checkpoint) || !jsonValue(value.checkpoint)) {
    issue(issues, "$.checkpoint", "INVALID_TYPE", "Checkpoint must be a finite, acyclic JSON object.");
  }
  if (!sha256(value.frameIdentity)) {
    issue(issues, "$.frameIdentity", "INVALID_VALUE", "Frame identity must be SHA-256.");
  } else {
    const { frameIdentity, ...core } = value;
    try {
      if (frameIdentity !== digest(core)) {
        issue(issues, "$.frameIdentity", "DIGEST_MISMATCH", "Frame identity does not match canonical content.");
      }
    } catch {
      issue(issues, "$.frameIdentity", "DIGEST_MISMATCH", "Frame content cannot be canonically hashed.");
    }
  }
  return finish(value, issues);
}

export function validateRecursiveScopedFrameBindingV1(
  frame: RecursiveScopedFrameV1,
  expected: RecursiveScopedFrameBindingV1,
): RecursiveScopeContractValidation<RecursiveScopedFrameV1> {
  const structural = validateRecursiveScopedFrameV1(frame);
  if (!structural.valid) return structural;
  const issues: RecursiveScopeContractIssue[] = [];
  const actual = recursiveScopedFrameBindingV1(structural.value);
  const bindingKeys: readonly (keyof RecursiveScopedFrameBindingV1)[] = [
    "frameKind",
    "definition",
    "ownerPath",
    "childScopeId",
    "childScopeIdentity",
    "ownership",
    "nodeInventoryDigest",
    "continuation",
    "parentCommitIdentity",
  ];
  for (const key of bindingKeys) {
    if (!sameCanonical(actual[key], expected[key])) {
      issue(
        issues,
        `$.${key}`,
        "BINDING_MISMATCH",
        `${key} does not match the definition-owned frame binding.`,
      );
    }
  }
  return issues.length === 0
    ? { valid: true, value: structural.value, issues: [] }
    : { valid: false, issues };
}

function validateDefinition(
  value: unknown,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, "$.definition", "INVALID_TYPE", "Definition binding must be an object.");
    return;
  }
  exactKeys(
    value,
    [
      "rootDefinitionId",
      "rootDefinitionDigest",
      "scopedDefinitionId",
      "scopedDefinitionDigest",
    ],
    "$.definition",
    issues,
  );
  for (const key of ["rootDefinitionId", "scopedDefinitionId"] as const) {
    if (!nonEmptyString(value[key])) {
      issue(issues, `$.definition.${key}`, "INVALID_VALUE", "Definition ID must be non-empty.");
    }
  }
  for (const key of ["rootDefinitionDigest", "scopedDefinitionDigest"] as const) {
    if (!sha256(value[key])) {
      issue(issues, `$.definition.${key}`, "INVALID_VALUE", "Definition digest must be SHA-256.");
    }
  }
}

export function validateOwnerPathV1(
  value: unknown,
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, path, "INVALID_VALUE", "Owner path must be a non-empty array.");
    return;
  }
  value.forEach((segment, index) => {
    if (!nonEmptyString(segment)) {
      issue(issues, `${path}[${index}]`, "INVALID_VALUE", "Owner path segment must be non-empty.");
    }
  });
}

export function validateRecursiveScopedOwnershipV1(
  value: unknown,
  frameKind: unknown,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, "$.ownership", "INVALID_TYPE", "Ownership must be an object.");
    return;
  }
  const kind = value.kind;
  if (kind !== frameKind) {
    issue(issues, "$.ownership.kind", "BINDING_MISMATCH", "Ownership kind must match frame kind.");
  }
  let coreKeys: readonly string[];
  if (kind === "branch") {
    coreKeys = ["kind", "branchNodeId", "branchOrdinal", "branchIdentity"];
    validateNodeAndOrdinal(value, "branchNodeId", "branchOrdinal", issues);
    if (!nonEmptyString(value.branchIdentity)) {
      issue(issues, "$.ownership.branchIdentity", "INVALID_VALUE", "Branch identity must be non-empty.");
    }
  } else if (kind === "fork-branch") {
    coreKeys = ["kind", "forkNodeId", "branchOrdinal", "branchIdentity"];
    validateNodeAndOrdinal(value, "forkNodeId", "branchOrdinal", issues);
    if (!nonEmptyString(value.branchIdentity)) {
      issue(issues, "$.ownership.branchIdentity", "INVALID_VALUE", "Branch identity must be non-empty.");
    }
  } else if (kind === "for-each-item") {
    coreKeys = ["kind", "forEachNodeId", "itemOrdinal", "itemIdentity"];
    validateNodeAndOrdinal(value, "forEachNodeId", "itemOrdinal", issues);
    if (!sha256(value.itemIdentity)) {
      issue(issues, "$.ownership.itemIdentity", "INVALID_VALUE", "Item identity must be SHA-256.");
    }
  } else {
    issue(issues, "$.ownership.kind", "INVALID_VALUE", "Unknown ownership kind.");
    return;
  }
  exactKeys(value, [...coreKeys, "ordinalIdentity"], "$.ownership", issues);
  if (!sha256(value.ordinalIdentity)) {
    issue(issues, "$.ownership.ordinalIdentity", "INVALID_VALUE", "Ordinal identity must be SHA-256.");
  } else {
    const { ordinalIdentity, ...core } = value;
    if (ordinalIdentity !== safeDigest(core)) {
      issue(issues, "$.ownership.ordinalIdentity", "DIGEST_MISMATCH", "Ordinal identity does not match ownership fields.");
    }
  }
}

function validateNodeAndOrdinal(
  value: Record<string, unknown>,
  nodeKey: string,
  ordinalKey: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!nonEmptyString(value[nodeKey])) {
    issue(issues, `$.ownership.${nodeKey}`, "INVALID_VALUE", "Owner node ID must be non-empty.");
  }
  if (!nonNegativeInteger(value[ordinalKey])) {
    issue(issues, `$.ownership.${ordinalKey}`, "INVALID_VALUE", "Owner ordinal must be a non-negative integer.");
  }
}

function validateInventory(
  value: unknown,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, "$.nodeInventory", "INVALID_VALUE", "Node inventory must be a non-empty array.");
    return;
  }
  const seen = new Set<string>();
  value.forEach((nodeId, index) => {
    if (!nonEmptyString(nodeId)) {
      issue(issues, `$.nodeInventory[${index}]`, "INVALID_VALUE", "Node ID must be non-empty.");
      return;
    }
    if (seen.has(nodeId)) {
      issue(issues, `$.nodeInventory[${index}]`, "INVALID_VALUE", "Node inventory must be unique.");
    }
    seen.add(nodeId);
  });
  if (value.every(nonEmptyString) && !sameCanonical(value, [...value].sort())) {
    issue(issues, "$.nodeInventory", "INVALID_VALUE", "Node inventory must be canonically sorted.");
  }
}

function validateContinuation(
  value: unknown,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, "$.continuation", "INVALID_TYPE", "Continuation must be an object.");
    return;
  }
  exactKeys(value, ["kind", "nodeId", "edgeOrdinal"], "$.continuation", issues);
  if (!CONTINUATION_KINDS.includes(value.kind as RecursiveScopedContinuationV1["kind"])) {
    issue(issues, "$.continuation.kind", "INVALID_VALUE", "Unknown continuation kind.");
  }
  if (!nonEmptyString(value.nodeId)) {
    issue(issues, "$.continuation.nodeId", "INVALID_VALUE", "Continuation node ID must be non-empty.");
  }
  if (!nonNegativeInteger(value.edgeOrdinal)) {
    issue(issues, "$.continuation.edgeOrdinal", "INVALID_VALUE", "Continuation edge ordinal must be non-negative.");
  }
}

function invalid(
  path: string,
  message: string,
): RecursiveScopeContractValidation<RecursiveScopedFrameV1> {
  return { valid: false, issues: [{ code: "INVALID_TYPE", path, message }] };
}

function finish(
  value: Record<string, unknown>,
  issues: RecursiveScopeContractIssue[],
): RecursiveScopeContractValidation<RecursiveScopedFrameV1> {
  return issues.length === 0
    ? { valid: true, value: value as unknown as RecursiveScopedFrameV1, issues: [] }
    : { valid: false, issues };
}

export function formatIssues(
  prefix: string,
  issues: readonly RecursiveScopeContractIssue[],
): string {
  return `${prefix}: ${issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`;
}

export type {
  RecursiveScopedDefinitionBindingV1,
  RecursiveScopedFrameBindingV1,
};
