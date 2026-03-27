import type { EvalResult, EvalScorer } from './types.js';

export interface CompositeScorerConfig {
  name?: string;
  scorers: Array<{ scorer: EvalScorer; weight: number }>;
}

/**
 * Combines multiple scorers using weighted average.
 */
export class CompositeScorer implements EvalScorer {
  readonly name: string;
  private readonly scorers: Array<{ scorer: EvalScorer; weight: number }>;

  constructor(config: CompositeScorerConfig) {
    this.name = config.name ?? 'composite';
    this.scorers = config.scorers;
  }

  async score(input: string, output: string, reference?: string): Promise<EvalResult> {
    if (this.scorers.length === 0) {
      return {
        score: 0,
        pass: false,
        reasoning: 'No scorers configured',
      };
    }

    // Run all scorers in parallel
    const results = await Promise.all(
      this.scorers.map(async ({ scorer, weight }) => {
        const result = await scorer.score(input, output, reference);
        return { scorerName: scorer.name, result, weight };
      }),
    );

    // Normalize weights
    const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight === 0) {
      return {
        score: 0,
        pass: false,
        reasoning: 'Total weight is zero',
      };
    }

    // Weighted average
    const finalScore = results.reduce(
      (sum, r) => sum + (r.result.score * r.weight) / totalWeight,
      0,
    );

    // Combine reasoning
    const reasoning = results
      .map((r) => `[${r.scorerName}] (w=${r.weight}): ${r.result.reasoning}`)
      .join('; ');

    return {
      score: finalScore,
      pass: finalScore >= 0.5,
      reasoning,
      metadata: {
        scorerResults: results.map((r) => ({
          scorerName: r.scorerName,
          score: r.result.score,
          weight: r.weight,
          normalizedWeight: r.weight / totalWeight,
        })),
      },
    };
  }
}
