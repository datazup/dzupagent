import {
  validateAiTariff,
  type AiPriceProvenance,
  type AiTariff,
  type AiTokenRates,
} from "./ai-economics.js";

export const AI_BUDGET_RESERVATION_SCHEMA =
  "dzupagent.aiBudgetReservation/v1" as const;

/** Upper bounds used to reserve money before dispatch. */
export interface AiUsageCeiling {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface AiHardMoneyCeiling {
  readonly currency: string;
  readonly maxAmountMicros: number;
}

export interface AiBudgetReservationRequest {
  readonly tariff: AiTariff;
  readonly usageCeiling: AiUsageCeiling;
  readonly hardCeiling: AiHardMoneyCeiling;
  readonly reservedAt: string;
}

export const AI_BUDGET_RESERVATION_REJECTION_REASONS = [
  "tariff-invalid",
  "tariff-expired",
  "currency-mismatch",
  "usage-ceiling-invalid",
  "rate-unavailable",
  "amount-overflow",
  "ceiling-exceeded",
] as const;

export type AiBudgetReservationRejectionReason =
  (typeof AI_BUDGET_RESERVATION_REJECTION_REASONS)[number];

export interface AiBudgetReservation {
  readonly schema: typeof AI_BUDGET_RESERVATION_SCHEMA;
  readonly status: "admitted";
  readonly tariffRef: string;
  readonly offerRef: string;
  readonly modelRef: string;
  readonly modelRevision: string;
  readonly provenance: AiPriceProvenance;
  readonly currency: string;
  readonly reservedAmountMicros: number;
  readonly usageCeiling: AiUsageCeiling;
  readonly reservedAt: string;
}

export type AiBudgetReservationDecision =
  | AiBudgetReservation
  | {
      readonly schema: typeof AI_BUDGET_RESERVATION_SCHEMA;
      readonly status: "rejected";
      readonly reason: AiBudgetReservationRejectionReason;
      readonly message: string;
    };

/**
 * Computes a conservative pre-dispatch money reservation. Missing optional
 * rates are not interpreted as zero: a non-zero bounded usage class without a
 * rate rejects admission. All arithmetic must remain in safe integer micros.
 */
export function reserveAiBudget(
  request: AiBudgetReservationRequest
): AiBudgetReservationDecision {
  const tariffDiagnostics = validateAiTariff(request.tariff, {
    at: request.reservedAt,
  });
  if (tariffDiagnostics.length > 0) {
    const expired = tariffDiagnostics.some(
      (diagnostic) => diagnostic.code === "AI_TARIFF_EXPIRED"
    );
    return rejected(
      expired ? "tariff-expired" : "tariff-invalid",
      tariffDiagnostics.map((diagnostic) => diagnostic.message).join(" ")
    );
  }
  if (
    !/^[A-Z]{3}$/.test(request.hardCeiling.currency) ||
    request.hardCeiling.currency !== request.tariff.currency
  ) {
    return rejected(
      "currency-mismatch",
      "Hard-ceiling currency must match the tariff currency."
    );
  }
  if (!nonNegativeSafeInteger(request.hardCeiling.maxAmountMicros)) {
    return rejected(
      "usage-ceiling-invalid",
      "Hard money ceiling must be a non-negative safe integer in micro-units."
    );
  }
  const usage = normalizeUsageCeiling(request.usageCeiling);
  if (usage === null) {
    return rejected(
      "usage-ceiling-invalid",
      "Every usage ceiling must be a non-negative safe integer."
    );
  }
  const totalInput = safeSum([
    usage.uncachedInputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
  ]);
  if (totalInput === null) {
    return rejected("amount-overflow", "Input-token ceiling exceeds safe integer bounds.");
  }
  const rates = selectRatesForInput(request.tariff, totalInput);
  const priced = priceUsageCeiling(usage, rates);
  if (priced.status === "rate-unavailable") {
    return rejected(
      "rate-unavailable",
      `A non-zero ${priced.usageClass} ceiling has no bound tariff rate.`
    );
  }
  if (priced.status === "amount-overflow") {
    return rejected(
      "amount-overflow",
      "Conservative reservation exceeds safe integer micro-unit bounds."
    );
  }
  if (priced.amountMicros > request.hardCeiling.maxAmountMicros) {
    return rejected(
      "ceiling-exceeded",
      "Conservative reservation exceeds the hard money ceiling."
    );
  }
  return {
    schema: AI_BUDGET_RESERVATION_SCHEMA,
    status: "admitted",
    tariffRef: request.tariff.tariffId,
    offerRef: request.tariff.offerRef,
    modelRef: request.tariff.modelRef,
    modelRevision: request.tariff.modelRevision,
    provenance: request.tariff.provenance,
    currency: request.tariff.currency,
    reservedAmountMicros: priced.amountMicros,
    usageCeiling: request.usageCeiling,
    reservedAt: request.reservedAt,
  };
}

function selectRatesForInput(tariff: AiTariff, inputTokens: number): AiTokenRates {
  let selected = tariff.baseRates;
  for (const tier of tariff.tiers ?? []) {
    if (inputTokens >= tier.fromInputTokens) selected = tier.rates;
    else break;
  }
  return selected;
}

interface NormalizedUsageCeiling {
  uncachedInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

function normalizeUsageCeiling(
  value: AiUsageCeiling
): NormalizedUsageCeiling | null {
  const normalized = {
    uncachedInputTokens: value.uncachedInputTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens ?? 0,
    cacheWriteTokens: value.cacheWriteTokens ?? 0,
    reasoningTokens: value.reasoningTokens ?? 0,
  };
  return Object.values(normalized).every(nonNegativeSafeInteger)
    ? normalized
    : null;
}

function priceUsageCeiling(
  usage: NormalizedUsageCeiling,
  rates: AiTokenRates
):
  | { status: "priced"; amountMicros: number }
  | { status: "rate-unavailable"; usageClass: string }
  | { status: "amount-overflow" } {
  const classes = [
    ["uncached input", usage.uncachedInputTokens, rates.inputMicrosPerToken],
    ["output", usage.outputTokens, rates.outputMicrosPerToken],
    ["cached input", usage.cachedInputTokens, rates.cachedInputMicrosPerToken],
    ["cache write", usage.cacheWriteTokens, rates.cacheWriteMicrosPerToken],
    ["reasoning", usage.reasoningTokens, rates.reasoningMicrosPerToken],
  ] as const;
  const amounts: number[] = [];
  for (const [usageClass, tokens, rate] of classes) {
    if (tokens === 0) continue;
    if (rate === undefined) return { status: "rate-unavailable", usageClass };
    const amount = safeMultiply(tokens, rate);
    if (amount === null) return { status: "amount-overflow" };
    amounts.push(amount);
  }
  const amountMicros = safeSum(amounts);
  return amountMicros === null
    ? { status: "amount-overflow" }
    : { status: "priced", amountMicros };
}

function safeMultiply(left: number, right: number): number | null {
  const result = Math.ceil(left * right);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function rejected(
  reason: AiBudgetReservationRejectionReason,
  message: string
): AiBudgetReservationDecision {
  return {
    schema: AI_BUDGET_RESERVATION_SCHEMA,
    status: "rejected",
    reason,
    message,
  };
}
