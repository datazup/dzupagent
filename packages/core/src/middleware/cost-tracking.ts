/**
 * Cost tracking middleware — tracks LLM token usage per call.
 * The CostTracker interface is implemented by consumers (e.g., PrismaCostTracker).
 */
import type { TokenUsage } from "../llm/invoke.js";
import { MODEL_RATE_TABLE, getModelRate } from "./model-rates.js";

export type {
  ModelRate,
  ProviderRateKey,
  ModelRateKey,
} from "./model-rates.js";
export {
  getModelRate,
  MODEL_RATE_TABLE,
  PROVIDER_RATE_TABLE,
} from "./model-rates.js";

/** Abstract cost tracker — implemented by consumers */
export interface CostTracker {
  trackUsage(params: {
    tenantId: string;
    userId: string;
    usage: TokenUsage;
    context: string;
  }): Promise<void>;
}

/**
 * Calculate cost in cents for a given token usage.
 *
 * Every token class {@link TokenUsage} can report is priced. Cache-read and
 * cache-write tokens are billed at their own tiers when the model declares
 * them, and fall back to the base input rate otherwise — never to zero.
 * Omitting them under-reports spend on cache-heavy traffic, and cache *writes*
 * are the expensive case (claude: 375c/1M vs 300c/1M base input), so the
 * silent-drop failure mode under-counted precisely the costliest calls.
 */
export function calculateCostCents(usage: TokenUsage): number {
  const rate = getModelRate(usage.model);
  const perMillion = (tokens: number, centsPer1M: number): number =>
    (tokens / 1_000_000) * centsPer1M;

  const inputCost = perMillion(usage.inputTokens, rate.inputCentsPer1M);
  const outputCost = perMillion(usage.outputTokens, rate.outputCentsPer1M);
  const cacheReadCost = perMillion(
    usage.cacheReadTokens ?? 0,
    rate.cachedInputCentsPer1M ?? rate.inputCentsPer1M
  );
  const cacheWriteCost = perMillion(
    usage.cacheWriteTokens ?? 0,
    rate.cacheWriteCentsPer1M ?? rate.inputCentsPer1M
  );

  return Math.ceil(inputCost + outputCost + cacheReadCost + cacheWriteCost);
}

/**
 * Get known model pricing (cents per 1M input/output tokens).
 *
 * Backed by the canonical {@link MODEL_RATE_TABLE}. Returns `null` for models
 * with no explicit entry (the `default` fallback is intentionally not returned
 * here, preserving the historical "known models only" contract).
 */
export function getModelCosts(
  modelName: string
): { input: number; output: number } | null {
  const rate = (
    MODEL_RATE_TABLE as Record<
      string,
      { inputCentsPer1M: number; outputCentsPer1M: number }
    >
  )[modelName];
  return rate
    ? { input: rate.inputCentsPer1M, output: rate.outputCentsPer1M }
    : null;
}
