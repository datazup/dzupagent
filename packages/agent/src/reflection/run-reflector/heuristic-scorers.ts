/**
 * Per-dimension heuristic scorers for {@link RunReflector}.
 *
 * Each scorer is a pure function returning a score in [0, 1] and pushing
 * notable pattern flags into the shared `flags` array.
 */

import {
  ERROR_PENALTY,
  IDEAL_OUTPUT_RATIO_MAX,
  RETRY_PENALTY,
  VERY_LONG_OUTPUT_CHARS,
  VERY_SHORT_OUTPUT_CHARS,
} from "./constants.js";
import {
  clamp01,
  hasTruncationMarkers,
  isJsonParseable,
} from "./text-helpers.js";
import type { ReflectionInput } from "./types.js";

export function scoreCompleteness(
  inputStr: string,
  outputStr: string,
  flags: string[]
): number {
  // Empty or null output is a hard fail
  if (outputStr.length === 0) {
    flags.push("empty_output");
    return 0;
  }

  // Very short output relative to a non-trivial input is suspicious
  if (outputStr.length < VERY_SHORT_OUTPUT_CHARS && inputStr.length > 20) {
    flags.push("very_short_output");
    return 0.2;
  }

  // Reasonable length output — full score
  // A slightly longer output relative to input is fine; we only penalize
  // emptiness/extreme shortness here.  Verbosity is handled by conciseness.
  return 1.0;
}

export function scoreCoherence(outputStr: string, flags: string[]): number {
  if (outputStr.length === 0) return 0;

  let score = 1.0;

  // Check for truncation
  if (hasTruncationMarkers(outputStr)) {
    flags.push("truncated_output");
    score -= 0.3;
  }

  // Bonus for structured (JSON) output — no penalty if not JSON
  if (isJsonParseable(outputStr)) {
    // Already 1.0, structured is good
  }

  // Penalize if the output contains obvious error patterns inline
  const lower = outputStr.toLowerCase();
  if (
    lower.includes("internal server error") ||
    lower.includes("unhandled exception") ||
    lower.includes("stack trace")
  ) {
    flags.push("error_in_output");
    score -= 0.2;
  }

  return clamp01(score);
}

export function scoreToolSuccess(
  toolCalls: ReflectionInput["toolCalls"],
  flags: string[]
): number {
  // No tools used — neutral, full score
  if (!toolCalls || toolCalls.length === 0) {
    return 1.0;
  }

  const total = toolCalls.length;
  const successes = toolCalls.filter((tc) => tc.success).length;
  const ratio = successes / total;

  if (successes === 0) {
    flags.push("all_tools_failed");
  }

  return clamp01(ratio);
}

export function scoreConciseness(
  inputStr: string,
  outputStr: string,
  flags: string[]
): number {
  if (outputStr.length === 0) return 1.0; // emptiness penalized elsewhere

  // Penalize very long outputs
  if (outputStr.length > VERY_LONG_OUTPUT_CHARS) {
    flags.push("very_long_output");
    // Gradual penalty: 10K -> 0.8, 20K -> 0.6, 50K -> 0.2
    const overRatio = outputStr.length / VERY_LONG_OUTPUT_CHARS;
    return clamp01(1.0 - (overRatio - 1) * 0.2);
  }

  // Penalize excessive output/input ratio when input is non-trivial
  if (inputStr.length > 10) {
    const ratio = outputStr.length / inputStr.length;
    if (ratio > IDEAL_OUTPUT_RATIO_MAX) {
      // Gentle penalty for very high ratios
      const excess = (ratio - IDEAL_OUTPUT_RATIO_MAX) / IDEAL_OUTPUT_RATIO_MAX;
      return clamp01(1.0 - excess * 0.3);
    }
  }

  return 1.0;
}

export function scoreReliability(
  errorCount: number,
  retryCount: number,
  flags: string[]
): number {
  const penalty = errorCount * ERROR_PENALTY + retryCount * RETRY_PENALTY;

  if (retryCount >= 3) {
    flags.push("excessive_retries");
  }

  return clamp01(1.0 - penalty);
}
