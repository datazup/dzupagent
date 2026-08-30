import {
  RECURSIVE_ACKNOWLEDGEMENT_SCHEMA_V1,
  type RecursiveAcknowledgementBoundaryV1,
  type RecursiveAcknowledgementEvidenceV1,
  type RecursiveIntentClaimV1,
  type RecursiveScopeContractIssue,
  type RecursiveScopeContractValidation,
} from "./types.js";
import {
  CANONICAL_JSON_VERSION,
  compareText,
  exactKeys,
  isoInstant,
  issue,
  nonEmptyString,
  nonNegativeInteger,
  record,
  safeDigest,
  sameCanonical,
  sha256,
} from "./internals.js";

const INTENT_KINDS = [
  "interaction",
  "suspension",
  "terminal",
  "error",
] as const;

export type ExpectedOwner = string | ReadonlySet<string> | undefined;

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

export function validateEffects(
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

export function validateCharges(
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

export function validateIntentClaims(
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

export function compareIntentClaims(
  left: RecursiveIntentClaimV1,
  right: RecursiveIntentClaimV1,
): number {
  return compareText(
    `${left.kind}:${left.intentKey}:${left.claimIdentity}`,
    `${right.kind}:${right.intentKey}:${right.claimIdentity}`,
  );
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

function ownerMatches(value: unknown, expected: ExpectedOwner): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "string") return value === expected;
  return typeof value === "string" && expected.has(value);
}
