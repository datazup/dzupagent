/**
 * Scoring constants for {@link RunReflector}.
 */

import type { ReflectionDimensions } from "./types.js";

/** Dimension weights for the overall score (must sum to 1.0). */
export const WEIGHTS: Record<keyof ReflectionDimensions, number> = {
  completeness: 0.3,
  coherence: 0.2,
  toolSuccess: 0.2,
  conciseness: 0.1,
  reliability: 0.2,
};

/** Output length thresholds. */
export const VERY_LONG_OUTPUT_CHARS = 10_000;
export const VERY_SHORT_OUTPUT_CHARS = 5;
export const IDEAL_OUTPUT_RATIO_MAX = 20;

/** Duration thresholds. */
export const VERY_FAST_MS = 500;

/** Penalty constants. */
export const ERROR_PENALTY = 0.2;
export const RETRY_PENALTY = 0.1;
