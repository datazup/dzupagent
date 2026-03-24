/**
 * Composite scorer — weighted combination of multiple scorers.
 */
import type { Scorer, EvalInput, EvalResult } from '../types.js'

export interface CompositeScorerConfig {
  id: string
  scorers: Array<{ scorer: Scorer; weight: number }>
  threshold?: number
}

export function createCompositeScorer(config: CompositeScorerConfig): Scorer {
  const threshold = config.threshold ?? 0.7

  return {
    id: config.id,
    type: 'composite',
    threshold,

    async evaluate(input: EvalInput): Promise<EvalResult> {
      const results = await Promise.all(
        config.scorers.map(async ({ scorer, weight }) => ({
          result: await scorer.evaluate(input),
          weight,
        })),
      )

      const totalWeight = config.scorers.reduce((sum, s) => sum + s.weight, 0)
      const weightedScore = totalWeight > 0
        ? results.reduce((sum, { result, weight }) => sum + result.score * weight, 0) / totalWeight
        : 0

      return {
        scorerId: config.id,
        score: weightedScore,
        pass: weightedScore >= threshold,
        reasoning: results
          .map(r => `${r.result.scorerId}: ${r.result.score.toFixed(2)}`)
          .join(', '),
        metadata: { breakdown: results.map(r => r.result) },
      }
    },
  }
}
