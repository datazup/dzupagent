/**
 * LLM-enhanced reflection: prompt construction, response parsing, and
 * heuristic/LLM score merging for {@link RunReflector}.
 */

import { clamp01, stringify } from "./text-helpers.js";
import type {
  LlmReflectionResult,
  ReflectionDimensions,
  ReflectionInput,
  ReflectionScore,
} from "./types.js";

/** LLM reflection dimension names. */
export const LLM_DIMENSIONS = [
  "completeness",
  "coherence",
  "relevance",
] as const;

/**
 * Build the prompt for LLM reflection scoring.
 */
export function buildLlmPrompt(input: ReflectionInput): string {
  const inputStr = stringify(input.input);
  const outputStr = stringify(input.output);

  const toolSummary = input.toolCalls
    ? input.toolCalls
        .map(
          (tc) =>
            `  - ${tc.name}: ${tc.success ? "success" : "failed"}${
              tc.durationMs !== undefined ? ` (${tc.durationMs}ms)` : ""
            }`
        )
        .join("\n")
    : "  (none)";

  return (
    `You are an expert evaluator. Score the following agent run on 3 dimensions, each from 0.0 to 1.0.\n` +
    `Return ONLY a JSON object matching this schema:\n` +
    `{ "completeness": number, "coherence": number, "relevance": number, "reasoning": string }\n\n` +
    `Dimensions:\n` +
    `- completeness (0.0-1.0): Does the output fully address all parts of the input?\n` +
    `- coherence (0.0-1.0): Is the output well-structured and internally consistent?\n` +
    `- relevance (0.0-1.0): Is the output relevant to the input without unnecessary content?\n\n` +
    `Input: ${inputStr}\n\n` +
    `Output: ${outputStr}\n\n` +
    `Tool calls:\n${toolSummary}\n\n` +
    `Errors: ${input.errorCount ?? 0}, Retries: ${
      input.retryCount ?? 0
    }, Duration: ${input.durationMs}ms`
  );
}

/** Parse an LLM reflection response. Returns null on any parse/validation failure. */
export function parseLlmResponse(raw: string): LlmReflectionResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required dimension fields
  for (const dim of LLM_DIMENSIONS) {
    if (typeof obj[dim] !== "number") {
      return null;
    }
  }

  return {
    completeness: clamp01(obj["completeness"] as number),
    coherence: clamp01(obj["coherence"] as number),
    relevance: clamp01(obj["relevance"] as number),
    reasoning: typeof obj["reasoning"] === "string" ? obj["reasoning"] : "",
  };
}

/**
 * Merge heuristic and LLM scores.
 *
 * Uses LLM dimensions for completeness/coherence and adds relevance.
 * Keeps heuristic for toolSuccess/reliability/conciseness.
 * Blends overall: 0.6 * llmOverall + 0.4 * heuristicOverall.
 * Preserves all heuristic flags.
 */
export function mergeScores(
  heuristic: ReflectionScore,
  llm: LlmReflectionResult
): ReflectionScore {
  // Compute LLM overall from its 3 dimensions (equal weight)
  const llmOverall = (llm.completeness + llm.coherence + llm.relevance) / 3;

  // Merge dimensions: LLM overrides completeness/coherence, keep heuristic for the rest
  const dimensions: ReflectionDimensions = {
    completeness: llm.completeness,
    coherence: llm.coherence,
    toolSuccess: heuristic.dimensions.toolSuccess,
    conciseness: heuristic.dimensions.conciseness,
    reliability: heuristic.dimensions.reliability,
  };

  // Blend overall
  const overall = clamp01(0.6 * llmOverall + 0.4 * heuristic.overall);

  return {
    overall,
    dimensions,
    flags: [...heuristic.flags, "llm_enhanced"],
  };
}
