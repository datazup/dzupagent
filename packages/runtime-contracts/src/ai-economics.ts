/**
 * Canonical execution economics: tariffs, quotas, and price provenance.
 *
 * Money and quota are separate truths. A subscription-billed call can consume a
 * real quota unit while its monetary charge stays permanently unknown, so a
 * shape that forces money to stand in for cost cannot describe it. Both are
 * therefore modelled as independent, explicitly-unknown-capable states.
 *
 * All monetary amounts are integer micro-units of the stated currency
 * (1 cent = 10_000 micros), matching `AiCostTruth.amountMicros`. Float cents
 * appear widely in older call sites; conversion belongs at those boundaries,
 * never inside a contract value.
 */

export const AI_TARIFF_SCHEMA = "dzupagent.aiTariff/v1" as const;
export const AI_QUOTA_SCHEMA = "dzupagent.aiQuota/v1" as const;

/** Micro-units per cent, for boundary conversion at legacy float-cent call sites. */
export const MICROS_PER_CENT = 10_000 as const;

/**
 * Where a price came from. Reconciliation requires knowing whether a number was
 * hand-maintained, provider-published, or inferred, because only some sources
 * may overwrite others.
 */
export const AI_PRICE_SOURCE_KINDS = [
  "hand-maintained",
  "provider-published",
  "contract-negotiated",
  "inferred",
] as const;
export type AiPriceSourceKind = (typeof AI_PRICE_SOURCE_KINDS)[number];

/**
 * Identifies the authority a rate was read from and pins the exact revision, so
 * two tables that disagree can be compared without guessing which was current.
 */
export interface AiPriceProvenance {
  readonly sourceKind: AiPriceSourceKind;
  /** Stable authority id, e.g. "dzupagent.core/model-rates" (ARCH-M-08). */
  readonly authorityId: string;
  readonly revision: string;
  /** When the authority last changed this rate, not when it was read. */
  readonly effectiveAt: string;
  /** Absent means the rate does not self-expire. */
  readonly expiresAt?: string;
  readonly digest?: `sha256:${string}`;
}

/**
 * Per-token rates. Cached input and cache writes are priced separately because
 * providers bill them at different multiples of the base input rate; folding
 * them into `input` silently overcharges cached traffic.
 */
export interface AiTokenRates {
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly cachedInputMicrosPerToken?: number;
  readonly cacheWriteMicrosPerToken?: number;
  readonly reasoningMicrosPerToken?: number;
}

/**
 * A tier applies above a token threshold. Long-context models re-price the whole
 * request once it crosses a boundary, so a tier carries a full rate set rather
 * than a multiplier.
 */
export interface AiTariffTier {
  /** Inclusive lower bound, in total input tokens, at which this tier applies. */
  readonly fromInputTokens: number;
  readonly rates: AiTokenRates;
}

/**
 * The complete price of one model at one point in time.
 *
 * `tiers` must be sorted ascending by `fromInputTokens` and must not repeat a
 * threshold; a request selects the highest tier whose bound it meets, falling
 * back to `baseRates`.
 */
export interface AiTariff {
  readonly schema: typeof AI_TARIFF_SCHEMA;
  readonly tariffId: string;
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly baseRates: AiTokenRates;
  readonly tiers?: readonly AiTariffTier[];
  readonly provenance: AiPriceProvenance;
}

/** Non-monetary consumption units. Subscription plans meter these, not money. */
export const AI_QUOTA_UNITS = [
  "requests",
  "tokens",
  "seconds",
  "credits",
] as const;
export type AiQuotaUnit = (typeof AI_QUOTA_UNITS)[number];

/**
 * Observed quota consumption. `limit`/`remaining` are optional because most
 * providers report consumption without ever disclosing the ceiling.
 */
export interface AiQuotaTruth {
  readonly schema: typeof AI_QUOTA_SCHEMA;
  readonly unit: AiQuotaUnit;
  readonly consumed: number;
  readonly limit?: number;
  readonly remaining?: number;
  /** Plan or bucket the quota was drawn from, when the provider names one. */
  readonly poolRef?: string;
  readonly observedAt: string;
}

/**
 * Why a monetary amount is unavailable. Collapsing these into a single "unknown"
 * loses the distinction between "billed, but not to us in money" (subscription)
 * and "we have no rate for this model" (no-tariff) — which need different
 * operator responses.
 */
export const AI_COST_UNKNOWN_REASONS = [
  "subscription",
  "no-tariff",
  "tariff-expired",
  "provider-silent",
  "unmetered",
] as const;
export type AiCostUnknownReason = (typeof AI_COST_UNKNOWN_REASONS)[number];

export type AiEconomicsDiagnosticCode =
  | "AI_TARIFF_INVALID"
  | "AI_TARIFF_TIER_ORDER"
  | "AI_TARIFF_EXPIRED"
  | "AI_QUOTA_INVALID"
  | "AI_PRICE_PROVENANCE_INVALID";

export interface AiEconomicsDiagnostic {
  readonly code: AiEconomicsDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function add(
  diagnostics: AiEconomicsDiagnostic[],
  code: AiEconomicsDiagnosticCode,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}

/** Rates must be non-negative finite numbers; zero is legitimate (free tiers). */
function validateTokenRates(
  value: unknown,
  path: string,
  diagnostics: AiEconomicsDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_TARIFF_INVALID", path, "Rates must be an object.");
    return;
  }
  for (const key of ["inputMicrosPerToken", "outputMicrosPerToken"] as const) {
    const rate = numberValue(value[key]);
    if (rate === undefined || rate < 0) {
      add(
        diagnostics,
        "AI_TARIFF_INVALID",
        `${path}.${key}`,
        "Required rate must be a non-negative finite number."
      );
    }
  }
  for (const key of [
    "cachedInputMicrosPerToken",
    "cacheWriteMicrosPerToken",
    "reasoningMicrosPerToken",
  ] as const) {
    if (value[key] === undefined) continue;
    const rate = numberValue(value[key]);
    if (rate === undefined || rate < 0) {
      add(
        diagnostics,
        "AI_TARIFF_INVALID",
        `${path}.${key}`,
        "Optional rate must be a non-negative finite number when present."
      );
    }
  }
}

function validateProvenance(
  value: unknown,
  path: string,
  diagnostics: AiEconomicsDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_PRICE_PROVENANCE_INVALID",
      path,
      "Provenance is required."
    );
    return;
  }
  if (!AI_PRICE_SOURCE_KINDS.includes(value.sourceKind as AiPriceSourceKind)) {
    add(
      diagnostics,
      "AI_PRICE_PROVENANCE_INVALID",
      `${path}.sourceKind`,
      "Unknown price source kind."
    );
  }
  for (const key of ["authorityId", "revision", "effectiveAt"] as const) {
    if (stringValue(value[key]) === undefined) {
      add(
        diagnostics,
        "AI_PRICE_PROVENANCE_INVALID",
        `${path}.${key}`,
        "Provenance field is required and must be non-empty."
      );
    }
  }
  const effectiveAt = stringValue(value.effectiveAt);
  const expiresAt = stringValue(value.expiresAt);
  if (
    effectiveAt !== undefined &&
    expiresAt !== undefined &&
    expiresAt <= effectiveAt
  ) {
    add(
      diagnostics,
      "AI_PRICE_PROVENANCE_INVALID",
      `${path}.expiresAt`,
      "Expiry must be after the effective time."
    );
  }
}

/**
 * Validates a tariff. Pass `at` (an ISO instant) to also assert the tariff is
 * live then — expiry is reported as its own code so a stale rate is
 * distinguishable from a malformed one.
 */
export function validateAiTariff(
  value: unknown,
  options: { readonly at?: string } = {}
): readonly AiEconomicsDiagnostic[] {
  const diagnostics: AiEconomicsDiagnostic[] = [];
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_TARIFF_INVALID",
      "tariff",
      "Tariff must be an object."
    );
    return diagnostics;
  }
  if (value.schema !== AI_TARIFF_SCHEMA) {
    add(
      diagnostics,
      "AI_TARIFF_INVALID",
      "tariff.schema",
      `Tariff schema must be ${AI_TARIFF_SCHEMA}.`
    );
  }
  for (const key of ["tariffId", "provider", "model"] as const) {
    if (stringValue(value[key]) === undefined) {
      add(
        diagnostics,
        "AI_TARIFF_INVALID",
        `tariff.${key}`,
        "Field is required and must be non-empty."
      );
    }
  }
  if (!/^[A-Z]{3}$/.test(stringValue(value.currency) ?? "")) {
    add(
      diagnostics,
      "AI_TARIFF_INVALID",
      "tariff.currency",
      "Currency must be an uppercase ISO-style code."
    );
  }
  validateTokenRates(value.baseRates, "tariff.baseRates", diagnostics);
  validateProvenance(value.provenance, "tariff.provenance", diagnostics);

  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) {
      add(
        diagnostics,
        "AI_TARIFF_INVALID",
        "tariff.tiers",
        "Tiers must be an array when present."
      );
    } else {
      let previousBound: number | undefined;
      value.tiers.forEach((tier, index) => {
        const tierPath = `tariff.tiers[${index}]`;
        if (!isRecord(tier)) {
          add(
            diagnostics,
            "AI_TARIFF_INVALID",
            tierPath,
            "Tier must be an object."
          );
          return;
        }
        const bound = numberValue(tier.fromInputTokens);
        if (bound === undefined || !Number.isSafeInteger(bound) || bound < 0) {
          add(
            diagnostics,
            "AI_TARIFF_INVALID",
            `${tierPath}.fromInputTokens`,
            "Tier bound must be a non-negative safe integer."
          );
        } else if (previousBound !== undefined && bound <= previousBound) {
          add(
            diagnostics,
            "AI_TARIFF_TIER_ORDER",
            `${tierPath}.fromInputTokens`,
            "Tiers must ascend strictly by input-token bound."
          );
        } else {
          previousBound = bound;
        }
        validateTokenRates(tier.rates, `${tierPath}.rates`, diagnostics);
      });
    }
  }

  const at = stringValue(options.at);
  const expiresAt = isRecord(value.provenance)
    ? stringValue(value.provenance.expiresAt)
    : undefined;
  if (at !== undefined && expiresAt !== undefined && expiresAt <= at) {
    add(
      diagnostics,
      "AI_TARIFF_EXPIRED",
      "tariff.provenance.expiresAt",
      "Tariff expired before the evaluated instant."
    );
  }
  return diagnostics;
}

export function validateAiQuotaTruth(
  value: unknown
): readonly AiEconomicsDiagnostic[] {
  const diagnostics: AiEconomicsDiagnostic[] = [];
  if (!isRecord(value)) {
    add(diagnostics, "AI_QUOTA_INVALID", "quota", "Quota must be an object.");
    return diagnostics;
  }
  if (value.schema !== AI_QUOTA_SCHEMA) {
    add(
      diagnostics,
      "AI_QUOTA_INVALID",
      "quota.schema",
      `Quota schema must be ${AI_QUOTA_SCHEMA}.`
    );
  }
  if (!AI_QUOTA_UNITS.includes(value.unit as AiQuotaUnit)) {
    add(diagnostics, "AI_QUOTA_INVALID", "quota.unit", "Unknown quota unit.");
  }
  const consumed = numberValue(value.consumed);
  if (consumed === undefined || consumed < 0) {
    add(
      diagnostics,
      "AI_QUOTA_INVALID",
      "quota.consumed",
      "Consumed must be a non-negative finite number."
    );
  }
  for (const key of ["limit", "remaining"] as const) {
    if (value[key] === undefined) continue;
    const amount = numberValue(value[key]);
    if (amount === undefined || amount < 0) {
      add(
        diagnostics,
        "AI_QUOTA_INVALID",
        `quota.${key}`,
        "Value must be a non-negative finite number when present."
      );
    }
  }
  const limit = numberValue(value.limit);
  const remaining = numberValue(value.remaining);
  if (limit !== undefined && remaining !== undefined && remaining > limit) {
    add(
      diagnostics,
      "AI_QUOTA_INVALID",
      "quota.remaining",
      "Remaining cannot exceed the limit."
    );
  }
  if (stringValue(value.observedAt) === undefined) {
    add(
      diagnostics,
      "AI_QUOTA_INVALID",
      "quota.observedAt",
      "Observation time is required."
    );
  }
  return diagnostics;
}

/** Selects the tier governing a request, or the base rates when none applies. */
export function selectTariffRates(
  tariff: AiTariff,
  inputTokens: number
): AiTokenRates {
  if (!tariff.tiers || tariff.tiers.length === 0) return tariff.baseRates;
  let selected = tariff.baseRates;
  for (const tier of tariff.tiers) {
    if (inputTokens >= tier.fromInputTokens) selected = tier.rates;
    else break;
  }
  return selected;
}
