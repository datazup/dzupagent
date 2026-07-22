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
 */
export function calculateCostCents(usage: TokenUsage): number {
  const rate = getModelRate(usage.model);
  const inputCost = (usage.inputTokens / 1_000_000) * rate.inputCentsPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * rate.outputCentsPer1M;
  return Math.ceil(inputCost + outputCost);
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
