/**
 * Confidence Scorer Tool — computes a multi-dimensional confidence score
 * for a generated SQL query. Pure computation, no LLM calls.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'
import type { ConfidenceLabel, ConfidenceScorecard } from '../types/index.js'

/** Maximum penalty from retries and warnings combined. */
const MAX_PENALTY = 30

/** Points deducted per retry attempt. */
const RETRY_PENALTY = 5

/** Penalty per "warning" severity result warning. */
const WARNING_PENALTY = 10

/** Penalty per "caution" severity result warning. */
const CAUTION_PENALTY = 5

/** Default score for semantic relevance when no example match score is provided. */
const DEFAULT_SEMANTIC_SCORE = 15

/** Default score for historical success (no cache data available). */
const DEFAULT_HISTORICAL_SCORE = 25

/** Maximum points for each dimension. */
const MAX_SCHEMA_MATCH = 25
const MAX_SYNTAX_VALIDITY = 25
const MAX_SEMANTIC_RELEVANCE = 25

interface ScorecardDimension {
  score: number
  factors: string[]
}

/**
 * Compute the schema match dimension score.
 */
function computeSchemaMatch(
  retrievedTableCount: number,
  usedTableCount: number,
): ScorecardDimension {
  const factors: string[] = []
  const denominator = Math.max(retrievedTableCount, 1)
  const tableCoverage = usedTableCount / denominator
  const score = Math.round(tableCoverage * MAX_SCHEMA_MATCH)

  factors.push(
    `Table coverage: ${usedTableCount}/${retrievedTableCount} = ${Math.round(tableCoverage * 100)}%`,
  )

  if (tableCoverage < 0.5) {
    factors.push('Low table coverage — query may be missing relevant tables')
  } else if (tableCoverage > 1) {
    factors.push('Query uses more tables than retrieved — may include unretrieved tables')
  }

  return { score: Math.min(score, MAX_SCHEMA_MATCH), factors }
}

/**
 * Compute the syntax validity dimension score.
 */
function computeSyntaxValidity(isStructurallyValid: boolean): ScorecardDimension {
  const factors: string[] = []

  if (isStructurallyValid) {
    factors.push('SQL passed structural validation')
    return { score: MAX_SYNTAX_VALIDITY, factors }
  }

  factors.push('SQL failed structural validation')
  return { score: 5, factors }
}

/**
 * Compute the semantic relevance dimension score.
 */
function computeSemanticRelevance(
  exampleMatchScore: number | undefined,
): ScorecardDimension {
  const factors: string[] = []

  if (exampleMatchScore !== undefined) {
    const score = Math.round(exampleMatchScore * MAX_SEMANTIC_RELEVANCE)
    factors.push(
      `Example match score: ${Math.round(exampleMatchScore * 100)}%`,
    )
    return { score: Math.min(score, MAX_SEMANTIC_RELEVANCE), factors }
  }

  factors.push('No example match data available — using default score')
  return { score: DEFAULT_SEMANTIC_SCORE, factors }
}

/**
 * Compute the historical success dimension score.
 */
function computeHistoricalSuccess(): ScorecardDimension {
  return {
    score: DEFAULT_HISTORICAL_SCORE,
    factors: ['No historical cache data available — using default score'],
  }
}

/**
 * Compute total penalties from retries and result warnings.
 */
function computePenalties(
  retryCount: number,
  resultWarnings: Array<{ severity: string }> | undefined,
): { penalty: number; factors: string[] } {
  const factors: string[] = []
  let penalty = 0

  // Retry penalty
  if (retryCount > 0) {
    const retryPenalty = retryCount * RETRY_PENALTY
    penalty += retryPenalty
    factors.push(
      `${retryCount} retry attempt${retryCount > 1 ? 's' : ''}: -${retryPenalty} points`,
    )
  }

  // Warning penalties
  if (resultWarnings && resultWarnings.length > 0) {
    for (const warning of resultWarnings) {
      if (warning.severity === 'warning') {
        penalty += WARNING_PENALTY
        factors.push(`Result warning: -${WARNING_PENALTY} points`)
      } else if (warning.severity === 'caution') {
        penalty += CAUTION_PENALTY
        factors.push(`Result caution: -${CAUTION_PENALTY} points`)
      }
      // 'info' severity carries no penalty
    }
  }

  // Cap penalties
  if (penalty > MAX_PENALTY) {
    factors.push(`Penalty capped at ${MAX_PENALTY} (raw: ${penalty})`)
    penalty = MAX_PENALTY
  }

  return { penalty, factors }
}

/**
 * Determine confidence label from score.
 */
function getLabel(score: number): ConfidenceLabel {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

/**
 * Creates a tool that computes a multi-dimensional confidence score
 * for a generated SQL query. Uses pure computation — no LLM calls.
 */
export function createConfidenceScorerTool(
  _config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'score-confidence',
    description:
      'Compute multi-dimensional confidence score for a generated SQL query.',
    schema: z.object({
      retrievedTableCount: z
        .number()
        .describe('Number of tables retrieved from vector search'),
      usedTableCount: z
        .number()
        .describe('Number of tables referenced in the generated SQL'),
      isStructurallyValid: z
        .boolean()
        .describe('Whether the SQL passed structural validation'),
      retryCount: z
        .number()
        .describe('Number of retry attempts before success'),
      exampleMatchScore: z
        .number()
        .optional()
        .describe('Similarity score (0-1) to matched SQL examples'),
      resultWarnings: z
        .array(
          z.object({
            severity: z
              .string()
              .describe('Warning severity: info, warning, or caution'),
          }),
        )
        .optional()
        .describe('Warnings from result validation'),
    }),
    func: async (input) => {
      try {
        const schemaMatch = computeSchemaMatch(
          input.retrievedTableCount,
          input.usedTableCount,
        )
        const syntaxValidity = computeSyntaxValidity(input.isStructurallyValid)
        const semanticRelevance = computeSemanticRelevance(input.exampleMatchScore)
        const historicalSuccess = computeHistoricalSuccess()

        const rawTotal =
          schemaMatch.score +
          syntaxValidity.score +
          semanticRelevance.score +
          historicalSuccess.score

        const { penalty, factors: penaltyFactors } = computePenalties(
          input.retryCount,
          input.resultWarnings,
        )

        const score = Math.max(0, Math.min(100, rawTotal - penalty))
        const label = getLabel(score)

        const scorecard: ConfidenceScorecard = {
          schemaMatch,
          syntaxValidity,
          semanticRelevance,
          historicalSuccess,
        }

        return JSON.stringify({
          score,
          label,
          scorecard,
          penalties: penaltyFactors.length > 0 ? penaltyFactors : undefined,
        })
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          score: 0,
          label: 'low' as const,
          scorecard: null,
        })
      }
    },
  })
}
