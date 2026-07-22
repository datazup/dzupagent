/**
 * Canonical model / provider pricing source (ARCH-M-08).
 *
 * This module is the single hand-maintained rate table for the whole
 * `@dzupagent/*` family. Historically the same numbers were copy-pasted into
 * `@dzupagent/core/middleware/cost-tracking` (`MODEL_COSTS`, keyed by concrete
 * model id) and `@dzupagent/agent-adapters` (`PROVIDER_RATES`, keyed by a
 * generic provider family, plus prompt-cache tiers) and a coarse
 * `COST_PER_10K_TOKENS` heuristic — three tables that silently drifted.
 *
 * Downstream layers now project this table instead of re-declaring rates.
 * Core stays at the lowest dependency tier, so the canonical table is keyed by
 * plain provider-family / model strings and knows nothing about
 * `AdapterProviderId` (that mapping lives in `@dzupagent/agent-adapters`).
 *
 * All prices are **cents per 1,000,000 tokens**.
 */

/** Full rate for a provider family or model, cents per 1M tokens. */
export interface ModelRate {
  /** Uncached input (prompt) tokens. */
  inputCentsPer1M: number;
  /** Output (completion) tokens. */
  outputCentsPer1M: number;
  /**
   * Prompt-cache read (cache-hit) tokens.
   * Defaults to `inputCentsPer1M` when a provider has no distinct cache-read tier.
   */
  cachedInputCentsPer1M?: number;
  /**
   * Prompt-cache write tokens.
   * Defaults to `inputCentsPer1M` when a provider has no distinct cache-write tier.
   */
  cacheWriteCentsPer1M?: number;
}

/**
 * Canonical provider-family rate table.
 *
 * Keyed by a generic provider family (`claude`, `codex`, `gemini`, ...). This
 * is the source consumed by `@dzupagent/agent-adapters` `PROVIDER_RATES` and by
 * the contract-net cost heuristic. Values last reviewed 2025-05.
 */
export const PROVIDER_RATE_TABLE = {
  claude: {
    inputCentsPer1M: 300,
    outputCentsPer1M: 1500,
    cachedInputCentsPer1M: 30, // Anthropic cache-read: ~0.1x base input price
    cacheWriteCentsPer1M: 375, // Anthropic cache-write: ~1.25x base input price
  },
  codex: { inputCentsPer1M: 110, outputCentsPer1M: 440 }, // o4-mini (2025-05)
  gemini: { inputCentsPer1M: 10, outputCentsPer1M: 40 }, // Gemini Flash 2.0
  "gemini-sdk": { inputCentsPer1M: 10, outputCentsPer1M: 40 },
  qwen: { inputCentsPer1M: 50, outputCentsPer1M: 200 },
  crush: { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  goose: { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  openrouter: { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  openai: { inputCentsPer1M: 150, outputCentsPer1M: 600 }, // gpt-4o-mini (2025-05)
  ollama: { inputCentsPer1M: 0, outputCentsPer1M: 0 },
} as const satisfies Record<string, ModelRate>;

/** Provider-family keys known to the canonical table. */
export type ProviderRateKey = keyof typeof PROVIDER_RATE_TABLE;

/**
 * Canonical concrete-model rate table (cents per 1M tokens).
 *
 * Keyed by concrete model id. Consumed by `calculateCostCents` /
 * `getModelCosts`. The `default` entry is the fallback for unknown models.
 */
export const MODEL_RATE_TABLE = {
  "claude-haiku-4-5-20251001": { inputCentsPer1M: 80, outputCentsPer1M: 400 },
  "claude-sonnet-4-6": { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  "claude-opus-4-6": { inputCentsPer1M: 1500, outputCentsPer1M: 7500 },
  "gpt-5-mini": { inputCentsPer1M: 15, outputCentsPer1M: 60 },
  "gpt-5": { inputCentsPer1M: 250, outputCentsPer1M: 1000 },
  "gemini-2.5-pro": { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  "gemini-2.5-flash": { inputCentsPer1M: 15, outputCentsPer1M: 60 },
  default: { inputCentsPer1M: 200, outputCentsPer1M: 1000 },
} as const satisfies Record<string, ModelRate>;

/** Concrete model keys known to the canonical table. */
export type ModelRateKey = keyof typeof MODEL_RATE_TABLE;

/**
 * Resolve the canonical rate for a provider family or concrete model.
 *
 * Resolution order:
 * 1. Exact concrete-model match in {@link MODEL_RATE_TABLE}.
 * 2. Exact provider-family match in {@link PROVIDER_RATE_TABLE}.
 * 3. The `default` model rate.
 *
 * @param providerOrModel - a provider family (`'claude'`) or model id
 *   (`'claude-sonnet-4-6'`).
 * @returns the resolved {@link ModelRate}. Never null — falls back to `default`.
 *
 * @example
 * getModelRate('claude-sonnet-4-6') // { inputCentsPer1M: 300, outputCentsPer1M: 1500 }
 * getModelRate('gemini')            // { inputCentsPer1M: 10,  outputCentsPer1M: 40 }
 * getModelRate('unknown-model')     // default rate
 */
export function getModelRate(providerOrModel: string): ModelRate {
  return (
    (MODEL_RATE_TABLE as Record<string, ModelRate>)[providerOrModel] ??
    (PROVIDER_RATE_TABLE as Record<string, ModelRate>)[providerOrModel] ??
    MODEL_RATE_TABLE.default
  );
}
