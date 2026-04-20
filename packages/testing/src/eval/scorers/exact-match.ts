import type { EvalScore, EvalScorer } from '../types.js';

export interface ExactMatchOptions {
  /** When true, comparison is case-insensitive (default: false). */
  caseInsensitive?: boolean;
  /** When true, leading/trailing whitespace is stripped before compare (default: true). */
  trim?: boolean;
}

/**
 * ExactMatchScorer — passes only when output === expected (after optional
 * normalisation).  Score is 1.0 on match, 0.0 otherwise.
 */
export class ExactMatchScorer implements EvalScorer {
  readonly id = 'exact-match';
  private readonly caseInsensitive: boolean;
  private readonly trim: boolean;

  constructor(options: ExactMatchOptions = {}) {
    this.caseInsensitive = options.caseInsensitive ?? false;
    this.trim = options.trim ?? true;
  }

  async score(_input: string, output: string, expected?: string): Promise<EvalScore> {
    if (expected === undefined) {
      return {
        score: 0,
        pass: false,
        reasoning: 'No expected value provided for exact-match scorer',
      };
    }

    const normalise = (s: string): string => {
      let v = this.trim ? s.trim() : s;
      if (this.caseInsensitive) v = v.toLowerCase();
      return v;
    };

    const matched = normalise(output) === normalise(expected);
    return {
      score: matched ? 1.0 : 0.0,
      pass: matched,
      reasoning: matched
        ? 'Output exactly matches expected value'
        : `Output "${output.slice(0, 80)}" does not match expected "${expected.slice(0, 80)}"`,
    };
  }
}
