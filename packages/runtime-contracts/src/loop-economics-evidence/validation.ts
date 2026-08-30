import {
  AI_BUDGET_RESERVATION_SCHEMA,
  type AiBudgetReservation,
} from "../ai-budget-reservation.js";
import {
  AI_COST_UNKNOWN_REASONS,
  MICROS_PER_CENT,
  validateAiPriceProvenance,
  type AiCostUnknownReason,
} from "../ai-economics.js";
import {
  validateAiExecutionBinding,
  type AiExecutionBinding,
} from "../ai-execution.js";
import { validateAiExecutionBindingDigest } from "../ai-execution-node.js";
import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  add,
  canonicalEqual,
  containsCycle,
  exactKeys,
  invalid,
  iso,
  nonEmpty,
  nonEmptyString,
  nonNegativeSafeInteger,
  nonNegativeSafeIntegerField,
  positiveSafeInteger,
  positiveSafeIntegerValue,
  record,
  reservationCore,
  safeDigest,
  sha,
  sumPricedReservations,
  sumTerminalCosts,
  validateSortedUniqueNodes,
} from "./shared.js";
import { validateTerminal } from "./terminal-validation.js";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  type LoopEconomicsEvidenceDiagnostic,
  type LoopEconomicsEvidenceExpectation,
  type LoopEconomicsEvidenceV1,
  type LoopEconomicsEvidenceValidation,
} from "./types.js";

export function validateLoopEconomicsEvidence(
  value: unknown,
  expected: LoopEconomicsEvidenceExpectation = {}
): LoopEconomicsEvidenceValidation {
  const diagnostics: LoopEconomicsEvidenceDiagnostic[] = [];
  if (!record(value)) {
    return invalid("$", "Loop economics evidence must be an object.");
  }
  if (containsCycle(value)) {
    return invalid("$", "Loop economics evidence must be acyclic.");
  }
  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "owner",
      "executions",
      "effectIntents",
      "terminal",
      "reservationBindingDigest",
      "evidenceDigest",
    ],
    "$",
    diagnostics
  );
  if (value.schema !== LOOP_ECONOMICS_EVIDENCE_SCHEMA) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "schema", "Unsupported loop economics evidence schema.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "canonicalization", "Unsupported canonical JSON version.");
  }

  validateOwner(value.owner, "owner", diagnostics);
  if (expected.owner !== undefined && !canonicalEqual(value.owner, expected.owner)) {
    add(diagnostics, "LOOP_ECONOMICS_OWNER_MISMATCH", "owner", "Evidence owner does not match the current loop reservation owner.");
  }

  const executions = Array.isArray(value.executions) ? value.executions : [];
  if (!Array.isArray(value.executions) || executions.length === 0) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "executions", "At least one execution admission is required.");
  }
  validateSortedUniqueNodes(executions, "executions", diagnostics);
  executions.forEach((execution, index) =>
    validateExecutionAdmission(execution, `executions[${index}]`, diagnostics)
  );

  const effectIntents = Array.isArray(value.effectIntents)
    ? value.effectIntents
    : [];
  if (!Array.isArray(value.effectIntents)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "effectIntents", "Effect intents must be an array.");
  }
  validateSortedUniqueNodes(effectIntents, "effectIntents", diagnostics);
  effectIntents.forEach((intent, index) => {
    const path = `effectIntents[${index}]`;
    if (!record(intent)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Effect intent binding must be an object.");
      return;
    }
    exactKeys(intent, ["nodeId", "intentDigest"], path, diagnostics);
    nonEmpty(intent.nodeId, `${path}.nodeId`, diagnostics);
    sha(intent.intentDigest, `${path}.intentDigest`, diagnostics);
  });

  validateTerminal(value.terminal, executions, effectIntents, diagnostics);

  const evidence = value as unknown as LoopEconomicsEvidenceV1;
  const expectedReservationDigest = safeDigest(reservationCore(evidence));
  if (value.reservationBindingDigest !== expectedReservationDigest) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "reservationBindingDigest", "Reservation binding digest does not match canonical admitted evidence.");
  }
  if (
    expected.reservationBindingDigest !== undefined &&
    value.reservationBindingDigest !== expected.reservationBindingDigest
  ) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "reservationBindingDigest", "Reservation binding differs from the current host-admitted evidence.");
  }
  const { evidenceDigest, ...withoutEvidenceDigest } = value;
  if (evidenceDigest !== safeDigest(withoutEvidenceDigest)) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "evidenceDigest", "Evidence digest does not match canonical content.");
  }
  if (
    expected.evidenceDigest !== undefined &&
    evidenceDigest !== expected.evidenceDigest
  ) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "evidenceDigest", "Terminal usage/effect evidence differs from the current host record.");
  }
  if (expected.terminalStatus !== undefined) {
    const terminalStatus = record(value.terminal) ? value.terminal.status : undefined;
    if (terminalStatus !== expected.terminalStatus) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "terminal.status", `Expected terminal status ${expected.terminalStatus}.`);
    }
  }

  if (expected.reservedCostCents !== undefined) {
    const reservedMicros = sumPricedReservations(executions);
    const expectedCents = reservedMicros === undefined
      ? undefined
      : Math.ceil(reservedMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.reservedCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.reservedCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", "executions", "Priced reservations do not equal the loop's authoritative reserved cents.");
    }
  }
  if (expected.settledCostCents !== undefined) {
    const settledMicros = sumTerminalCosts(value.terminal);
    const expectedCents = settledMicros === undefined
      ? undefined
      : Math.ceil(settledMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.settledCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.settledCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", "terminal.executions", "Terminal priced usage does not equal the loop's authoritative settled cents.");
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

function validateOwner(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value) || !record(value.unit)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Evidence owner and unit are required.");
    return;
  }
  exactKeys(value, ["runId", "loopNodeId", "reservationId", "unit"], path, diagnostics);
  for (const key of ["runId", "loopNodeId", "reservationId"] as const) {
    nonEmpty(value[key], `${path}.${key}`, diagnostics);
  }
  const unit = value.unit;
  let expectedReservationId: string | undefined;
  if (unit.kind === "iteration") {
    exactKeys(unit, ["kind", "iteration"], `${path}.unit`, diagnostics);
    positiveSafeInteger(unit.iteration, `${path}.unit.iteration`, diagnostics);
    if (nonEmptyString(value.runId) && nonEmptyString(value.loopNodeId) && positiveSafeIntegerValue(unit.iteration)) {
      expectedReservationId = `resv:v1:${value.runId}:iteration:${value.loopNodeId}:${unit.iteration}`;
    }
  } else if (unit.kind === "item") {
    exactKeys(unit, ["kind", "itemIndex", "iteration", "attempt"], `${path}.unit`, diagnostics);
    nonNegativeSafeIntegerField(unit.itemIndex, `${path}.unit.itemIndex`, diagnostics);
    positiveSafeInteger(unit.iteration, `${path}.unit.iteration`, diagnostics);
    nonNegativeSafeIntegerField(unit.attempt, `${path}.unit.attempt`, diagnostics);
    if (
      nonNegativeSafeInteger(unit.itemIndex) &&
      positiveSafeIntegerValue(unit.iteration) &&
      unit.iteration !== unit.itemIndex + 1
    ) {
      add(diagnostics, "LOOP_ECONOMICS_OWNER_MISMATCH", `${path}.unit.iteration`, "For-each iteration must equal itemIndex + 1.");
    }
    if (
      nonEmptyString(value.runId) &&
      nonEmptyString(value.loopNodeId) &&
      nonNegativeSafeInteger(unit.itemIndex) &&
      nonNegativeSafeInteger(unit.attempt)
    ) {
      const base = `resv:v1:${value.runId}:item:${value.loopNodeId}:${unit.itemIndex}`;
      expectedReservationId = unit.attempt > 0
        ? `${base}:attempt:${unit.attempt}`
        : base;
    }
  } else {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.unit.kind`, "Unit kind must be iteration or item.");
  }
  if (expectedReservationId !== undefined && value.reservationId !== expectedReservationId) {
    add(diagnostics, "LOOP_ECONOMICS_OWNER_MISMATCH", `${path}.reservationId`, "Reservation id does not match its deterministic owner.");
  }
}

function validateExecutionAdmission(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Execution admission must be an object.");
    return;
  }
  exactKeys(value, ["nodeId", "binding", "money", "quota"], path, diagnostics);
  nonEmpty(value.nodeId, `${path}.nodeId`, diagnostics);
  for (const diagnostic of [
    ...validateAiExecutionBinding(value.binding).diagnostics,
    ...validateAiExecutionBindingDigest(value.binding, `${path}.binding`).diagnostics,
  ]) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", diagnostic.path, diagnostic.message);
  }
  const binding = record(value.binding)
    ? (value.binding as unknown as AiExecutionBinding)
    : undefined;
  validateMoney(value.money, binding, `${path}.money`, diagnostics);
  validateQuota(value.quota, binding, `${path}.quota`, diagnostics);
}

function validateMoney(
  value: unknown,
  binding: AiExecutionBinding | undefined,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Money binding must be an object.");
    return;
  }
  if (value.status === "unknown") {
    exactKeys(value, ["status", "reason"], path, diagnostics);
    if (!AI_COST_UNKNOWN_REASONS.includes(value.reason as AiCostUnknownReason)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.reason`, "Unknown-money reason is not canonical.");
    }
    if (value.reason === "subscription" && binding?.offer.authMode !== "subscription_cli") {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Subscription money requires a subscription execution offer.");
    }
    return;
  }
  if (value.status !== "priced" || !record(value.reservation)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.status`, "Money binding must be priced or explicitly unknown.");
    return;
  }
  exactKeys(value, ["status", "reservation", "tariffDigest"], path, diagnostics);
  sha(value.tariffDigest, `${path}.tariffDigest`, diagnostics);
  validateBudgetReservation(value.reservation, `${path}.reservation`, diagnostics);
  const reservation = value.reservation as unknown as AiBudgetReservation;
  if (
    binding !== undefined &&
    (reservation.offerRef !== binding.offer.offerId ||
      reservation.tariffRef !== binding.offer.tariffRef ||
      reservation.modelRef !== binding.model.modelRef ||
      reservation.modelRevision !== binding.model.revision)
  ) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Budget reservation does not match the execution offer, tariff, and model revision.");
  }
}

function validateBudgetReservation(
  value: Record<string, unknown>,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  exactKeys(
    value,
    ["schema", "status", "tariffRef", "offerRef", "modelRef", "modelRevision", "provenance", "currency", "reservedAmountMicros", "usageCeiling", "reservedAt"],
    path,
    diagnostics
  );
  if (value.schema !== AI_BUDGET_RESERVATION_SCHEMA || value.status !== "admitted") {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.schema`, "Only an admitted canonical budget reservation is valid.");
  }
  for (const key of ["tariffRef", "offerRef", "modelRef", "modelRevision"] as const) {
    nonEmpty(value[key], `${path}.${key}`, diagnostics);
  }
  if (!/^[A-Z]{3}$/.test(typeof value.currency === "string" ? value.currency : "")) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.currency`, "Reservation currency must be an uppercase ISO-style code.");
  }
  nonNegativeSafeIntegerField(value.reservedAmountMicros, `${path}.reservedAmountMicros`, diagnostics);
  if (!iso(value.reservedAt)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.reservedAt`, "Reservation time must be ISO-8601.");
  }
  for (const diagnostic of validateAiPriceProvenance(value.provenance, `${path}.provenance`)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", diagnostic.path, diagnostic.message);
  }
  if (record(value.provenance) && iso(value.reservedAt) && iso(value.provenance.expiresAt)) {
    if (Date.parse(value.provenance.expiresAt) <= Date.parse(value.reservedAt)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.provenance.expiresAt`, "Reservation cannot bind an expired tariff authority.");
    }
  }
  if (!record(value.usageCeiling)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.usageCeiling`, "Usage ceiling is required.");
  } else {
    exactKeys(value.usageCeiling, ["uncachedInputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"], `${path}.usageCeiling`, diagnostics);
    for (const key of ["uncachedInputTokens", "outputTokens"] as const) {
      nonNegativeSafeIntegerField(value.usageCeiling[key], `${path}.usageCeiling.${key}`, diagnostics);
    }
    for (const key of ["cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      if (value.usageCeiling[key] !== undefined) {
        nonNegativeSafeIntegerField(value.usageCeiling[key], `${path}.usageCeiling.${key}`, diagnostics);
      }
    }
  }
}

function validateQuota(
  value: unknown,
  binding: AiExecutionBinding | undefined,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Quota binding must be an object.");
    return;
  }
  if (value.status === "not-applicable") {
    exactKeys(value, ["status"], path, diagnostics);
    if (binding?.offer.quotaPolicyRef !== undefined) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Execution offer names a quota policy but evidence omits its authority.");
    }
    return;
  }
  if (value.status !== "bound") {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.status`, "Quota binding must be bound or not-applicable.");
    return;
  }
  exactKeys(value, ["status", "policyRef", "policyDigest", "decisionDigest"], path, diagnostics);
  nonEmpty(value.policyRef, `${path}.policyRef`, diagnostics);
  sha(value.policyDigest, `${path}.policyDigest`, diagnostics);
  sha(value.decisionDigest, `${path}.decisionDigest`, diagnostics);
  if (binding?.offer.quotaPolicyRef !== value.policyRef) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", `${path}.policyRef`, "Quota policy does not match the execution offer.");
  }
}
