import { z } from 'zod';
import type { EvalInput } from '../../types.js';

const criterionResponseSchema = z.object({
  score: z.number().min(0).max(10),
  reasoning: z.string(),
});

type CriterionResponse = z.infer<typeof criterionResponseSchema>;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function combinedText(input: EvalInput): string {
  return `${input.input}\n${input.output}${input.reference ? `\n${input.reference}` : ''}`;
}

/**
 * Parse a JSON object from an LLM response string, then validate with Zod.
 * Returns null on failure.
 */
export function parseCriterionResponse(raw: string): CriterionResponse | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const result = criterionResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Count how many patterns from a list are present in the text.
 */
export function countPatterns(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}
