import {
  AI_BUDGET_RESERVATION_SCHEMA,
  type AiBudgetReservation,
} from "./ai-budget-reservation.js";
import {
  AI_COST_UNKNOWN_REASONS,
  MICROS_PER_CENT,
  validateAiPriceProvenance,
  type AiCostUnknownReason,
} from "./ai-economics.js";
import {
  validateAiExecutionBinding,
  validateAiUsageTruthV2,
  type AiExecutionBinding,
  type AiUsageTruthV2,
} from "./ai-execution.js";
import { validateAiExecutionBindingDigest } from "./ai-execution-node.js";
import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
} from "./idempotency.js";

export const LOOP_ECONOMICS_EVIDENCE_SCHEMA =
  "dzupagent.loopEconomicsEvidence/v1" as const;

type Sha256Digest = `sha256:${string}`;

export type LoopEconomicsEvidenceUnit =
  | {
      readonly kind: "iteration";
      readonly iteration: number;
    }
  | {
      readonly kind: "item";
      readonly itemIndex: number;
      readonly iteration: number;
      readonly attempt: number;
    };

/** Exact scheduler owner of one reservation attempt. */
export interface LoopEconomicsEvidenceOwner {
  readonly runId: string;
  readonly loopNodeId: string;
  readonly reservationId: string;
  readonly unit: LoopEconomicsEvidenceUnit;
}

export type LoopEconomicsMoneyBinding =
  | {
      readonly status: "priced";
      readonly reservation: AiBudgetReservation;
      /** Digest of the exact tariff bytes admitted by the host. */
      readonly tariffDigest: Sha256Digest;
    }
  | {
      readonly status: "unknown";
      readonly reason: AiCostUnknownReason;
    };

export type LoopEconomicsQuotaBinding =
  | { readonly status: "not-applicable" }
  | {
      readonly status: "bound";
      readonly policyRef: string;
      readonly policyDigest: Sha256Digest;
      readonly decisionDigest: Sha256Digest;
    };

/** One pre-dispatch execution identity covered by the loop reservation. */
export interface LoopEconomicsExecutionAdmission {
  readonly nodeId: string;
  readonly binding: AiExecutionBinding;
  readonly money: LoopEconomicsMoneyBinding;
  readonly quota: LoopEconomicsQuotaBinding;
}

export interface LoopEconomicsEffectIntentBinding {
  readonly nodeId: string;
  readonly intentDigest: Sha256Digest;
}

export interface LoopEconomicsTerminalExecution {
  readonly nodeId: string;
  readonly bindingDigest: Sha256Digest;
  /** Canonical V2 receipt digest; result bytes stay outside the checkpoint. */
  readonly receiptDigest: Sha256Digest;
  readonly usage: AiUsageTruthV2;
}

export interface LoopEconomicsTerminalEffect {
  readonly nodeId: string;
  readonly intentDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

export type LoopEconomicsTerminalEvidence =
  | { readonly status: "pending" }
  | {
      readonly status: "recorded";
      readonly executions: readonly LoopEconomicsTerminalExecution[];
      readonly effects: readonly LoopEconomicsTerminalEffect[];
    };

/**
 * Sanitized, versioned evidence retained by a strict loop checkpoint.
 *
 * The immutable reservation digest excludes terminal observations, allowing a
 * pending hold and its later settlement to prove they describe the same
 * admitted route/tariff/quota/effect intent. The full evidence digest covers
 * terminal usage and receipt identities. No raw prompt, provider payload,
 * endpoint, credential, or result is retained.
 */
export interface LoopEconomicsEvidenceV1 {
  readonly schema: typeof LOOP_ECONOMICS_EVIDENCE_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly owner: LoopEconomicsEvidenceOwner;
  readonly executions: readonly LoopEconomicsExecutionAdmission[];
  readonly effectIntents: readonly LoopEconomicsEffectIntentBinding[];
  readonly terminal: LoopEconomicsTerminalEvidence;
  readonly reservationBindingDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
}

export type LoopEconomicsEvidenceInput = Omit<
  LoopEconomicsEvidenceV1,
  "reservationBindingDigest" | "evidenceDigest"
>;

export interface LoopEconomicsEvidenceExpectation {
  readonly owner?: LoopEconomicsEvidenceOwner;
  readonly reservationBindingDigest?: Sha256Digest;
  readonly evidenceDigest?: Sha256Digest;
  readonly reservedCostCents?: number;
  readonly settledCostCents?: number;
  readonly terminalStatus?: LoopEconomicsTerminalEvidence["status"];
}

export type LoopEconomicsEvidenceDiagnosticCode =
  | "LOOP_ECONOMICS_INVALID"
  | "LOOP_ECONOMICS_BINDING_MISMATCH"
  | "LOOP_ECONOMICS_OWNER_MISMATCH"
  | "LOOP_ECONOMICS_COST_MISMATCH";

export interface LoopEconomicsEvidenceDiagnostic {
  readonly code: LoopEconomicsEvidenceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface LoopEconomicsEvidenceValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly LoopEconomicsEvidenceDiagnostic[];
}

export function materializeLoopEconomicsEvidence(
  input: LoopEconomicsEvidenceInput
): LoopEconomicsEvidenceV1 {
  const reservationBindingDigest = digest(reservationCore(input));
  const withReservationDigest = { ...input, reservationBindingDigest };
  return {
    ...withReservationDigest,
    evidenceDigest: digest(withReservationDigest),
  };
}

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

function validateTerminal(
  value: unknown,
  admissions: readonly unknown[],
  effectIntents: readonly unknown[],
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal", "Terminal evidence is required.");
    return;
  }
  if (value.status === "pending") {
    exactKeys(value, ["status"], "terminal", diagnostics);
    return;
  }
  if (value.status !== "recorded") {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.status", "Terminal status must be pending or recorded.");
    return;
  }
  exactKeys(value, ["status", "executions", "effects"], "terminal", diagnostics);
  const terminalExecutions = Array.isArray(value.executions) ? value.executions : [];
  if (!Array.isArray(value.executions)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.executions", "Terminal executions must be an array.");
  }
  validateSortedUniqueNodes(terminalExecutions, "terminal.executions", diagnostics);
  if (terminalExecutions.length !== admissions.length) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "terminal.executions", "Terminal executions must cover every admitted execution exactly once.");
  }
  terminalExecutions.forEach((terminal, index) => {
    const path = `terminal.executions[${index}]`;
    if (!record(terminal)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Terminal execution must be an object.");
      return;
    }
    exactKeys(terminal, ["nodeId", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    nonEmpty(terminal.nodeId, `${path}.nodeId`, diagnostics);
    sha(terminal.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(terminal.receiptDigest, `${path}.receiptDigest`, diagnostics);
    for (const diagnostic of validateAiUsageTruthV2(terminal.usage).diagnostics) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.${diagnostic.path}`, diagnostic.message);
    }
    const admission = record(admissions[index]) ? admissions[index] : undefined;
    if (
      admission === undefined ||
      terminal.nodeId !== admission.nodeId ||
      !record(admission.binding) ||
      terminal.bindingDigest !== admission.binding.bindingDigest
    ) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Terminal execution does not match its admitted node and execution binding.");
      return;
    }
    validateTerminalUsageAgainstAdmission(terminal.usage, admission, path, diagnostics);
  });

  const effects = Array.isArray(value.effects) ? value.effects : [];
  if (!Array.isArray(value.effects)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.effects", "Terminal effects must be an array.");
  }
  validateSortedUniqueNodes(effects, "terminal.effects", diagnostics);
  effects.forEach((effect, index) => {
    const path = `terminal.effects[${index}]`;
    if (!record(effect)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Terminal effect must be an object.");
      return;
    }
    exactKeys(effect, ["nodeId", "intentDigest", "receiptDigest"], path, diagnostics);
    nonEmpty(effect.nodeId, `${path}.nodeId`, diagnostics);
    sha(effect.intentDigest, `${path}.intentDigest`, diagnostics);
    sha(effect.receiptDigest, `${path}.receiptDigest`, diagnostics);
    const intent = effectIntents.find(
      (candidate) => record(candidate) && candidate.nodeId === effect.nodeId
    );
    if (!record(intent) || intent.intentDigest !== effect.intentDigest) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Terminal effect does not match an admitted effect intent.");
    }
  });
}

function validateTerminalUsageAgainstAdmission(
  usage: unknown,
  admission: Record<string, unknown>,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(usage) || !record(usage.cost) || !record(admission.money)) return;
  const money = admission.money;
  if (money.status === "unknown") {
    if (usage.cost.status !== "unknown" || usage.cost.reason !== money.reason) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost`, "Terminal unknown money must preserve the admitted unknown reason.");
    }
  } else if (money.status === "priced" && record(money.reservation)) {
    if (
      usage.cost.status === "unknown" ||
      usage.cost.currency !== money.reservation.currency ||
      !Array.isArray(usage.cost.charges)
    ) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost`, "Priced admission requires authoritative terminal charge lines in the reserved currency.");
    } else {
      for (const charge of usage.cost.charges) {
        if (
          !record(charge) ||
          charge.offerRef !== money.reservation.offerRef ||
          charge.tariffRef !== money.reservation.tariffRef ||
          !canonicalEqual(charge.provenance, money.reservation.provenance)
        ) {
          add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost.charges`, "Terminal charge attribution does not match the admitted offer, tariff, or price authority.");
          break;
        }
      }
    }
  }
  if (!record(admission.quota)) return;
  if (admission.quota.status === "bound" && !record(usage.quota)) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", `${path}.usage.quota`, "Bound quota authority requires measured terminal quota truth.");
  }
  if (admission.quota.status === "not-applicable" && usage.quota !== undefined) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", `${path}.usage.quota`, "Quota truth cannot appear without an admitted quota authority.");
  }
}

function reservationCore(value: LoopEconomicsEvidenceInput | LoopEconomicsEvidenceV1) {
  return {
    schema: value.schema,
    canonicalization: value.canonicalization,
    owner: value.owner,
    executions: value.executions,
    effectIntents: value.effectIntents,
  };
}

function sumPricedReservations(executions: readonly unknown[]): number | undefined {
  let total = 0;
  for (const execution of executions) {
    if (!record(execution) || !record(execution.money) || execution.money.status !== "priced" || !record(execution.money.reservation)) {
      return undefined;
    }
    const amount = execution.money.reservation.reservedAmountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function sumTerminalCosts(terminal: unknown): number | undefined {
  if (!record(terminal) || terminal.status !== "recorded" || !Array.isArray(terminal.executions)) return undefined;
  let total = 0;
  for (const execution of terminal.executions) {
    if (!record(execution) || !record(execution.usage) || !record(execution.usage.cost) || execution.usage.cost.status === "unknown") {
      return undefined;
    }
    const amount = execution.usage.cost.amountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function validateSortedUniqueNodes(
  values: readonly unknown[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  let previous: string | undefined;
  values.forEach((value, index) => {
    const nodeId = record(value) && nonEmptyString(value.nodeId)
      ? value.nodeId
      : undefined;
    if (nodeId === undefined) return;
    if (previous !== undefined && nodeId <= previous) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}[${index}].nodeId`, "Node bindings must be unique and sorted by nodeId.");
    }
    previous = nodeId;
  });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.${key}`, "Unknown evidence field is not admitted.");
    }
  }
}

function add(
  diagnostics: LoopEconomicsEvidenceDiagnostic[],
  code: LoopEconomicsEvidenceDiagnosticCode,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}

function invalid(path: string, message: string): LoopEconomicsEvidenceValidation {
  return {
    valid: false,
    diagnostics: [{ code: "LOOP_ECONOMICS_INVALID", path, message }],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonEmpty(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!nonEmptyString(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be non-empty.");
  }
}

function sha(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(typeof value === "string" ? value : "")) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a lowercase SHA-256 digest.");
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!nonNegativeSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a non-negative safe integer.");
  }
}

function positiveSafeInteger(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!positiveSafeIntegerValue(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a positive safe integer.");
  }
}

function iso(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

function safeDigest(value: unknown): Sha256Digest | undefined {
  try {
    return digest(value);
  } catch {
    return undefined;
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftDigest = safeDigest(left);
  return leftDigest !== undefined && leftDigest === safeDigest(right);
}

function containsCycle(value: unknown): boolean {
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    if (active.has(candidate)) return true;
    if (visited.has(candidate)) return false;
    active.add(candidate);
    const children = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate);
    for (const child of children) {
      if (visit(child)) return true;
    }
    active.delete(candidate);
    visited.add(candidate);
    return false;
  };
  return visit(value);
}
