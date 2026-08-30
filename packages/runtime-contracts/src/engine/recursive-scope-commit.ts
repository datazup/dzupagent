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
  type RecursiveScopedCommitInputV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedJsonValue,
  type RecursiveScopedMergeV1,
  type RecursiveScopedSha256Digest,
} from "../recursive-scope/types.js";
import {
  CANONICAL_JSON_VERSION,
  compareText,
  digest,
  issue,
  sameCanonical,
  sortedRecord,
} from "../recursive-scope/internals.js";
import { formatIssues, validateRecursiveScopedFrameV1 } from "../recursive-scope/frame.js";
import {
  conflictSet,
  validateRecursiveScopedCommitV1,
  validateRecursiveScopedMergeV1,
} from "../recursive-scope/commit-validation.js";
import {
  compareIntentClaims,
  validateRecursiveAcknowledgementEvidenceV1,
} from "../recursive-scope/evidence-validation.js";

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
