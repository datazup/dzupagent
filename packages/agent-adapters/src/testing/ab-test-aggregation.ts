/**
 * Pure aggregation and comparison helpers for the A/B testing framework.
 *
 * Extracted from `ab-test-runner.ts` so the runner only deals with
 * orchestration. These helpers are stateless and consume `VariantResult`s
 * produced by the runner.
 */

import { mean, welchTTest } from './ab-test-stats.js'
import type {
  ABComparison,
  ABTestScorer,
  ABTestVariant,
  ABVariantSummary,
  VariantResult,
} from './ab-test-types.js'

/**
 * Aggregate raw variant results into per-variant summaries.
 *
 * Computes total runs, success rate, average duration, and per-scorer
 * average score. Cost estimation is intentionally a stub here — real cost
 * tracking should be done via the CostTrackingMiddleware.
 */
export function aggregateVariants(
  results: VariantResult[],
  variants: ABTestVariant[],
): ABVariantSummary[] {
  const summaries: ABVariantSummary[] = []

  for (const variant of variants) {
    const variantResults = results.filter((r) => r.variantName === variant.name)
    const totalRuns = variantResults.length
    const successCount = variantResults.filter((r) => r.success).length
    const successRate = totalRuns > 0 ? successCount / totalRuns : 0

    const avgDurationMs =
      totalRuns > 0
        ? mean(variantResults.map((r) => r.durationMs))
        : 0

    const avgScores: Record<string, number> = {}
    const scorerNames = new Set<string>()
    for (const r of variantResults) {
      for (const name of Object.keys(r.scores)) {
        scorerNames.add(name)
      }
    }
    for (const scorerName of scorerNames) {
      const values = variantResults
        .map((r) => r.scores[scorerName])
        .filter((v): v is number => v !== undefined)
      avgScores[scorerName] = values.length > 0 ? mean(values) : 0
    }

    summaries.push({
      variantName: variant.name,
      providerId: variant.providerId,
      totalRuns,
      successRate,
      avgDurationMs,
      avgScores,
      totalCostEstimateCents: 0,
    })
  }

  return summaries
}

/**
 * Compare every pair of variants for every scorer using Welch's t-test.
 *
 * For variant pair (A, B) and scorer S we compute:
 *   - meanDiff   = meanA - meanB
 *   - pValue     = welchTTest(samplesA, samplesB).pValue
 *   - significant = pValue < 0.05
 *   - winner     = whichever variant has the higher mean (or 'tie')
 */
export function compareVariants(
  results: VariantResult[],
  variants: ABTestVariant[],
  scorers: ABTestScorer[],
): ABComparison[] {
  const comparisons: ABComparison[] = []

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const variantA = variants[i]!
      const variantB = variants[j]!

      const resultsA = results.filter((r) => r.variantName === variantA.name)
      const resultsB = results.filter((r) => r.variantName === variantB.name)

      for (const scorer of scorers) {
        const samplesA = resultsA
          .map((r) => r.scores[scorer.name])
          .filter((v): v is number => v !== undefined)
        const samplesB = resultsB
          .map((r) => r.scores[scorer.name])
          .filter((v): v is number => v !== undefined)

        const { pValue } = welchTTest(samplesA, samplesB)
        const meanA = mean(samplesA)
        const meanB = mean(samplesB)
        const meanDiff = meanA - meanB
        const significant = pValue < 0.05

        let winner: string | 'tie' = 'tie'
        if (significant) {
          winner = meanDiff > 0 ? variantA.name : variantB.name
        }

        comparisons.push({
          variantA: variantA.name,
          variantB: variantB.name,
          scorerName: scorer.name,
          meanDiff,
          significant,
          pValue,
          winner,
        })
      }
    }
  }

  return comparisons
}

/**
 * Determine the overall winner: the variant with the highest average
 * score across all scorers.
 */
export function determineWinner(
  summaries: ABVariantSummary[],
  scorers: ABTestScorer[],
): ABVariantSummary | undefined {
  if (summaries.length === 0) return undefined
  if (scorers.length === 0) return undefined

  let bestSummary: ABVariantSummary | undefined
  let bestOverallScore = -Infinity

  for (const summary of summaries) {
    const scorerNames = scorers.map((s) => s.name)
    const values = scorerNames
      .map((name) => summary.avgScores[name])
      .filter((v): v is number => v !== undefined)
    const overallScore = values.length > 0 ? mean(values) : 0

    if (overallScore > bestOverallScore) {
      bestOverallScore = overallScore
      bestSummary = summary
    }
  }

  return bestSummary
}
