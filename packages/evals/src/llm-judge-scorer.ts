import type { EvalResult, EvalScorer } from './types.js';

export interface LLMJudgeConfig {
  name?: string;
  /** The LLM function to call */
  llm: (prompt: string) => Promise<string>;
  /** Rubric describing scoring criteria */
  rubric: string;
  /** Score range description (default: "0.0 to 1.0") */
  scoreRange?: string;
}

/**
 * Scores outputs by asking an LLM to judge quality against a rubric.
 */
export class LLMJudgeScorer implements EvalScorer {
  readonly name: string;
  private readonly config: LLMJudgeConfig;

  constructor(config: LLMJudgeConfig) {
    this.name = config.name ?? 'llm-judge';
    this.config = config;
  }

  async score(input: string, output: string, reference?: string): Promise<EvalResult> {
    const scoreRange = this.config.scoreRange ?? '0.0 to 1.0';

    const referencePart = reference ? `\nReference: ${reference}` : '';

    const prompt = [
      `Score the following output on a scale of ${scoreRange}.`,
      '',
      `Rubric: ${this.config.rubric}`,
      '',
      `Input: ${input}`,
      '',
      `Output: ${output}`,
      referencePart,
      '',
      'Respond with JSON: { "score": number, "pass": boolean, "reasoning": string }',
    ].join('\n');

    let llmResponse: string;
    try {
      llmResponse = await this.config.llm(prompt);
    } catch {
      return {
        score: 0.0,
        pass: false,
        reasoning: 'Failed to call LLM',
      };
    }

    try {
      const parsed: unknown = JSON.parse(llmResponse);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const obj = parsed as Record<string, unknown>;
        const score = typeof obj['score'] === 'number' ? obj['score'] : 0.0;
        const pass = typeof obj['pass'] === 'boolean' ? obj['pass'] : score >= 0.5;
        const reasoning =
          typeof obj['reasoning'] === 'string'
            ? obj['reasoning']
            : 'No reasoning provided';

        return {
          score: Math.max(0, Math.min(1, score)),
          pass,
          reasoning,
        };
      }
    } catch {
      // Fall through to failure case
    }

    return {
      score: 0.0,
      pass: false,
      reasoning: 'Failed to parse LLM response',
    };
  }
}
