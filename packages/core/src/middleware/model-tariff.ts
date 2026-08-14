/**
 * Projects the canonical rate table (ARCH-M-08) into `AiTariff` contract values.
 *
 * `@dzupagent/runtime-contracts` defines what a priced call looks like, but ships
 * no prices; `model-rates.ts` holds the prices in a legacy unit
 * (cents per 1M tokens) that predates the contract. Without this adapter the
 * economics contracts have no data source at all, so nothing can be priced.
 *
 * Unit conversion is the whole point of this module:
 *   micros/token = centsPer1M x MICROS_PER_CENT / 1_000_000 = centsPer1M / 100
 * Results are deliberately **not** rounded. A rate like Gemini's 10 cents/1M is
 * 0.1 micros/token; rounding to an integer would price it at zero and bill real
 * traffic as free. The contract requires non-negative finite rates, not integers
 * — integers are only required of `amountMicros` totals, which round once at the
 * end of a cost computation rather than per-token here.
 */

import {
  AI_TARIFF_SCHEMA,
  MICROS_PER_CENT,
  canonicalInputDigest,
  type AiPriceProvenance,
  type AiTariff,
  type AiTokenRates,
} from "@dzupagent/runtime-contracts";

import {
  MODEL_RATES_AUTHORITY_ID,
  MODEL_RATES_EFFECTIVE_AT,
  MODEL_RATES_REVISION,
  MODEL_RATE_TABLE,
  PROVIDER_RATE_TABLE,
  getModelRate,
  hasKnownModelRate,
  type ModelRate,
} from "./model-rates.js";

/** Cents per 1M tokens is the table's unit; a tariff is micros per token. */
const CENTS_PER_1M_TO_MICROS_PER_TOKEN = MICROS_PER_CENT / 1_000_000;

/** ISO-4217 code for every rate in the canonical table. */
const MODEL_RATES_CURRENCY = "USD";

/** Converts one legacy cents-per-1M figure to contract micros-per-token. */
export function centsPer1MToMicrosPerToken(centsPer1M: number): number {
  return centsPer1M * CENTS_PER_1M_TO_MICROS_PER_TOKEN;
}

/**
 * Provenance for any rate read from the canonical table.
 *
 * The table is hand-maintained, so `sourceKind` is `hand-maintained` — a
 * provider-published price may later overwrite it, and reconciliation needs to
 * know that before it does.
 */
export function modelRatesProvenance(): AiPriceProvenance {
  return {
    sourceKind: "hand-maintained",
    authorityId: MODEL_RATES_AUTHORITY_ID,
    revision: MODEL_RATES_REVISION,
    effectiveAt: MODEL_RATES_EFFECTIVE_AT,
    digest: `sha256:${canonicalInputDigest({
      authorityId: MODEL_RATES_AUTHORITY_ID,
      revision: MODEL_RATES_REVISION,
      effectiveAt: MODEL_RATES_EFFECTIVE_AT,
      providerRates: PROVIDER_RATE_TABLE,
      modelRates: MODEL_RATE_TABLE,
    })}`,
  };
}

/** Projects a raw table entry into contract token rates. */
export function toAiTokenRates(rate: ModelRate): AiTokenRates {
  // Built conditionally: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not the same as an omitted optional rate.
  const rates: {
    inputMicrosPerToken: number;
    outputMicrosPerToken: number;
    cachedInputMicrosPerToken?: number;
    cacheWriteMicrosPerToken?: number;
  } = {
    inputMicrosPerToken: centsPer1MToMicrosPerToken(rate.inputCentsPer1M),
    outputMicrosPerToken: centsPer1MToMicrosPerToken(rate.outputCentsPer1M),
  };
  if (rate.cachedInputCentsPer1M !== undefined) {
    rates.cachedInputMicrosPerToken = centsPer1MToMicrosPerToken(
      rate.cachedInputCentsPer1M
    );
  }
  if (rate.cacheWriteCentsPer1M !== undefined) {
    rates.cacheWriteMicrosPerToken = centsPer1MToMicrosPerToken(
      rate.cacheWriteCentsPer1M
    );
  }
  return rates;
}

/**
 * Builds the `AiTariff` for a provider family or concrete model id.
 *
 * Resolution (including cache-tier inheritance for concrete model ids) is
 * delegated to {@link getModelRate}, so this never becomes a second pricing
 * authority — the failure mode ARCH-M-08 exists to prevent.
 *
 * @param providerOrModel - a provider family (`'claude'`) or model id
 *   (`'claude-sonnet-4-6'`). Unknown ids resolve to the table's default rate.
 * The exact execution offer and model revision are required from the caller;
 * this price authority cannot safely invent catalog identity from a model id.
 *
 * @example
 * buildModelTariff('claude-sonnet-4-6', {
 *   offerRef: 'offer/anthropic/sonnet/api',
 *   modelRef: 'model/claude-sonnet-4-6',
 *   modelRevision: 'catalog-42',
 * }).baseRates.inputMicrosPerToken // 3
 */
export function buildModelTariff(
  providerOrModel: string,
  options: {
    readonly offerRef: string;
    readonly modelRef: string;
    readonly modelRevision: string;
  }
): AiTariff {
  const rate = getModelRate(providerOrModel);
  return {
    schema: AI_TARIFF_SCHEMA,
    tariffId: `${MODEL_RATES_AUTHORITY_ID}@${MODEL_RATES_REVISION}:${options.offerRef}`,
    offerRef: options.offerRef,
    modelRef: options.modelRef,
    modelRevision: options.modelRevision,
    currency: MODEL_RATES_CURRENCY,
    baseRates: toAiTokenRates(rate),
    provenance: modelRatesProvenance(),
  };
}

/**
 * Like {@link buildModelTariff}, but `undefined` when the table does not know
 * the id rather than pricing it from the `default` fallback.
 *
 * Billing callers should prefer this. `buildModelTariff` always returns a
 * tariff, so an unrecognised model id yields a confident-looking price derived
 * from a generic default — and that number becomes the stored record of what
 * was spent. Reporting the cost as unknown is recoverable; a fabricated charge
 * is not distinguishable after the fact.
 *
 * @example
 * buildKnownModelTariff('claude-sonnet-4-6', binding) // AiTariff
 * buildKnownModelTariff('some-unlisted-model', binding) // undefined
 */
export function buildKnownModelTariff(
  providerOrModel: string,
  options: {
    readonly offerRef: string;
    readonly modelRef: string;
    readonly modelRevision: string;
  }
): AiTariff | undefined {
  if (!hasKnownModelRate(providerOrModel)) return undefined;
  // The one safe call site: the guard above has already established the table
  // knows this id, so the `default` fallback inside is unreachable from here.
  // This function IS the billing-safe wrapper the lint rule points callers to.
  // eslint-disable-next-line no-restricted-syntax
  return buildModelTariff(providerOrModel, options);
}
