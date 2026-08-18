import {
  RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1,
  RECURSIVE_SCOPED_COMMIT_SCHEMA_V1,
  RECURSIVE_SCOPED_MERGE_SCHEMA_V1,
  type RecursiveAcknowledgementBoundaryV1,
  type RecursiveAcknowledgementEvidenceInputV1,
  type RecursiveAcknowledgementEvidenceV1,
  type RecursiveAcknowledgementResolutionV1,
  type RecursiveChargeCommitEvidenceV1,
  type RecursiveChargeCommitInputV1,
  type RecursiveEffectCommitEvidenceV1,
  type RecursiveEffectCommitInputV1,
  type RecursiveIntentClaimInputV1,
  type RecursiveIntentClaimV1,
  type RecursiveScopeContractIssue,
  type RecursiveScopeContractValidation,
  type RecursiveScopedCommitBindingV1,
  type RecursiveScopedCommitInputV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedJsonValue,
  type RecursiveScopedMergeV1,
  type RecursiveScopedMergeBindingV1,
  type RecursiveScopedSha256Digest,
} from "./types.js";
import {
  CANONICAL_JSON_VERSION,
  compareText,
  digest,
  exactKeys,
  isoInstant,
  issue,
  jsonValue,
  nonEmptyString,
  nonNegativeInteger,
  record,
  safeDigest,
  sameCanonical,
  sha256,
  sortedRecord,
} from "./internals.js";
import {
  formatIssues,
  validateOwnerPathV1,
  validateRecursiveScopedFrameV1,
  validateRecursiveScopedOwnershipV1,
} from "./frame.js";

const INTENT_KINDS = [
  "interaction",
  "suspension",
  "terminal",
  "error",
] as const;

export class RecursiveScopedCommitConflictError extends Error {
  readonly issues: readonly RecursiveScopeContractIssue[];

  constructor(issues: readonly RecursiveScopeContractIssue[]) {
    super(formatIssues("Recursive scoped commit merge failed", issues));
    this.name = "RecursiveScopedCommitConflictError";
    this.issues = issues;
  }
}

export function materializeRecursiveScopedCommitV1(
  input: RecursiveScopedCommitInputV1,
): RecursiveScopedCommitV1 {
  const frameValidation = validateRecursiveScopedFrameV1(input.frame);
  if (!frameValidation.valid) {
    throw new Error(
      formatIssues(
        "Recursive scoped commit materialization received an invalid frame",
        frameValidation.issues,
      ),
    );
  }
  const frame = frameValidation.value;
  const state = sortedRecord(input.state);
  const results = sortedRecord(input.results);
  const idempotencyKeys = sortedRecord(input.idempotencyKeys);
  const effects = materializeEffects(input.effects, frame.frameIdentity);
  const charges = materializeCharges(input.charges, frame.frameIdentity);
  const intentClaims = (input.intentClaims ?? [])
    .map((claim) => materializeIntentClaim(claim, frame.frameIdentity))
    .sort(compareIntentClaims);
  const core = {
    schema: RECURSIVE_SCOPED_COMMIT_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    rootDefinitionDigest: frame.definition.rootDefinitionDigest,
    ownerPath: [...frame.ownerPath],
    childScopeId: frame.childScopeId,
    childScopeIdentity: frame.childScopeIdentity,
    frameKind: frame.frameKind,
    ownership: frame.ownership,
    frameIdentity: frame.frameIdentity,
    parentCommitIdentity: frame.parentCommitIdentity,
    state,
    results,
    idempotencyKeys,
    effects,
    charges,
    intentClaims,
  };
  const commit = { ...core, commitIdentity: digest(core) } as RecursiveScopedCommitV1;
  const validation = validateRecursiveScopedCommitV1(commit);
  if (!validation.valid) {
    throw new Error(
      formatIssues("Recursive scoped commit materialization failed", validation.issues),
    );
  }
  return commit;
}

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

export function resolveRecursiveAcknowledgementLossV1(
  value: unknown,
): RecursiveAcknowledgementResolutionV1 {
  const validation = validateRecursiveAcknowledgementEvidenceV1(value);
  if (!validation.valid) {
    return { status: "blocked", reason: "invalid-evidence" };
  }
  const evidence = validation.value;
  if (evidence.status === "committed" && evidence.observation.kind === "durable-commit") {
    return {
      status: "committed",
      committedIdentity: evidence.observation.committedIdentity,
      evidenceDigest: evidence.observation.evidenceDigest,
    };
  }
  if (evidence.status === "retryable" && evidence.observation.kind === "confirmed-absent") {
    return { status: "retryable", evidenceDigest: evidence.observation.evidenceDigest };
  }
  return {
    status: "blocked",
    reason: "uncertain",
    evidenceDigest: evidence.observation.evidenceDigest,
  };
}

export function validateRecursiveAcknowledgementEvidenceV1(
  value: unknown,
): RecursiveScopeContractValidation<RecursiveAcknowledgementEvidenceV1> {
  const issues: RecursiveScopeContractIssue[] = [];
  if (!record(value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_TYPE", path: "$", message: "Acknowledgement evidence must be an object." }],
    };
  }
  validateAcknowledgement(value, "$", undefined, undefined, issues);
  return issues.length === 0
    ? { valid: true, value: value as unknown as RecursiveAcknowledgementEvidenceV1, issues: [] }
    : { valid: false, issues };
}

export function mergeRecursiveScopedCommitsV1(
  values: readonly RecursiveScopedCommitV1[],
): RecursiveScopedMergeV1 {
  if (values.length === 0) {
    throw new RecursiveScopedCommitConflictError([
      {
        code: "MERGE_CONFLICT",
        path: "$",
        message: "At least one child commit is required.",
      },
    ]);
  }
  const commits = values.map((value, index) => {
    const validation = validateRecursiveScopedCommitV1(value);
    if (!validation.valid) {
      throw new RecursiveScopedCommitConflictError(
        validation.issues.map((entry) => ({
          ...entry,
          path: `$[${index}]${entry.path === "$" ? "" : entry.path.slice(1)}`,
        })),
      );
    }
    return validation.value;
  }).sort((left, right) => compareText(left.commitIdentity, right.commitIdentity));

  const base = commits[0]!;
  const issues: RecursiveScopeContractIssue[] = [];
  const childScopeIds = new Set<string>();
  const childScopes = new Set<string>();
  const ownerships = new Set<string>();
  const commitIdentities = new Set<string>();
  const frameIdentities = new Set<string>();
  const effectIdentities = new Set<string>();
  const effectIdempotencyKeys = new Set<string>();
  const chargeIdentities = new Set<string>();
  const reservationIdentities = new Set<string>();
  const intentOwners = new Set<string>();
  let terminalClaim: RecursiveIntentClaimV1 | undefined;
  const state = Object.create(null) as Record<string, RecursiveScopedJsonValue>;
  const results = Object.create(null) as Record<string, RecursiveScopedJsonValue>;
  const idempotencyKeys = Object.create(null) as Record<string, string>;
  const effects = Object.create(null) as Record<string, RecursiveEffectCommitEvidenceV1>;
  const charges = Object.create(null) as Record<string, RecursiveChargeCommitEvidenceV1>;
  const intentClaims: RecursiveIntentClaimV1[] = [];

  commits.forEach((commit, index) => {
    const path = `$[${index}]`;
    for (const key of ["rootDefinitionDigest", "ownerPath", "parentCommitIdentity"] as const) {
      if (!sameCanonical(commit[key], base[key])) {
        issue(issues, `${path}.${key}`, "BINDING_MISMATCH", `Sibling ${key} does not match the merge parent.`);
      }
    }
    conflictSet(childScopeIds, commit.childScopeId, `${path}.childScopeId`, "Child scope ID", issues);
    conflictSet(childScopes, commit.childScopeIdentity, `${path}.childScopeIdentity`, "Child scope identity", issues);
    conflictSet(ownerships, commit.ownership.ordinalIdentity, `${path}.ownership.ordinalIdentity`, "Ordinal ownership", issues);
    conflictSet(commitIdentities, commit.commitIdentity, `${path}.commitIdentity`, "Commit identity", issues);
    conflictSet(frameIdentities, commit.frameIdentity, `${path}.frameIdentity`, "Frame identity", issues);
    mergeRecord(state, commit.state, `${path}.state`, "state", issues);
    mergeRecord(results, commit.results, `${path}.results`, "result", issues);
    mergeRecord(idempotencyKeys, commit.idempotencyKeys, `${path}.idempotencyKeys`, "idempotency", issues);
    mergeRecord(effects, commit.effects, `${path}.effects`, "effect", issues);
    mergeRecord(charges, commit.charges, `${path}.charges`, "charge", issues);

    for (const [key, evidence] of Object.entries(commit.effects)) {
      conflictSet(effectIdentities, evidence.effectIdentity, `${path}.effects.${key}.effectIdentity`, "Effect identity", issues);
      conflictSet(effectIdempotencyKeys, evidence.idempotencyKey, `${path}.effects.${key}.idempotencyKey`, "Effect idempotency key", issues);
    }
    for (const [key, evidence] of Object.entries(commit.charges)) {
      conflictSet(chargeIdentities, evidence.chargeIdentity, `${path}.charges.${key}.chargeIdentity`, "Charge identity", issues);
      conflictSet(reservationIdentities, evidence.reservationIdentity, `${path}.charges.${key}.reservationIdentity`, "Charge reservation", issues);
    }
    for (const claim of commit.intentClaims) {
      const ownerKey = `${claim.kind}:${claim.intentKey}`;
      conflictSet(intentOwners, ownerKey, `${path}.intentClaims`, "Intent ownership", issues, "OWNERSHIP_CONFLICT");
      if (claim.kind === "terminal") {
        if (terminalClaim !== undefined) {
          issue(
            issues,
            `${path}.intentClaims`,
            "OWNERSHIP_CONFLICT",
            `Terminal ownership is already held by ${terminalClaim.ownerFrameIdentity}.`,
          );
        } else {
          terminalClaim = claim;
        }
      }
      intentClaims.push(claim);
    }
  });

  if (issues.length > 0) throw new RecursiveScopedCommitConflictError(issues);
  intentClaims.sort(compareIntentClaims);
  const core = {
    schema: RECURSIVE_SCOPED_MERGE_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    rootDefinitionDigest: base.rootDefinitionDigest,
    ownerPath: [...base.ownerPath],
    parentCommitIdentity: base.parentCommitIdentity,
    childCommitIdentities: commits.map(({ commitIdentity }) => commitIdentity),
    childFrameIdentities: commits
      .map(({ frameIdentity }) => frameIdentity)
      .sort(compareText),
    state: sortedRecord(state),
    results: sortedRecord(results),
    idempotencyKeys: sortedRecord(idempotencyKeys),
    effects: sortedRecord(effects),
    charges: sortedRecord(charges),
    intentClaims,
  };
  const merge = { ...core, mergeIdentity: digest(core) } as RecursiveScopedMergeV1;
  const validation = validateRecursiveScopedMergeV1(merge);
  if (!validation.valid) {
    throw new RecursiveScopedCommitConflictError(validation.issues);
  }
  return merge;
}

function materializeIntentClaim(
  input: RecursiveIntentClaimInputV1,
  ownerFrameIdentity: RecursiveScopedSha256Digest,
): RecursiveIntentClaimV1 {
  const core = { ...input, ownerFrameIdentity };
  return { ...core, claimIdentity: digest(core) };
}

function materializeEffects(
  input: Readonly<Record<string, RecursiveEffectCommitInputV1>> | undefined,
  ownerFrameIdentity: RecursiveScopedSha256Digest,
): Readonly<Record<string, RecursiveEffectCommitEvidenceV1>> {
  return sortedRecord(Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => {
    const identityCore = {
      kind: "effect",
      idempotencyKey: value.idempotencyKey,
      intentDigest: value.intentDigest,
    };
    const effectIdentity = digest(identityCore);
    const acknowledgement = materializeAcknowledgement(
      "effect",
      effectIdentity,
      ownerFrameIdentity,
      value.acknowledgement,
    );
    const core = {
      effectIdentity,
      idempotencyKey: value.idempotencyKey,
      intentDigest: value.intentDigest,
      acknowledgement,
    };
    return [key, { ...core, effectCommitIdentity: digest(core) }];
  })));
}

function materializeCharges(
  input: Readonly<Record<string, RecursiveChargeCommitInputV1>> | undefined,
  ownerFrameIdentity: RecursiveScopedSha256Digest,
): Readonly<Record<string, RecursiveChargeCommitEvidenceV1>> {
  return sortedRecord(Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => {
    const identityCore = {
      kind: "charge",
      reservationIdentity: value.reservationIdentity,
      measurementDigest: value.measurementDigest,
      settledCostMicros: value.settledCostMicros,
      currency: value.currency,
    };
    const chargeIdentity = digest(identityCore);
    const acknowledgement = materializeAcknowledgement(
      "charge",
      chargeIdentity,
      ownerFrameIdentity,
      value.acknowledgement,
    );
    const core = {
      chargeIdentity,
      reservationIdentity: value.reservationIdentity,
      measurementDigest: value.measurementDigest,
      settledCostMicros: value.settledCostMicros,
      currency: value.currency,
      acknowledgement,
    };
    return [key, { ...core, chargeCommitIdentity: digest(core) }];
  })));
}

function materializeAcknowledgement(
  boundary: RecursiveAcknowledgementBoundaryV1,
  operationIdentity: RecursiveScopedSha256Digest,
  ownerFrameIdentity: RecursiveScopedSha256Digest,
  input: RecursiveAcknowledgementEvidenceInputV1,
): RecursiveAcknowledgementEvidenceV1 {
  const core = {
    schema: RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1,
    canonicalization: CANONICAL_JSON_VERSION,
    boundary,
    operationIdentity,
    ownerFrameIdentity,
    ...input,
  };
  const evidence = { ...core, reconciliationIdentity: digest(core) } as RecursiveAcknowledgementEvidenceV1;
  const validation = validateRecursiveAcknowledgementEvidenceV1(evidence);
  if (!validation.valid) {
    throw new Error(formatIssues("Recursive acknowledgement materialization failed", validation.issues));
  }
  return evidence;
}

function validateAcknowledgement(
  value: Record<string, unknown>,
  path: string,
  expectedBoundary: RecursiveAcknowledgementBoundaryV1 | undefined,
  expectedOwner: ExpectedOwner,
  issues: RecursiveScopeContractIssue[],
): void {
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "boundary",
      "operationIdentity",
      "ownerFrameIdentity",
      "status",
      "observation",
      "observedAt",
      "reconciliationIdentity",
    ],
    path,
    issues,
  );
  if (value.schema !== RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1) {
    issue(issues, `${path}.schema`, "UNKNOWN_VERSION", "Unsupported acknowledgement evidence version.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    issue(issues, `${path}.canonicalization`, "UNKNOWN_VERSION", "Unsupported canonical JSON version.");
  }
  if (value.boundary !== "effect" && value.boundary !== "charge") {
    issue(issues, `${path}.boundary`, "INVALID_VALUE", "Acknowledgement boundary must be effect or charge.");
  } else if (expectedBoundary !== undefined && value.boundary !== expectedBoundary) {
    issue(issues, `${path}.boundary`, "BINDING_MISMATCH", "Acknowledgement boundary does not match its commit evidence.");
  }
  for (const key of ["operationIdentity", "ownerFrameIdentity"] as const) {
    if (!sha256(value[key])) {
      issue(issues, `${path}.${key}`, "INVALID_VALUE", `${key} must be SHA-256.`);
    }
  }
  if (!ownerMatches(value.ownerFrameIdentity, expectedOwner)) {
    issue(issues, `${path}.ownerFrameIdentity`, "BINDING_MISMATCH", "Acknowledgement owner does not match the child frame.");
  }
  validateAcknowledgementObservation(value.observation, value.status, `${path}.observation`, issues);
  if (!isoInstant(value.observedAt)) {
    issue(issues, `${path}.observedAt`, "INVALID_VALUE", "Observed time must be a canonical ISO-8601 instant.");
  }
  if (!sha256(value.reconciliationIdentity)) {
    issue(issues, `${path}.reconciliationIdentity`, "INVALID_VALUE", "Reconciliation identity must be SHA-256.");
  } else {
    const { reconciliationIdentity, ...core } = value;
    if (reconciliationIdentity !== safeDigest(core)) {
      issue(issues, `${path}.reconciliationIdentity`, "DIGEST_MISMATCH", "Reconciliation identity does not match canonical evidence.");
    }
  }
}

function validateAcknowledgementObservation(
  value: unknown,
  status: unknown,
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, path, "INVALID_TYPE", "Acknowledgement observation must be an object.");
    return;
  }
  if (value.kind === "durable-commit") {
    exactKeys(value, ["kind", "committedIdentity", "evidenceDigest"], path, issues);
    if (status !== "committed") {
      issue(issues, path, "INVALID_VALUE", "Only durable commit evidence may resolve acknowledgement as committed.");
    }
    if (!sha256(value.committedIdentity)) {
      issue(issues, `${path}.committedIdentity`, "INVALID_VALUE", "Committed identity must be SHA-256.");
    }
  } else if (value.kind === "confirmed-absent") {
    exactKeys(value, ["kind", "evidenceDigest"], path, issues);
    if (status !== "retryable") {
      issue(issues, path, "INVALID_VALUE", "Only confirmed absence may resolve acknowledgement as retryable.");
    }
  } else if (value.kind === "uncertain") {
    exactKeys(value, ["kind", "evidenceDigest"], path, issues);
    if (status !== "blocked") {
      issue(issues, path, "INVALID_VALUE", "Uncertain acknowledgement must remain blocked.");
    }
  } else {
    issue(issues, `${path}.kind`, "INVALID_VALUE", "Unknown acknowledgement observation kind.");
  }
  if (!sha256(value.evidenceDigest)) {
    issue(issues, `${path}.evidenceDigest`, "INVALID_VALUE", "Evidence digest must be SHA-256.");
  }
}

function validateEffects(
  value: unknown,
  expectedOwner: ExpectedOwner,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, "$.effects", "INVALID_TYPE", "Effects must be an object.");
    return;
  }
  for (const [key, effect] of Object.entries(value)) {
    const path = `$.effects.${key}`;
    if (!nonEmptyString(key) || !record(effect)) {
      issue(issues, path, "INVALID_TYPE", "Effect evidence must be keyed by a non-empty key and be an object.");
      continue;
    }
    exactKeys(effect, ["effectIdentity", "idempotencyKey", "intentDigest", "acknowledgement", "effectCommitIdentity"], path, issues);
    for (const digestKey of ["effectIdentity", "intentDigest", "effectCommitIdentity"] as const) {
      if (!sha256(effect[digestKey])) issue(issues, `${path}.${digestKey}`, "INVALID_VALUE", `${digestKey} must be SHA-256.`);
    }
    if (!nonEmptyString(effect.idempotencyKey)) {
      issue(issues, `${path}.idempotencyKey`, "INVALID_VALUE", "Effect idempotency key must be non-empty.");
    }
    if (sha256(effect.effectIdentity)) {
      const expectedIdentity = safeDigest({
        kind: "effect",
        idempotencyKey: effect.idempotencyKey,
        intentDigest: effect.intentDigest,
      });
      if (effect.effectIdentity !== expectedIdentity) {
        issue(issues, `${path}.effectIdentity`, "DIGEST_MISMATCH", "Effect identity does not match effect bindings.");
      }
    }
    if (record(effect.acknowledgement)) {
      validateAcknowledgement(effect.acknowledgement, `${path}.acknowledgement`, "effect", expectedOwner, issues);
      if (effect.acknowledgement.operationIdentity !== effect.effectIdentity) {
        issue(issues, `${path}.acknowledgement.operationIdentity`, "BINDING_MISMATCH", "Acknowledgement does not bind the effect identity.");
      }
    } else {
      issue(issues, `${path}.acknowledgement`, "INVALID_TYPE", "Effect acknowledgement must be an object.");
    }
    if (sha256(effect.effectCommitIdentity)) {
      const { effectCommitIdentity, ...core } = effect;
      if (effectCommitIdentity !== safeDigest(core)) {
        issue(issues, `${path}.effectCommitIdentity`, "DIGEST_MISMATCH", "Effect commit identity does not match canonical evidence.");
      }
    }
  }
}

function validateCharges(
  value: unknown,
  expectedOwner: ExpectedOwner,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!record(value)) {
    issue(issues, "$.charges", "INVALID_TYPE", "Charges must be an object.");
    return;
  }
  for (const [key, charge] of Object.entries(value)) {
    const path = `$.charges.${key}`;
    if (!nonEmptyString(key) || !record(charge)) {
      issue(issues, path, "INVALID_TYPE", "Charge evidence must be keyed by a non-empty key and be an object.");
      continue;
    }
    exactKeys(
      charge,
      ["chargeIdentity", "reservationIdentity", "measurementDigest", "settledCostMicros", "currency", "acknowledgement", "chargeCommitIdentity"],
      path,
      issues,
    );
    for (const digestKey of ["chargeIdentity", "reservationIdentity", "measurementDigest", "chargeCommitIdentity"] as const) {
      if (!sha256(charge[digestKey])) issue(issues, `${path}.${digestKey}`, "INVALID_VALUE", `${digestKey} must be SHA-256.`);
    }
    if (!nonNegativeInteger(charge.settledCostMicros)) {
      issue(issues, `${path}.settledCostMicros`, "INVALID_VALUE", "Settled cost must be a non-negative safe integer.");
    }
    if (typeof charge.currency !== "string" || !/^[A-Z]{3}$/.test(charge.currency)) {
      issue(issues, `${path}.currency`, "INVALID_VALUE", "Currency must be an uppercase ISO-style three-letter code.");
    }
    if (sha256(charge.chargeIdentity)) {
      const expectedIdentity = safeDigest({
        kind: "charge",
        reservationIdentity: charge.reservationIdentity,
        measurementDigest: charge.measurementDigest,
        settledCostMicros: charge.settledCostMicros,
        currency: charge.currency,
      });
      if (charge.chargeIdentity !== expectedIdentity) {
        issue(issues, `${path}.chargeIdentity`, "DIGEST_MISMATCH", "Charge identity does not match charge bindings.");
      }
    }
    if (record(charge.acknowledgement)) {
      validateAcknowledgement(charge.acknowledgement, `${path}.acknowledgement`, "charge", expectedOwner, issues);
      if (charge.acknowledgement.operationIdentity !== charge.chargeIdentity) {
        issue(issues, `${path}.acknowledgement.operationIdentity`, "BINDING_MISMATCH", "Acknowledgement does not bind the charge identity.");
      }
    } else {
      issue(issues, `${path}.acknowledgement`, "INVALID_TYPE", "Charge acknowledgement must be an object.");
    }
    if (sha256(charge.chargeCommitIdentity)) {
      const { chargeCommitIdentity, ...core } = charge;
      if (chargeCommitIdentity !== safeDigest(core)) {
        issue(issues, `${path}.chargeCommitIdentity`, "DIGEST_MISMATCH", "Charge commit identity does not match canonical evidence.");
      }
    }
  }
}

function validateIntentClaims(
  value: unknown,
  expectedOwner: ExpectedOwner,
  issues: RecursiveScopeContractIssue[],
): void {
  if (!Array.isArray(value)) {
    issue(issues, "$.intentClaims", "INVALID_TYPE", "Intent claims must be an array.");
    return;
  }
  const seen = new Set<string>();
  let terminalClaimSeen = false;
  value.forEach((claim, index) => {
    const path = `$.intentClaims[${index}]`;
    if (!record(claim)) {
      issue(issues, path, "INVALID_TYPE", "Intent claim must be an object.");
      return;
    }
    exactKeys(claim, ["kind", "intentKey", "nodeId", "ownerFrameIdentity", "claimIdentity"], path, issues);
    if (!INTENT_KINDS.includes(claim.kind as (typeof INTENT_KINDS)[number])) {
      issue(issues, `${path}.kind`, "INVALID_VALUE", "Unknown intent kind.");
    }
    if (claim.kind === "terminal") {
      if (terminalClaimSeen) {
        issue(issues, path, "OWNERSHIP_CONFLICT", "A child commit may own only one terminal intent.");
      }
      terminalClaimSeen = true;
    }
    for (const key of ["intentKey", "nodeId"] as const) {
      if (!nonEmptyString(claim[key])) issue(issues, `${path}.${key}`, "INVALID_VALUE", `${key} must be non-empty.`);
    }
    if (!sha256(claim.ownerFrameIdentity) || !ownerMatches(claim.ownerFrameIdentity, expectedOwner)) {
      issue(issues, `${path}.ownerFrameIdentity`, "BINDING_MISMATCH", "Intent owner must be the child frame identity.");
    }
    if (!sha256(claim.claimIdentity)) {
      issue(issues, `${path}.claimIdentity`, "INVALID_VALUE", "Claim identity must be SHA-256.");
    } else {
      const { claimIdentity, ...core } = claim;
      if (claimIdentity !== safeDigest(core)) {
        issue(issues, `${path}.claimIdentity`, "DIGEST_MISMATCH", "Claim identity does not match canonical ownership.");
      }
    }
    const ownerKey = `${String(claim.kind)}:${String(claim.intentKey)}`;
    if (seen.has(ownerKey)) {
      issue(issues, path, "OWNERSHIP_CONFLICT", "A child commit cannot claim the same intent twice.");
    }
    seen.add(ownerKey);
  });
  if (value.every(record)) {
    const sorted = [...value].sort((left, right) => compareIntentClaims(
      left as unknown as RecursiveIntentClaimV1,
      right as unknown as RecursiveIntentClaimV1,
    ));
    if (!sameCanonical(value, sorted)) {
      issue(issues, "$.intentClaims", "INVALID_VALUE", "Intent claims must be canonically sorted.");
    }
  }
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

type ExpectedOwner = string | ReadonlySet<string> | undefined;

function ownerMatches(value: unknown, expected: ExpectedOwner): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "string") return value === expected;
  return typeof value === "string" && expected.has(value);
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

function compareIntentClaims(
  left: RecursiveIntentClaimV1,
  right: RecursiveIntentClaimV1,
): number {
  return compareText(
    `${left.kind}:${left.intentKey}:${left.claimIdentity}`,
    `${right.kind}:${right.intentKey}:${right.claimIdentity}`,
  );
}

function mergeRecord<T>(
  target: Record<string, T>,
  source: Readonly<Record<string, T>>,
  path: string,
  label: string,
  issues: RecursiveScopeContractIssue[],
): void {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      issue(issues, `${path}.${key}`, "MERGE_CONFLICT", `Same-key ${label} commit is owned by more than one sibling.`);
    } else {
      target[key] = value;
    }
  }
}

function conflictSet(
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
