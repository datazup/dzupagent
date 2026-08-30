import {
  RECURSIVE_SCOPED_COMMIT_SCHEMA_V1,
  RECURSIVE_SCOPED_MERGE_SCHEMA_V1,
  type RecursiveScopeContractIssue,
  type RecursiveScopeContractValidation,
  type RecursiveScopedCommitBindingV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedMergeV1,
  type RecursiveScopedMergeBindingV1,
} from "./types.js";
import {
  CANONICAL_JSON_VERSION,
  compareText,
  digest,
  exactKeys,
  issue,
  jsonValue,
  nonEmptyString,
  record,
  safeDigest,
  sameCanonical,
  sha256,
} from "./internals.js";
import { validateOwnerPathV1, validateRecursiveScopedOwnershipV1 } from "./frame.js";
import {
  validateCharges,
  validateEffects,
  validateIntentClaims,
} from "./evidence-validation.js";

export function recursiveScopedCommitBindingV1(
  commit: RecursiveScopedCommitV1,
): RecursiveScopedCommitBindingV1 {
  return {
    rootDefinitionDigest: commit.rootDefinitionDigest,
    ownerPath: commit.ownerPath,
    childScopeId: commit.childScopeId,
    childScopeIdentity: commit.childScopeIdentity,
    frameKind: commit.frameKind,
    ownership: commit.ownership,
    frameIdentity: commit.frameIdentity,
    parentCommitIdentity: commit.parentCommitIdentity,
  };
}

export function recursiveScopedMergeBindingV1(
  merge: RecursiveScopedMergeV1,
): RecursiveScopedMergeBindingV1 {
  return {
    rootDefinitionDigest: merge.rootDefinitionDigest,
    ownerPath: merge.ownerPath,
    parentCommitIdentity: merge.parentCommitIdentity,
    childCommitIdentities: merge.childCommitIdentities,
    childFrameIdentities: merge.childFrameIdentities,
  };
}

export function validateRecursiveScopedCommitV1(
  value: unknown,
): RecursiveScopeContractValidation<RecursiveScopedCommitV1> {
  const issues: RecursiveScopeContractIssue[] = [];
  if (!record(value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_TYPE", path: "$", message: "Commit must be an object." }],
    };
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "rootDefinitionDigest",
      "ownerPath",
      "childScopeId",
      "childScopeIdentity",
      "frameKind",
      "ownership",
      "frameIdentity",
      "parentCommitIdentity",
      "state",
      "results",
      "idempotencyKeys",
      "effects",
      "charges",
      "intentClaims",
      "commitIdentity",
    ],
    "$",
    issues,
  );
  if (value.schema !== RECURSIVE_SCOPED_COMMIT_SCHEMA_V1) {
    issue(issues, "$.schema", "UNKNOWN_VERSION", "Unsupported recursive scoped-commit version.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issue(issues, "$.canonicalization", "UNKNOWN_VERSION", "Unsupported canonical JSON version.");
  }
  if (!sha256(value.rootDefinitionDigest)) {
    issue(issues, "$.rootDefinitionDigest", "INVALID_VALUE", "Root definition digest must be SHA-256.");
  }
  validateOwnerPathV1(value.ownerPath, "$.ownerPath", issues);
  if (!nonEmptyString(value.childScopeId)) {
    issue(issues, "$.childScopeId", "INVALID_VALUE", "Child scope ID must be non-empty.");
  }
  if (!sha256(value.childScopeIdentity)) {
    issue(issues, "$.childScopeIdentity", "INVALID_VALUE", "Child scope identity must be SHA-256.");
  }
  validateRecursiveScopedOwnershipV1(value.ownership, value.frameKind, issues);
  for (const key of ["frameIdentity", "parentCommitIdentity"] as const) {
    if (!sha256(value[key])) {
      issue(issues, `$.${key}`, "INVALID_VALUE", `${key} must be SHA-256.`);
    }
  }
  validateJsonRecord(value.state, "$.state", issues);
  validateJsonRecord(value.results, "$.results", issues);
  validateStringRecord(value.idempotencyKeys, "$.idempotencyKeys", issues);
  const expectedOwner = sha256(value.frameIdentity)
    ? value.frameIdentity
    : undefined;
  validateEffects(value.effects, expectedOwner, issues);
  validateCharges(value.charges, expectedOwner, issues);
  validateIntentClaims(value.intentClaims, expectedOwner, issues);
  if (!sha256(value.commitIdentity)) {
    issue(issues, "$.commitIdentity", "INVALID_VALUE", "Commit identity must be SHA-256.");
  } else {
    const { commitIdentity, ...core } = value;
    try {
      if (commitIdentity !== digest(core)) {
        issue(issues, "$.commitIdentity", "DIGEST_MISMATCH", "Commit identity does not match canonical content.");
      }
    } catch {
      issue(issues, "$.commitIdentity", "DIGEST_MISMATCH", "Commit content cannot be canonically hashed.");
    }
  }
  return issues.length === 0
    ? { valid: true, value: value as unknown as RecursiveScopedCommitV1, issues: [] }
    : { valid: false, issues };
}

export function validateRecursiveScopedCommitBindingV1(
  commit: RecursiveScopedCommitV1,
  expected: RecursiveScopedCommitBindingV1,
): RecursiveScopeContractValidation<RecursiveScopedCommitV1> {
  const structural = validateRecursiveScopedCommitV1(commit);
  if (!structural.valid) return structural;
  const actual = recursiveScopedCommitBindingV1(structural.value);
  const issues: RecursiveScopeContractIssue[] = [];
  const bindingKeys: readonly (keyof RecursiveScopedCommitBindingV1)[] = [
    "rootDefinitionDigest",
    "ownerPath",
    "childScopeId",
    "childScopeIdentity",
    "frameKind",
    "ownership",
    "frameIdentity",
    "parentCommitIdentity",
  ];
  for (const key of bindingKeys) {
    if (!sameCanonical(actual[key], expected[key])) {
      issue(
        issues,
        `$.${key}`,
        "BINDING_MISMATCH",
        `${key} does not match the definition-owned commit binding.`,
      );
    }
  }
  return issues.length === 0
    ? { valid: true, value: structural.value, issues: [] }
    : { valid: false, issues };
}

export function validateRecursiveScopedMergeV1(
  value: unknown,
): RecursiveScopeContractValidation<RecursiveScopedMergeV1> {
  const issues: RecursiveScopeContractIssue[] = [];
  if (!record(value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_TYPE", path: "$", message: "Merge must be an object." }],
    };
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "rootDefinitionDigest",
      "ownerPath",
      "parentCommitIdentity",
      "childCommitIdentities",
      "childFrameIdentities",
      "state",
      "results",
      "idempotencyKeys",
      "effects",
      "charges",
      "intentClaims",
      "mergeIdentity",
    ],
    "$",
    issues,
  );
  if (value.schema !== RECURSIVE_SCOPED_MERGE_SCHEMA_V1) {
    issue(issues, "$.schema", "UNKNOWN_VERSION", "Unsupported recursive scoped-merge version.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issue(issues, "$.canonicalization", "UNKNOWN_VERSION", "Unsupported canonical JSON version.");
  }
  for (const key of ["rootDefinitionDigest", "parentCommitIdentity"] as const) {
    if (!sha256(value[key])) {
      issue(issues, `$.${key}`, "INVALID_VALUE", `${key} must be SHA-256.`);
    }
  }
  validateOwnerPathV1(value.ownerPath, "$.ownerPath", issues);
  validateDigestList(value.childCommitIdentities, "$.childCommitIdentities", issues);
  validateDigestList(value.childFrameIdentities, "$.childFrameIdentities", issues);
  if (
    Array.isArray(value.childCommitIdentities) &&
    Array.isArray(value.childFrameIdentities) &&
    value.childCommitIdentities.length !== value.childFrameIdentities.length
  ) {
    issue(issues, "$", "BINDING_MISMATCH", "Merge must bind one frame identity per child commit.");
  }
  const owners = new Set(
    Array.isArray(value.childFrameIdentities)
      ? value.childFrameIdentities.filter(sha256)
      : [],
  );
  validateJsonRecord(value.state, "$.state", issues);
  validateJsonRecord(value.results, "$.results", issues);
  validateStringRecord(value.idempotencyKeys, "$.idempotencyKeys", issues);
  validateEffects(value.effects, owners, issues);
  validateCharges(value.charges, owners, issues);
  validateIntentClaims(value.intentClaims, owners, issues);
  validateMergedEvidenceUniqueness(value.effects, value.charges, issues);
  if (!sha256(value.mergeIdentity)) {
    issue(issues, "$.mergeIdentity", "INVALID_VALUE", "Merge identity must be SHA-256.");
  } else {
    const { mergeIdentity, ...core } = value;
    if (mergeIdentity !== safeDigest(core)) {
      issue(issues, "$.mergeIdentity", "DIGEST_MISMATCH", "Merge identity does not match canonical content.");
    }
  }
  return issues.length === 0
    ? { valid: true, value: value as unknown as RecursiveScopedMergeV1, issues: [] }
    : { valid: false, issues };
}

export function validateRecursiveScopedMergeBindingV1(
  merge: RecursiveScopedMergeV1,
  expected: RecursiveScopedMergeBindingV1,
): RecursiveScopeContractValidation<RecursiveScopedMergeV1> {
  const structural = validateRecursiveScopedMergeV1(merge);
  if (!structural.valid) return structural;
  const actual = recursiveScopedMergeBindingV1(structural.value);
  const issues: RecursiveScopeContractIssue[] = [];
  const bindingKeys: readonly (keyof RecursiveScopedMergeBindingV1)[] = [
    "rootDefinitionDigest",
    "ownerPath",
    "parentCommitIdentity",
    "childCommitIdentities",
    "childFrameIdentities",
  ];
  for (const key of bindingKeys) {
    if (!sameCanonical(actual[key], expected[key])) {
      issue(
        issues,
        `$.${key}`,
        "BINDING_MISMATCH",
        `${key} does not match the definition-owned merge binding.`,
      );
    }
  }
  return issues.length === 0
    ? { valid: true, value: structural.value, issues: [] }
    : { valid: false, issues };
}

function validateJsonRecord(
  value: unknown,
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, path, "INVALID_TYPE", "Value must be an object.");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!nonEmptyString(key)) issue(issues, path, "INVALID_VALUE", "Record keys must be non-empty.");
    if (!jsonValue(entry)) issue(issues, `${path}.${key}`, "INVALID_TYPE", "Value must be finite, acyclic JSON.");
  }
}

function validateStringRecord(
  value: unknown,
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, path, "INVALID_TYPE", "Value must be an object.");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!nonEmptyString(key) || !nonEmptyString(entry)) {
      issue(issues, `${path}.${key}`, "INVALID_VALUE", "Idempotency keys and values must be non-empty.");
    }
  }
}

function validateDigestList(
  value: unknown,
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, path, "INVALID_VALUE", "Identity list must be a non-empty array.");
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!sha256(entry)) {
      issue(issues, `${path}[${index}]`, "INVALID_VALUE", "Identity must be SHA-256.");
    } else if (seen.has(entry)) {
      issue(issues, `${path}[${index}]`, "OWNERSHIP_CONFLICT", "Identity list must be unique.");
    } else {
      seen.add(entry);
    }
  });
  if (value.every(sha256) && !sameCanonical(value, [...value].sort(compareText))) {
    issue(issues, path, "INVALID_VALUE", "Identity list must be canonically sorted.");
  }
}

function validateMergedEvidenceUniqueness(
  effectsValue: unknown,
  chargesValue: unknown,
  issues: RecursiveScopeContractIssue[],
): void {
  const effectIdentities = new Set<string>();
  const effectKeys = new Set<string>();
  if (record(effectsValue)) {
    for (const [key, value] of Object.entries(effectsValue)) {
      if (!record(value)) continue;
      if (typeof value.effectIdentity === "string") {
        conflictSet(effectIdentities, value.effectIdentity, `$.effects.${key}.effectIdentity`, "Effect identity", issues);
      }
      if (typeof value.idempotencyKey === "string") {
        conflictSet(effectKeys, value.idempotencyKey, `$.effects.${key}.idempotencyKey`, "Effect idempotency key", issues);
      }
    }
  }
  const chargeIdentities = new Set<string>();
  const reservations = new Set<string>();
  if (record(chargesValue)) {
    for (const [key, value] of Object.entries(chargesValue)) {
      if (!record(value)) continue;
      if (typeof value.chargeIdentity === "string") {
        conflictSet(chargeIdentities, value.chargeIdentity, `$.charges.${key}.chargeIdentity`, "Charge identity", issues);
      }
      if (typeof value.reservationIdentity === "string") {
        conflictSet(reservations, value.reservationIdentity, `$.charges.${key}.reservationIdentity`, "Charge reservation", issues);
      }
    }
  }
}

export function conflictSet(
  values: Set<string>,
  value: string,
  path: string,
  label: string,
  issues: RecursiveScopeContractIssue[],
  code: "MERGE_CONFLICT" | "OWNERSHIP_CONFLICT" = "MERGE_CONFLICT",
): void {
  if (values.has(value)) {
    issue(issues, path, code, `${label} is owned by more than one sibling.`);
  }
  values.add(value);
}
