/**
 * `@dzupagent/core/middleware` — stable subpath for cost/rate middleware API.
 *
 * Hosts the canonical model/provider pricing surface (ARCH-M-08) so downstream
 * packages (`@dzupagent/agent-adapters`, etc.) can consume a single source of
 * truth for token/cost rates without widening the growth-frozen root barrel.
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
