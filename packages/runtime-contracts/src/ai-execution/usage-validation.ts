import {
  AI_COST_UNKNOWN_REASONS,
  type AiCostUnknownReason,
  validateAiPriceProvenance,
  validateAiQuotaTruth,
} from "../ai-economics.js";
import {
  add,
  enumValue,
  isRecord,
  jsonEqual,
  nonEmpty,
  numberValue,
  positiveInteger,
  stringValue,
  sumTokens,
  validation,
} from "../ai-execution-validation-primitives.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionValidation,
  AiTokenUsage,
} from "../ai-execution-receipt-types.js";

/**
 * Validates standalone V2 usage truth without requiring callers to fabricate a
 * complete execution receipt. Durable schedulers use this when terminal
 * economics are retained separately from a result-bearing receipt.
 */
export function validateAiUsageTruthV2(
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  validateUsage(value, "usage", diagnostics);
  requirePricedChargeAttributions(value, "usage", diagnostics);
  return validation(diagnostics);
}

export function validateUsage(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value) || !isRecord(value.cost)) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      path,
      "Usage truth is required."
    );
    return;
  }
  enumValue(
    stringValue(value.measurement),
    ["unknown", "partial", "known"] as const,
    `${path}.measurement`,
    diagnostics
  );
  enumValue(
    stringValue(value.cost.status),
    ["unknown", "estimated", "reconciled"] as const,
    `${path}.cost.status`,
    diagnostics
  );
  validateUsageCostReason(value.cost, `${path}.cost`, diagnostics);
  validateUsageQuota(value.quota, `${path}.quota`, diagnostics);
  if (value.measurement === "unknown") {
    if (value.cost.status !== "unknown" || Object.hasOwn(value, "tokens")) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        path,
        "Unknown usage cannot carry token or monetary values."
      );
    }
    return;
  }
  if (isRecord(value.tokens)) {
    for (const [key, amount] of Object.entries(value.tokens)) {
      const numeric = numberValue(amount);
      if (!Number.isSafeInteger(numeric) || (numeric ?? -1) < 0) {
        add(
          diagnostics,
          "AI_USAGE_TRUTH_INVALID",
          `${path}.tokens.${key}`,
          "Token counts must be non-negative safe integers."
        );
      }
    }
  } else if (value.measurement === "known") {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.tokens`,
      "Known usage requires token measurements."
    );
  }
  if (value.cost.status !== "unknown") {
    if (!/^[A-Z]{3}$/.test(stringValue(value.cost.currency) ?? "")) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        `${path}.cost.currency`,
        "Cost currency must be an uppercase ISO-style code."
      );
    }
    const amountMicros = numberValue(value.cost.amountMicros);
    if (!Number.isSafeInteger(amountMicros) || (amountMicros ?? -1) < 0) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        `${path}.cost.amountMicros`,
        "Cost must use non-negative integer micro-units."
      );
    }
    if (value.cost.charges !== undefined) {
      validateChargeAttributions(
        value.cost.charges,
        `${path}.cost.charges`,
        amountMicros,
        diagnostics
      );
    }
  } else if (Object.hasOwn(value.cost, "charges")) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.cost.charges`,
      "Unknown cost cannot carry priced charge attributions."
    );
  }
  if (
    value.measurement === "partial" &&
    !isRecord(value.tokens) &&
    value.cost.status === "unknown" &&
    !isRecord(value.quota)
  ) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      path,
      "Partial usage requires at least one measured token, monetary, or quota value."
    );
  }
}

export function requirePricedChargeAttributions(
  usage: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  const cost = isRecord(usage) && isRecord(usage.cost) ? usage.cost : undefined;
  if (
    cost !== undefined &&
    cost.status !== "unknown" &&
    (!Array.isArray(cost.charges) || cost.charges.length === 0)
  ) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.cost.charges`,
      "V2 priced usage requires offer/tariff charge attribution."
    );
  }
  if (
    cost !== undefined &&
    (Object.hasOwn(cost, "tariffRef") || Object.hasOwn(cost, "provenance"))
  ) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.cost`,
      "V2 cost cannot use legacy unscoped tariffRef or provenance fields."
    );
  }
}

function validateChargeAttributions(
  value: unknown,
  path: string,
  expectedAmount: number | undefined,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Array.isArray(value) || value.length === 0) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      path,
      "Priced cost requires at least one offer/tariff charge attribution."
    );
    return;
  }
  let total = 0;
  value.forEach((candidate, index) => {
    const chargePath = `${path}[${index}]`;
    if (!isRecord(candidate)) {
      add(diagnostics, "AI_USAGE_TRUTH_INVALID", chargePath, "Charge attribution must be an object.");
      return;
    }
    positiveInteger(numberValue(candidate.attempt), `${chargePath}.attempt`, diagnostics);
    nonEmpty(stringValue(candidate.offerRef), `${chargePath}.offerRef`, diagnostics);
    nonEmpty(stringValue(candidate.tariffRef), `${chargePath}.tariffRef`, diagnostics);
    const amount = numberValue(candidate.amountMicros);
    if (amount === undefined || !Number.isSafeInteger(amount) || amount < 0) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        `${chargePath}.amountMicros`,
        "Charge attribution must use non-negative safe-integer micro-units."
      );
    } else {
      total += amount;
    }
    for (const diagnostic of validateAiPriceProvenance(
      candidate.provenance,
      `${chargePath}.provenance`
    )) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        diagnostic.path,
        diagnostic.message
      );
    }
  });
  if (!Number.isSafeInteger(total) || total !== expectedAmount) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      path,
      "Charge attributions must sum exactly to the priced amount."
    );
  }
}

/** An unknown-cost reason is optional, but an unrecognised one is a hard error. */

function validateUsageCostReason(
  cost: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(cost) || cost.reason === undefined) return;
  if (cost.status !== "unknown") {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.reason`,
      "Only an unknown cost may carry an unknown-reason."
    );
    return;
  }
  if (!AI_COST_UNKNOWN_REASONS.includes(cost.reason as AiCostUnknownReason)) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      `${path}.reason`,
      "Unknown cost reason is not a recognised value."
    );
  }
}

/**
 * Quota is validated by its own contract; its diagnostics are re-coded into the
 * usage namespace so a caller validating a receipt gets one diagnostic stream.
 */
function validateUsageQuota(
  quota: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (quota === undefined) return;
  for (const diagnostic of validateAiQuotaTruth(quota)) {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      diagnostic.path.replace(/^quota/, path),
      diagnostic.message
    );
  }
}

export function validateCanonicalUsageAlignment(
  canonical: unknown,
  usage: unknown,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(canonical)) return;
  if (!isRecord(usage) || usage.measurement === "unknown") {
    add(
      diagnostics,
      "AI_USAGE_RESULT_MISMATCH",
      "result.usage",
      "Canonical result usage cannot carry measured values when receipt usage is unknown."
    );
    return;
  }
  if (
    canonical.inputTokens !== undefined &&
    canonical.inputTokens !==
      (isRecord(usage.tokens) ? usage.tokens.input : undefined)
  ) {
    add(
      diagnostics,
      "AI_USAGE_RESULT_MISMATCH",
      "result.usage.inputTokens",
      "Canonical and receipt input-token usage differ."
    );
  }
  if (
    canonical.outputTokens !== undefined &&
    canonical.outputTokens !==
      (isRecord(usage.tokens) ? usage.tokens.output : undefined)
  ) {
    add(
      diagnostics,
      "AI_USAGE_RESULT_MISMATCH",
      "result.usage.outputTokens",
      "Canonical and receipt output-token usage differ."
    );
  }
  if (
    numberValue(canonical.costCents) !== undefined &&
    (!isRecord(usage.cost) ||
      usage.cost.status === "unknown" ||
      (numberValue(canonical.costCents) ?? 0) * 10_000 !==
        usage.cost.amountMicros)
  ) {
    add(
      diagnostics,
      "AI_USAGE_RESULT_MISMATCH",
      "result.usage.costCents",
      "Canonical and receipt monetary usage differ."
    );
  }
}

export function validateAttemptUsageAlignment(
  attempts: readonly unknown[],
  aggregate: unknown,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(aggregate)) return;
  const usage = attempts
    .map((attempt) => (isRecord(attempt) ? attempt.usage : undefined))
    .filter(isRecord);
  if (usage.length !== attempts.length || usage.length === 0) return;

  if (aggregate.measurement === "unknown") {
    if (usage.every((item) => item.measurement === "known")) {
      add(
        diagnostics,
        "AI_ATTEMPT_USAGE_MISMATCH",
        "usage",
        "Aggregate usage cannot be unknown when every attempt has known usage."
      );
    }
    return;
  }
  if (aggregate.measurement !== "known") return;
  if (
    !usage.every(
      (item) => item.measurement === "known" && isRecord(item.tokens)
    )
  ) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage",
      "Known aggregate usage requires known usage for every attempt."
    );
    return;
  }

  const expectedTokens = sumTokens(usage.map((item) => item.tokens));
  if (
    !isRecord(aggregate.tokens) ||
    !jsonEqual(expectedTokens, aggregate.tokens)
  ) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.tokens",
      "Aggregate token usage must equal the sum of attempt usage."
    );
  }

  if (!isRecord(aggregate.cost) || aggregate.cost.status === "unknown") return;
  const attemptCosts = usage.map((item) => item.cost).filter(isRecord);
  const currency = stringValue(aggregate.cost.currency);
  if (
    attemptCosts.length !== usage.length ||
    attemptCosts.some(
      (cost) =>
        cost.status === "unknown" ||
        cost.currency !== currency ||
        !Number.isSafeInteger(cost.amountMicros)
    )
  ) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.cost",
      "Measured aggregate cost requires compatible measured cost for every attempt."
    );
    return;
  }
  const amountMicros = attemptCosts.reduce(
    (total, cost) => total + (numberValue(cost.amountMicros) ?? 0),
    0
  );
  if (amountMicros !== numberValue(aggregate.cost.amountMicros)) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.cost.amountMicros",
      "Aggregate cost must equal the sum of attempt costs."
    );
  }
  const expectedCharges = attemptCosts.flatMap((cost) =>
    Array.isArray(cost.charges) ? cost.charges : []
  );
  if (
    (expectedCharges.length > 0 || Array.isArray(aggregate.cost.charges)) &&
    !jsonEqual(expectedCharges, aggregate.cost.charges)
  ) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.cost.charges",
      "Aggregate charge attributions must equal the ordered attempt charges."
    );
  }
}

/**
 * Every {@link AiTokenUsage} field {@link sumTokens} aggregates.
 *
 * Exhaustive by construction: the `satisfies` below fails to compile (TS1360)
 * naming the missing property if a field is added to `AiTokenUsage` and not
 * listed here. Without it the key list is just strings — a new field compiles
 * clean and is silently dropped from the sum. That has shipped repeatedly, and
 * here it is worse than a wrong total: the sole caller feeds
 * `AI_ATTEMPT_USAGE_MISMATCH`, so a dropped field turns into a false-positive
 * validation failure against any aggregator that *does* sum it.
 */
