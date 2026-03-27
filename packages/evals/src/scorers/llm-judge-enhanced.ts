import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';
import type { JudgeCriterion } from './criteria.js';

export interface LLMJudgeEnhancedConfig {
  /** Optional scorer ID (auto-generated if omitted) */
  id?: string;
  /** Single rubric string or array of criteria */
  criteria: string | JudgeCriterion[];
  /** The LLM function to call */
  llm: (prompt: string) => Promise<string>;
  /** Max retries on parse failure (default: 2) */
  maxRetries?: number;
  /** Custom prompt template. Use {{criteria}}, {{input}}, {{output}}, {{reference}} placeholders */
  promptTemplate?: string;
}

const DEFAULT_PROMPT_TEMPLATE = `You are an evaluation judge. Score the following output on each criterion.

Criteria:
{{criteria}}

Input: {{input}}

Output: {{output}}
{{reference}}
Respond ONLY with a JSON array, one object per criterion:
[{ "criterion": string, "score": number (0.0-1.0), "reasoning": string }]`;

function buildCriteriaList(criteria: string | JudgeCriterion[]): JudgeCriterion[] {
  if (typeof criteria === 'string') {
    return [{ name: 'overall', description: criteria, weight: 1.0 }];
  }
  return criteria;
}

function buildPrompt(
  template: string,
  criteriaList: JudgeCriterion[],
  input: EvalInput,
): string {
  const criteriaText = criteriaList
    .map((c) => `- ${c.name}: ${c.description}`)
    .join('\n');

  const referencePart = input.reference
    ? `\nReference: ${input.reference}`
    : '';

  return template
    .replace('{{criteria}}', criteriaText)
    .replace('{{input}}', input.input)
    .replace('{{output}}', input.output)
    .replace('{{reference}}', referencePart);
}

function parseResponse(
  raw: string,
  criteriaList: JudgeCriterion[],
): Array<{ criterion: string; score: number; reasoning: string }> | null {
  // Try to extract JSON array from the response
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) return null;

  const results: Array<{ criterion: string; score: number; reasoning: string }> = [];

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    const obj = item as Record<string, unknown>;
    const criterion = typeof obj['criterion'] === 'string' ? obj['criterion'] : '';
    const score = typeof obj['score'] === 'number' ? Math.max(0, Math.min(1, obj['score'])) : 0;
    const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'No reasoning';

    results.push({ criterion, score, reasoning });
  }

  // Verify we got results for all criteria
  if (results.length !== criteriaList.length) {
    // If counts don't match, still accept what we got but pad missing ones
    const existing = new Set(results.map((r) => r.criterion));
    for (const c of criteriaList) {
      if (!existing.has(c.name)) {
        results.push({ criterion: c.name, score: 0, reasoning: 'Not evaluated by judge' });
      }
    }
  }

  return results;
}

/**
 * Creates an enhanced multi-criteria LLM judge scorer.
 */
export function createLLMJudge(config: LLMJudgeEnhancedConfig): Scorer<EvalInput> {
  const criteriaList = buildCriteriaList(config.criteria);
  const maxRetries = config.maxRetries ?? 2;
  const template = config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
  const scorerId = config.id ?? `llm-judge-${Date.now()}`;

  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: `llm-judge-enhanced`,
    description: typeof config.criteria === 'string'
      ? config.criteria
      : `Multi-criteria judge: ${criteriaList.map((c) => c.name).join(', ')}`,
    type: 'llm-judge',
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const prompt = buildPrompt(template, criteriaList, input);

      let scores: Array<{ criterion: string; score: number; reasoning: string }> | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const raw = await config.llm(prompt);
          scores = parseResponse(raw, criteriaList);
          if (scores !== null) break;
        } catch {
          // LLM call failed, will retry or fall through
        }
      }

      const durationMs = Date.now() - startTime;

      if (scores === null) {
        // Total failure: return zero scores for all criteria
        return {
          scorerId,
          scores: criteriaList.map((c) => ({
            criterion: c.name,
            score: 0,
            reasoning: 'Failed to get valid response from LLM judge',
          })),
          aggregateScore: 0,
          passed: false,
          durationMs,
        };
      }

      // Compute weighted aggregate
      const totalWeight = criteriaList.reduce((sum, c) => sum + (c.weight ?? 1), 0);
      let weightedSum = 0;

      for (const s of scores) {
        const criterion = criteriaList.find((c) => c.name === s.criterion);
        const weight = criterion?.weight ?? 1;
        weightedSum += s.score * weight;
      }

      const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      return {
        scorerId,
        scores,
        aggregateScore,
        passed: aggregateScore >= (scorerConfig.threshold ?? 0.5),
        durationMs,
      };
    },
  };
}
