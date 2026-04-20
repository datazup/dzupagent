import type { EvalScore, EvalScorer } from '../types.js';

export interface RegexScorerOptions {
  /** The pattern to test against the output. */
  pattern: RegExp | string;
  /** Optional custom scorer id (default: 'regex'). */
  id?: string;
}

/**
 * RegexScorer — passes when output matches the given regex pattern.
 * Score is 1.0 on match, 0.0 otherwise.
 */
export class RegexScorer implements EvalScorer {
  readonly id: string;
  private readonly regex: RegExp;

  constructor(options: RegexScorerOptions) {
    this.id = options.id ?? 'regex';
    this.regex =
      typeof options.pattern === 'string' ? new RegExp(options.pattern) : options.pattern;
  }

  async score(_input: string, output: string, _expected?: string): Promise<EvalScore> {
    const matched = this.regex.test(output);
    return {
      score: matched ? 1.0 : 0.0,
      pass: matched,
      reasoning: matched
        ? `Output matches pattern ${String(this.regex)}`
        : `Output does not match pattern ${String(this.regex)}`,
    };
  }
}
