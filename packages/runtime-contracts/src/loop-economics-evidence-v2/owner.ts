import {
  add,
  exactKeys,
  nonEmpty,
  nonEmptyString,
  nonNegativeSafeInteger,
  nonNegativeSafeIntegerField,
  positiveSafeInteger,
  positiveSafeIntegerField,
  record,
} from "./shared.js";
import type {
  LoopEconomicsEvidenceDiagnosticV2,
  LoopEconomicsEvidenceInputV2,
  LoopEconomicsEvidenceV2,
} from "./types.js";

export function validateOwner(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(value) || !record(value.unit)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Evidence owner and unit are required.");
    return;
  }
  exactKeys(value, ["runId", "loopNodeId", "reservationId", "unit"], path, diagnostics);
  for (const key of ["runId", "loopNodeId", "reservationId"] as const) {
    nonEmpty(value[key], `${path}.${key}`, diagnostics);
  }
  let expectedReservationId: string | undefined;
  if (value.unit.kind === "iteration") {
    exactKeys(value.unit, ["kind", "iteration"], `${path}.unit`, diagnostics);
    positiveSafeIntegerField(value.unit.iteration, `${path}.unit.iteration`, diagnostics);
    if (nonEmptyString(value.runId) && nonEmptyString(value.loopNodeId) && positiveSafeInteger(value.unit.iteration)) {
      expectedReservationId = `resv:v1:${value.runId}:iteration:${value.loopNodeId}:${value.unit.iteration}`;
    }
  } else if (value.unit.kind === "item") {
    exactKeys(value.unit, ["kind", "itemIndex", "iteration", "attempt"], `${path}.unit`, diagnostics);
    nonNegativeSafeIntegerField(value.unit.itemIndex, `${path}.unit.itemIndex`, diagnostics);
    positiveSafeIntegerField(value.unit.iteration, `${path}.unit.iteration`, diagnostics);
    nonNegativeSafeIntegerField(value.unit.attempt, `${path}.unit.attempt`, diagnostics);
    if (
      nonNegativeSafeInteger(value.unit.itemIndex) &&
      positiveSafeInteger(value.unit.iteration) &&
      value.unit.iteration !== value.unit.itemIndex + 1
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", `${path}.unit.iteration`, "For-each iteration must equal itemIndex + 1.");
    }
    if (
      nonEmptyString(value.runId) &&
      nonEmptyString(value.loopNodeId) &&
      nonNegativeSafeInteger(value.unit.itemIndex) &&
      nonNegativeSafeInteger(value.unit.attempt)
    ) {
      const base = `resv:v1:${value.runId}:item:${value.loopNodeId}:${value.unit.itemIndex}`;
      expectedReservationId = value.unit.attempt > 0
        ? `${base}:attempt:${value.unit.attempt}`
        : base;
    }
  } else {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.unit.kind`, "Unit kind must be iteration or item.");
  }
  if (expectedReservationId !== undefined && value.reservationId !== expectedReservationId) {
    add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", `${path}.reservationId`, "Reservation id does not match its deterministic owner.");
  }
}

export function admissionCore(
  value: LoopEconomicsEvidenceInputV2 | LoopEconomicsEvidenceV2
) {
  return {
    schema: value.schema,
    canonicalization: value.canonicalization,
    owner: value.owner,
    definitionDigest: value.definitionDigest,
    bodyPlanDigest: value.bodyPlanDigest,
    unitAttempt: value.unitAttempt,
    // A branch/catch choice may become knowable only after the unit starts.
    // Bind the immutable control inventory here; evidenceDigest separately
    // binds the later selected values.
    controlSelections: Array.isArray(value.controlSelections)
      ? value.controlSelections.map((selection) => record(selection)
        ? { kind: selection.kind, nodePath: selection.nodePath }
        : selection)
      : value.controlSelections,
    leaves: value.leaves,
  };
}

export function sumPricedReservations(
  leaves: readonly unknown[]
): number | undefined {
  let total = 0;
  for (const leaf of leaves) {
    if (!record(leaf) || leaf.kind !== "execution" || !record(leaf.execution) || !record(leaf.execution.money)) continue;
    if (leaf.execution.money.status !== "priced" || !record(leaf.execution.money.reservation)) return undefined;
    const amount = leaf.execution.money.reservation.reservedAmountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}
