/**
 * Shared cost / token estimation for the self-correction subsystem.
 *
 * Consolidates three previously-divergent `estimateCostCents` definitions
 * (self-correcting-node.ts, reflection-loop.ts, output-refinement-prompts.ts)
 * into a single helper with one pricing model.
 *
 * Reconciliation (CODE-M-10): two of the three prior call sites used a split
 * input/output pricing model (0.025 cents/1K input, 0.125 cents/1K output),
 * while output-refinement-prompts.ts used a single blended rate of 0.3
 * cents/1K tokens. The split model is adopted as canonical here because it is
 * both the majority (2 of 3 sites) and more accurate — Anthropic (and most
 * providers) bill input and output tokens at different rates. The former
 * blended-rate caller now routes its total token count through the input side
 * of this helper (see estimateCostCentsFromTokens callers), preserving its
 * prior single-bucket behavior while unifying the pricing source of truth.
 *
 * @module self-correction/cost
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough chars-per-token ratio for cost estimation. */
export const CHARS_PER_TOKEN = 4;

/** Default cost per 1K input tokens in cents (Claude Haiku-class). */
export const INPUT_COST_PER_1K_CENTS = 0.025;

/** Default cost per 1K output tokens in cents (Claude Haiku-class). */
export const OUTPUT_COST_PER_1K_CENTS = 0.125;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate token count from character length. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate cost in cents for a given number of input and output tokens using
 * the canonical split input/output pricing model.
 *
 * @param inputTokens - Number of input (prompt) tokens.
 * @param outputTokens - Number of output (completion) tokens.
 * @returns Estimated cost in cents.
 */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens / 1000) * INPUT_COST_PER_1K_CENTS +
    (outputTokens / 1000) * OUTPUT_COST_PER_1K_CENTS
  );
}

/**
 * Estimate cost in cents from raw character counts, converting to tokens first.
 * Convenience wrapper for call sites that hold character lengths.
 *
 * @param inputChars - Number of input (prompt) characters.
 * @param outputChars - Number of output (completion) characters.
 * @returns Estimated cost in cents.
 */
export function estimateCostCentsFromChars(
  inputChars: number,
  outputChars: number
): number {
  return estimateCostCents(
    estimateTokens(inputChars),
    estimateTokens(outputChars)
  );
}
