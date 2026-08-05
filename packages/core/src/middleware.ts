/**
 * `@dzupagent/core/middleware` — stable subpath for cost/rate middleware API.
 *
 * Hosts the canonical model/provider pricing surface (ARCH-M-08) so downstream
 * packages (`@dzupagent/agent-adapters`, etc.) can consume a single source of
 * truth for token/cost rates without widening the growth-frozen root barrel.
 *
 * This is the ONLY published home for the rate/tariff cluster. The C3 slices
 * briefly re-exported it from `src/index.ts` too, which broke three barrel
 * budgets at once; `./middleware/` is a *transitional* root rule in
 * config/public-api-allowlists.json, so new pricing API must land here rather
 * than on the root. Pinned by `__tests__/model-pricing-subpath.test.ts`.
 *
 * @module core/middleware
 */

export {
  calculateCostCents,
  getModelCosts,
  getModelRate,
  MODEL_RATE_TABLE,
  PROVIDER_RATE_TABLE,
} from "./middleware/cost-tracking.js";
export type {
  CostTracker,
  ModelRate,
  ProviderRateKey,
  ModelRateKey,
} from "./middleware/cost-tracking.js";
export {
  MODEL_RATES_AUTHORITY_ID,
  MODEL_RATES_EFFECTIVE_AT,
  MODEL_RATES_REVISION,
  hasKnownModelRate,
} from "./middleware/model-rates.js";
export {
  buildKnownModelTariff,
  buildModelTariff,
  centsPer1MToMicrosPerToken,
  modelRatesProvenance,
  toAiTokenRates,
} from "./middleware/model-tariff.js";
