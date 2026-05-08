/**
 * Built-in scorers for the A/B testing framework.
 *
 * Extracted from `ab-test-runner.ts` to keep custom scoring logic separate
 * from orchestration. Consumers may implement their own `ABTestScorer`
 * directly; these are convenient defaults.
 */

import type { ABTestCase, ABTestScorer } from './ab-test-types.js'

/**
 * Scores based on response length relative to expected output length.
 * Penalizes both too-short and too-long responses.
 *
 * If no expectedOutput is provided, returns 0.5 for non-empty results and 0 for empty.
 */
export class LengthScorer implements ABTestScorer {
  readonly name = 'length'

  async score(result: string, testCase: ABTestCase): Promise<number> {
    if (!testCase.expectedOutput) {
      return result.length > 0 ? 0.5 : 0
    }

    const expectedLen = testCase.expectedOutput.length
    if (expectedLen === 0) {
      return result.length === 0 ? 1 : 0
    }

    const ratio = result.length / expectedLen
    // Perfect ratio is 1.0. Score decays as ratio diverges from 1.
    // Uses a Gaussian-style decay: score = exp(-2 * (ratio - 1)^2)
    return Math.exp(-2 * (ratio - 1) ** 2)
  }
}

/**
 * Returns 1.0 if the result matches expectedOutput exactly, else 0.0.
 * If no expectedOutput is provided, returns 0.0.
 */
export class ExactMatchScorer implements ABTestScorer {
  readonly name = 'exact-match'

  async score(result: string, testCase: ABTestCase): Promise<number> {
    if (testCase.expectedOutput === undefined) return 0
    return result === testCase.expectedOutput ? 1 : 0
  }
}

/**
 * Scores based on how many expected keywords appear in the result.
 *
 * Keywords are extracted by splitting expectedOutput on whitespace.
 * The score is the fraction of unique keywords found (case-insensitive).
 * If no expectedOutput is provided, returns 0.0.
 */
export class ContainsKeywordsScorer implements ABTestScorer {
  readonly name = 'contains-keywords'

  async score(result: string, testCase: ABTestCase): Promise<number> {
    if (!testCase.expectedOutput) return 0

    const keywords = [
      ...new Set(
        testCase.expectedOutput
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 0),
      ),
    ]

    if (keywords.length === 0) return 0

    const lowerResult = result.toLowerCase()
    let found = 0
    for (const keyword of keywords) {
      if (lowerResult.includes(keyword)) found++
    }

    return found / keywords.length
  }
}
