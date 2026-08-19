import { MICROS_PER_CENT } from "../ai-economics.js";
import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import { LOOP_ECONOMICS_EVIDENCE_SCHEMA } from "../loop-economics-evidence.js";
import { validateControlSelections } from "./control.js";
import { validateLeaves } from "./leaves.js";
import {
  admissionCore,
  sumPricedReservations,
  validateOwner,
} from "./owner.js";
import { sumSettledCosts, validateResolution } from "./resolution.js";
import {
  add,
  canonicalEqual,
  compareExpected,
  containsCycle,
  digest,
  exactKeys,
  invalid,
  nonNegativeSafeInteger,
  nonNegativeSafeIntegerField,
  record,
  safeDigest,
  sha,
  validation,
} from "./shared.js";
import {
  LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
  type LoopEconomicsEvidenceAdmissionResultV2,
  type LoopEconomicsEvidenceDiagnosticV2,
  type LoopEconomicsEvidenceExpectationV2,
  type LoopEconomicsEvidenceInputV2,
  type LoopEconomicsEvidenceV2,
  type LoopEconomicsEvidenceValidationV2,
} from "./types.js";

export function materializeLoopEconomicsEvidenceV2(
  input: LoopEconomicsEvidenceInputV2
): LoopEconomicsEvidenceV2 {
  const admissionDigest = digest(admissionCore(input));
  const withAdmissionDigest = { ...input, admissionDigest };
  return {
    ...withAdmissionDigest,
    evidenceDigest: digest(withAdmissionDigest),
  };
}

/**
 * Fail-closed terminal admission. Pending and reconciliation-required evidence
 * are returned as explicit non-success states, never as admitted completion.
 */
export function admitLoopEconomicsEvidenceV2(
  value: unknown,
  expected: LoopEconomicsEvidenceExpectationV2 = {}
): LoopEconomicsEvidenceAdmissionResultV2 {
  const result = validateLoopEconomicsEvidenceV2(value, expected);
  if (!result.valid || !record(value)) {
    return { status: "denied", diagnostics: result.diagnostics };
  }
  const evidence = value as unknown as LoopEconomicsEvidenceV2;
  if (result.terminalSuccess) {
    return { status: "admitted", evidence };
  }
  if (result.requiresReconciliation) {
    return { status: "reconciliation-required", evidence };
  }
  return { status: "pending", evidence };
}

export function validateLoopEconomicsEvidenceV2(
  value: unknown,
  expected: LoopEconomicsEvidenceExpectationV2 = {}
): LoopEconomicsEvidenceValidationV2 {
  const diagnostics: LoopEconomicsEvidenceDiagnosticV2[] = [];
  if (!record(value)) {
    return invalid("$", "Loop economics V2 evidence must be an object.");
  }
  if (containsCycle(value)) {
    return invalid("$", "Loop economics V2 evidence must be acyclic.");
  }
  if (value.schema === LOOP_ECONOMICS_EVIDENCE_SCHEMA) {
    add(
      diagnostics,
      "LOOP_ECONOMICS_V2_DOWNGRADE_DENIED",
      "schema",
      "V1 evidence cannot satisfy a boundary that requires per-leaf V2 outcomes."
    );
    return validation(diagnostics, "invalid");
  }

  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "owner",
      "definitionDigest",
      "bodyPlanDigest",
      "unitAttempt",
      "controlSelections",
      "leaves",
      "resolution",
      "admissionDigest",
      "evidenceDigest",
    ],
    "$",
    diagnostics
  );
  if (value.schema !== LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "schema", "Unsupported loop economics V2 evidence schema.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "canonicalization", "Unsupported canonical JSON version.");
  }

  validateOwner(value.owner, "owner", diagnostics);
  if (expected.owner !== undefined && !canonicalEqual(value.owner, expected.owner)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", "owner", "Evidence owner does not match the current loop reservation owner.");
  }
  sha(value.definitionDigest, "definitionDigest", diagnostics);
  sha(value.bodyPlanDigest, "bodyPlanDigest", diagnostics);
  nonNegativeSafeIntegerField(value.unitAttempt, "unitAttempt", diagnostics);
  if (
    record(value.owner) &&
    record(value.owner.unit) &&
    value.owner.unit.kind === "item" &&
    nonNegativeSafeInteger(value.owner.unit.attempt) &&
    value.unitAttempt !== value.owner.unit.attempt
  ) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "unitAttempt", "Unit attempt must equal the deterministic item-owner attempt.");
  }
  if (
    record(value.owner) &&
    record(value.owner.unit) &&
    value.owner.unit.kind === "iteration" &&
    value.unitAttempt !== 0
  ) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "unitAttempt", "Predicate-loop iterations must use unit attempt zero.");
  }
  compareExpected(value.definitionDigest, expected.definitionDigest, "definitionDigest", diagnostics);
  compareExpected(value.bodyPlanDigest, expected.bodyPlanDigest, "bodyPlanDigest", diagnostics);
  if (expected.unitAttempt !== undefined && value.unitAttempt !== expected.unitAttempt) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "unitAttempt", "Unit attempt differs from current host authority.");
  }

  const selections = Array.isArray(value.controlSelections)
    ? value.controlSelections
    : [];
  if (!Array.isArray(value.controlSelections)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "controlSelections", "Control selections must be an array.");
  }
  validateControlSelections(selections, diagnostics);

  const leaves = Array.isArray(value.leaves) ? value.leaves : [];
  if (!Array.isArray(value.leaves) || leaves.length === 0) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "leaves", "At least one economics leaf admission is required.");
  }
  validateLeaves(leaves, selections, value.owner, diagnostics);

  const resolutionStatus = validateResolution(
    value.resolution,
    leaves,
    selections,
    value.owner,
    diagnostics
  );

  const evidence = value as unknown as LoopEconomicsEvidenceV2;
  const expectedAdmissionDigest = safeDigest(admissionCore(evidence));
  if (value.admissionDigest !== expectedAdmissionDigest) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "admissionDigest", "Admission digest does not match the canonical plan and leaf authority.");
  }
  compareExpected(value.admissionDigest, expected.admissionDigest, "admissionDigest", diagnostics);
  const { evidenceDigest, ...withoutEvidenceDigest } = value;
  if (evidenceDigest !== safeDigest(withoutEvidenceDigest)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "evidenceDigest", "Evidence digest does not match canonical content.");
  }
  compareExpected(evidenceDigest, expected.evidenceDigest, "evidenceDigest", diagnostics);
  if (
    expected.resolutionStatus !== undefined &&
    resolutionStatus !== expected.resolutionStatus
  ) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", `Expected resolution status ${expected.resolutionStatus}.`);
  }

  if (expected.reservedCostCents !== undefined) {
    const reservedMicros = sumPricedReservations(leaves);
    const expectedCents = reservedMicros === undefined
      ? undefined
      : Math.ceil(reservedMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.reservedCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.reservedCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_COST_MISMATCH", "leaves", "Priced execution reservations do not equal authoritative reserved cents.");
    }
  }
  if (expected.settledCostCents !== undefined) {
    const settledMicros = sumSettledCosts(value.resolution, leaves);
    const expectedCents = settledMicros === undefined
      ? undefined
      : Math.ceil(settledMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.settledCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.settledCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_COST_MISMATCH", "resolution.outcomes", "Recorded charge truth does not equal authoritative settled cents.");
    }
  }

  return validation(diagnostics, resolutionStatus);
}
