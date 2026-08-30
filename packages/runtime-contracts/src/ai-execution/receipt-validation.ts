import {
  add,
  enumValue,
  isIsoDate,
  isRecord,
  jsonEqual,
  nonEmpty,
  numberValue,
  positiveInteger,
  stringValue,
  validateOptionalTime,
  validation,
} from "../ai-execution-validation-primitives.js";
import {
  AI_EXECUTION_OPERATION_KINDS,
  AI_EXECUTION_RECEIPT_SCHEMA,
  AI_EXECUTION_RECEIPT_V2_SCHEMA,
} from "../ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionValidation,
} from "../ai-execution-receipt-types.js";
import {
  validateTargetSelector,
  validateTargetSnapshot,
} from "./target-validation.js";
import {
  validateExecutionBinding,
} from "./binding-validation.js";
import {
  requirePricedChargeAttributions,
  validateAttemptUsageAlignment,
  validateCanonicalUsageAlignment,
  validateUsage,
} from "./usage-validation.js";
import {
  validateAiExecutionEventSequence,
} from "./event-validation.js";

export function validateAiExecutionReceipt(
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "$",
      "AI execution receipt must be an object."
    );
    return validation(diagnostics);
  }
  const isV2 = value.schema === AI_EXECUTION_RECEIPT_V2_SCHEMA;
  if (value.schema !== AI_EXECUTION_RECEIPT_SCHEMA && !isV2) {
    add(
      diagnostics,
      "AI_INVALID_SCHEMA",
      "schema",
      "Unsupported AI execution receipt schema."
    );
  }
  nonEmpty(stringValue(value.requestId), "requestId", diagnostics);
  nonEmpty(stringValue(value.correlationId), "correlationId", diagnostics);
  enumValue(
    stringValue(value.operation),
    AI_EXECUTION_OPERATION_KINDS,
    "operation",
    diagnostics
  );
  validateTargetSelector(value.requestedTarget, "requestedTarget", diagnostics);
  validateTargetSnapshot(value.target, "target", diagnostics);
  if (isV2) {
    validateExecutionBinding(value.binding, "binding", diagnostics);
    validateBindingTargetAlias(value.binding, value.target, "binding", diagnostics);
  }
  const requestedTarget = isRecord(value.requestedTarget)
    ? value.requestedTarget
    : undefined;
  const target = isRecord(value.target) ? value.target : undefined;
  if (
    requestedTarget?.kind === "target-id" &&
    requestedTarget.targetId !== target?.targetId
  ) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "target.targetId",
      "Resolved target differs from the requested logical target."
    );
  }
  if (target?.operation !== value.operation) {
    add(
      diagnostics,
      "AI_OPERATION_KIND_MISMATCH",
      "target.operation",
      "Resolved target operation must match the receipt operation."
    );
  }
  if (!Array.isArray(value.attempts) || value.attempts.length === 0) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "attempts",
      "An execution receipt requires at least one attempt."
    );
  }
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  attempts.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      add(
        diagnostics,
        "AI_INVALID_VALUE",
        `attempts[${index}]`,
        "Execution attempt must be an object."
      );
      return;
    }
    const attempt = candidate;
    if (attempt.attempt !== index + 1) {
      add(
        diagnostics,
        "AI_ATTEMPT_SEQUENCE_INVALID",
        `attempts[${index}].attempt`,
        "Attempts must be contiguous and one-based."
      );
    }
    validateTargetSnapshot(
      attempt.target,
      `attempts[${index}].target`,
      diagnostics
    );
    if (isV2) {
      validateExecutionBinding(
        attempt.binding,
        `attempts[${index}].binding`,
        diagnostics
      );
      validateBindingTargetAlias(
        attempt.binding,
        attempt.target,
        `attempts[${index}].binding`,
        diagnostics
      );
    }
    const attemptTarget = isRecord(attempt.target) ? attempt.target : undefined;
    if (attemptTarget?.operation !== value.operation) {
      add(
        diagnostics,
        "AI_OPERATION_KIND_MISMATCH",
        `attempts[${index}].target.operation`,
        "Attempt target operation must match the receipt operation."
      );
    }
    validateUsage(attempt.usage, `attempts[${index}].usage`, diagnostics);
    if (isV2) {
      requirePricedChargeAttributions(
        attempt.usage,
        `attempts[${index}].usage`,
        diagnostics
      );
    }
    validateOptionalTime(
      stringValue(attempt.startedAt),
      `attempts[${index}].startedAt`,
      diagnostics
    );
    validateOptionalTime(
      stringValue(attempt.completedAt),
      `attempts[${index}].completedAt`,
      diagnostics
    );
    validateDispatch(
      attempt.dispatch,
      `attempts[${index}].dispatch`,
      diagnostics
    );
  });
  const lastAttempt = attempts.at(-1);
  const lastTarget =
    isRecord(lastAttempt) && isRecord(lastAttempt.target)
      ? lastAttempt.target
      : undefined;
  if (
    attempts.length > 0 &&
    lastTarget?.snapshotDigest !== target?.snapshotDigest
  ) {
    add(
      diagnostics,
      "AI_TARGET_SNAPSHOT_INVALID",
      "target.snapshotDigest",
      "Receipt target must be the final attempt target snapshot."
    );
  }
  if (isV2) {
    const receiptBinding = isRecord(value.binding) ? value.binding : undefined;
    const lastBinding =
      isRecord(lastAttempt) && isRecord(lastAttempt.binding)
        ? lastAttempt.binding
        : undefined;
    if (
      lastBinding?.bindingDigest !== receiptBinding?.bindingDigest
    ) {
      add(
        diagnostics,
        "AI_EXECUTION_BINDING_MISMATCH",
        "binding.bindingDigest",
        "Receipt binding must be the final attempt binding."
      );
    }
  }
  const result = isRecord(value.result) ? value.result : undefined;
  if (result?.requestId !== value.requestId) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "result.requestId",
      "Result requestId differs from the receipt."
    );
  }
  if (result?.correlationId !== value.correlationId) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "result.correlationId",
      "Result correlationId differs from the receipt."
    );
  }
  const routeDecision = isRecord(result?.routeDecision)
    ? result.routeDecision
    : undefined;
  if (routeDecision?.selectedCandidateId !== target?.routeCandidateId) {
    add(
      diagnostics,
      "AI_ROUTE_TARGET_MISMATCH",
      "target.routeCandidateId",
      "Receipt target must match the canonical route decision."
    );
  }
  if (isV2) {
    validateResultBinding(value.binding, routeDecision, diagnostics);
    validateAttemptChargeBindings(attempts, diagnostics);
  }
  validateUsage(value.usage, "usage", diagnostics);
  if (isV2) {
    requirePricedChargeAttributions(value.usage, "usage", diagnostics);
  }
  validateCanonicalUsageAlignment(result?.usage, value.usage, diagnostics);
  validateAttemptUsageAlignment(attempts, value.usage, diagnostics);
  positiveInteger(
    numberValue(value.terminalEventSequence),
    "terminalEventSequence",
    diagnostics
  );
  if (!isIsoDate(stringValue(value.completedAt))) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "completedAt",
      "Receipt completion time must be ISO-8601."
    );
  }
  if (
    result?.status === "succeeded" &&
    (!isRecord(lastAttempt) ||
      !isRecord(lastAttempt.dispatch) ||
      lastAttempt.dispatch.status !== "terminal")
  ) {
    add(
      diagnostics,
      "AI_RESULT_STATUS_MISMATCH",
      "attempts",
      "A successful result requires a terminal final dispatch attempt."
    );
  }
  return validation(diagnostics);
}

/** Validates one retained event transcript against its terminal receipt. */

export function validateAiExecutionTranscript(
  receipt: unknown,
  events: unknown
): AiExecutionValidation {
  const diagnostics = [
    ...validateAiExecutionReceipt(receipt).diagnostics,
    ...validateAiExecutionEventSequence(events).diagnostics,
  ];
  if (!isRecord(receipt) || !Array.isArray(events) || events.length === 0) {
    return validation(diagnostics);
  }
  const terminal = isRecord(events.at(-1)) ? events.at(-1) : undefined;
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  if (
    terminal?.requestId !== receipt.requestId ||
    terminal?.correlationId !== receipt.correlationId
  ) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "events",
      "Transcript and receipt identities must match."
    );
  }
  if (terminal?.sequence !== receipt.terminalEventSequence) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "terminalEventSequence",
      "Receipt terminal sequence must match the final event."
    );
  }
  if (terminal?.type !== "completed" || terminal.status !== result?.status) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "events",
      "Final event status must match the canonical result status."
    );
  }
  const latestUsage = [...events]
    .reverse()
    .find((event) => isRecord(event) && event.type === "usage");
  if (
    isRecord(latestUsage) &&
    isRecord(receipt.usage) &&
    !jsonEqual(latestUsage.usage, receipt.usage)
  ) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "usage",
      "Latest transcript usage truth must match the terminal receipt."
    );
  }
  return validation(diagnostics);
}

function validateBindingTargetAlias(
  binding: unknown,
  target: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(binding) || !jsonEqual(binding.target, target)) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_MISMATCH",
      `${path}.target`,
      "Binding target and receipt target alias must be identical."
    );
  }
}

function validateResultBinding(
  binding: unknown,
  routeDecision: Record<string, unknown> | undefined,
  diagnostics: AiExecutionDiagnostic[]
): void {
  const route = isRecord(binding) && isRecord(binding.routeDecision)
    ? binding.routeDecision
    : undefined;
  if (
    route === undefined ||
    routeDecision === undefined ||
    route.decisionId !== routeDecision.id ||
    route.policyId !== routeDecision.policyId ||
    route.selectedCandidateId !== routeDecision.selectedCandidateId
  ) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_MISMATCH",
      "binding.routeDecision",
      "Receipt binding must identify the canonical result route decision."
    );
  }
}

function validateAttemptChargeBindings(
  attempts: readonly unknown[],
  diagnostics: AiExecutionDiagnostic[]
): void {
  attempts.forEach((candidate, index) => {
    if (!isRecord(candidate) || !isRecord(candidate.binding)) return;
    const offer = isRecord(candidate.binding.offer)
      ? candidate.binding.offer
      : undefined;
    const usage = isRecord(candidate.usage) ? candidate.usage : undefined;
    const cost = isRecord(usage?.cost) ? usage.cost : undefined;
    if (cost?.status === "unknown" || !Array.isArray(cost?.charges)) return;
    cost.charges.forEach((charge, chargeIndex) => {
      if (!isRecord(charge)) return;
      if (
        charge.attempt !== candidate.attempt ||
        charge.offerRef !== offer?.offerId ||
        offer?.tariffRef === undefined ||
        charge.tariffRef !== offer.tariffRef
      ) {
        add(
          diagnostics,
          "AI_CHARGE_BINDING_MISMATCH",
          `attempts[${index}].usage.cost.charges[${chargeIndex}]`,
          "Charge attribution must match its attempt, admitted offer, and offer tariff."
        );
      }
    });
  });
}

function validateDispatch(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "Dispatch outcome must be an object."
    );
    return;
  }
  enumValue(
    stringValue(value.status),
    ["not-dispatched", "accepted", "terminal", "outcome-unknown"] as const,
    `${path}.status`,
    diagnostics
  );
  if (value.idempotencyKey !== undefined) {
    nonEmpty(
      stringValue(value.idempotencyKey),
      `${path}.idempotencyKey`,
      diagnostics
    );
  }
}
