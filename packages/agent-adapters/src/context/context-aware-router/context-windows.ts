/**
 * Provider context-window defaults, priority ordering, and the default token
 * estimator shared by the router and injection middleware.
 *
 * Split out of `context-aware-router.ts` as part of the ARCH-M-06 god-module
 * decomposition.
 */

import { estimateTokens } from "@dzupagent/core/llm";
import type { AdapterProviderId } from "../../types.js";

export const DEFAULT_CONTEXT_WINDOWS: Record<AdapterProviderId, number> = {
  claude: 200_000,
  codex: 128_000,
  gemini: 1_000_000,
  "gemini-sdk": 1_000_000,
  qwen: 128_000,
  crush: 32_000,
  goose: 128_000,
  openrouter: 200_000,
  openai: 128_000,
  ollama: 32_000,
};

/**
 * Provider priority order used as a tiebreaker when multiple providers can
 * handle the context.
 */
export const PROVIDER_PRIORITY: readonly AdapterProviderId[] = [
  "claude",
  "codex",
  "gemini",
  "gemini-sdk",
  "qwen",
  "crush",
  "goose",
  "openrouter",
  "openai",
  "ollama",
];

export function getProviderPriority(providerId: AdapterProviderId): number {
  const priority = PROVIDER_PRIORITY.indexOf(providerId);
  return priority === -1 ? Number.MAX_SAFE_INTEGER : priority;
}

/**
 * Default token estimator: routes through core's canonical `estimateTokens`
 * (tokenizer-aware when the optional backend is installed, chars/4 heuristic
 * otherwise). Override via `config.tokenEstimator` to inject a custom estimator.
 */
export function defaultTokenEstimator(text: string): number {
  return estimateTokens(text);
}
