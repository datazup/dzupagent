/**
 * Public type contracts for context-aware routing.
 *
 * Split out of `context-aware-router.ts` as part of the ARCH-M-06 god-module
 * decomposition. The composition root re-exports every symbol here, so the
 * public surface is unchanged.
 */

import type { AdapterProviderId } from "../../types.js";

export interface ContextEstimate {
  /** Estimated input tokens */
  inputTokens: number;
  /** Estimated output tokens (rough heuristic) */
  outputTokens: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** Whether this fits in the provider's context window */
  fitsInContext: boolean;
  /** Recommended provider based on context needs */
  recommendedProvider?: AdapterProviderId | undefined;
}

export interface ContextAwareRouterConfig {
  /** Provider context window sizes (override defaults) */
  contextWindows?: Partial<Record<AdapterProviderId, number>> | undefined;
  /** Safety margin -- reserve this percentage of context window. Default 0.2 (20%) */
  safetyMargin?: number | undefined;
  /** Default estimated output tokens when unknown. Default 4000 */
  defaultOutputTokens?: number | undefined;
  /** Custom token estimator. Default: ~4 chars per token */
  tokenEstimator?: (text: string) => number;
}

export interface ContextInjection {
  /** Label for this context chunk */
  label: string;
  /** The content to inject */
  content: string;
  /** Priority (higher = injected first if space is tight) */
  priority: number;
  /** Whether this is required or can be dropped if budget is tight */
  required?: boolean | undefined;
}

export interface ContextInjectionConfig {
  /** Max tokens to use for injected context. Default: 50% of provider's context window */
  maxContextTokens?: number | undefined;
  /** Separator between context chunks. Default: '\n\n---\n\n' */
  separator?: string | undefined;
  /** Where to inject: 'prepend' (before prompt) or 'system' (as system prompt). Default 'prepend' */
  position?: "prepend" | "system";
}
