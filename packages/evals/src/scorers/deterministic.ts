/**
 * Deterministic scorers — rule-based evaluation with no LLM calls.
 */
import type { Scorer, EvalInput, EvalResult } from '../types.js'

export interface DeterministicScorerConfig {
  id: string
  /** Scoring function: returns 0-1 */
  check: (input: EvalInput) => number
  threshold?: number
}

/** Create a custom deterministic scorer */
export function createDeterministicScorer(config: DeterministicScorerConfig): Scorer {
  const threshold = config.threshold ?? 0.7
  return {
    id: config.id,
    type: 'deterministic',
    threshold,
    async evaluate(input: EvalInput): Promise<EvalResult> {
      const score = Math.max(0, Math.min(1, config.check(input)))
      return { scorerId: config.id, score, pass: score >= threshold }
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in deterministic scorers
// ---------------------------------------------------------------------------

/** Score based on how many expected strings appear in the output */
export function containsScorer(id: string, expected: string[], threshold?: number): Scorer {
  return createDeterministicScorer({
    id,
    threshold,
    check: (input) => {
      if (expected.length === 0) return 1
      const found = expected.filter(e => input.output.includes(e))
      return found.length / expected.length
    },
  })
}

/** Score 1 if output is valid JSON, 0 otherwise */
export const jsonValidScorer: Scorer = createDeterministicScorer({
  id: 'json-valid',
  check: (input) => {
    try { JSON.parse(input.output); return 1 }
    catch { return 0 }
  },
})

/** Score 1 if output length is within range, 0 otherwise */
export function lengthScorer(id: string, minChars: number, maxChars: number): Scorer {
  return createDeterministicScorer({
    id,
    check: (input) => {
      const len = input.output.length
      return (len >= minChars && len <= maxChars) ? 1 : 0
    },
  })
}

/** Score based on regex match — 1 if matches, 0 if not */
export function regexScorer(id: string, pattern: RegExp): Scorer {
  return createDeterministicScorer({
    id,
    check: (input) => pattern.test(input.output) ? 1 : 0,
  })
}

/** Score 1 if output exactly matches reference, 0 otherwise */
export const exactMatchScorer: Scorer = createDeterministicScorer({
  id: 'exact-match',
  check: (input) => {
    if (!input.reference) return 0
    return input.output.trim() === input.reference.trim() ? 1 : 0
  },
})
