/**
 * Evaluation runner — batch evaluation and regression detection.
 *
 * @example
 * ```ts
 * const runner = new EvalRunner([containsScorer('has-types', ['interface', 'type'])])
 * const results = await runner.evaluate({ input: 'task', output: 'interface Foo {}' })
 * // results[0].pass === true
 *
 * // Regression check against baseline
 * const { passed, regressions } = await runner.regressionCheck(
 *   testInputs,
 *   new Map([['has-types', 0.8]]),
 * )
 * ```
 */
import type { Scorer, EvalInput, EvalResult, EvalRecord, EvalResultStore } from '../types.js'

export class EvalRunner {
  constructor(
    private scorers: Scorer[],
    private store?: EvalResultStore,
  ) {}

  /** Evaluate a single input across all scorers */
  async evaluate(input: EvalInput): Promise<EvalResult[]> {
    const results = await Promise.all(
      this.scorers.map(s => s.evaluate(input)),
    )

    if (this.store) {
      await this.store.save({ input, results, timestamp: new Date() })
    }

    return results
  }

  /** Evaluate multiple inputs */
  async evaluateBatch(inputs: EvalInput[]): Promise<Map<number, EvalResult[]>> {
    const results = new Map<number, EvalResult[]>()
    for (let i = 0; i < inputs.length; i++) {
      results.set(i, await this.evaluate(inputs[i]!))
    }
    return results
  }

  /**
   * Regression check — compare current average scores against baselines.
   *
   * @param inputs - Test inputs to evaluate
   * @param baseline - Map of scorerId → minimum acceptable average score
   * @returns Whether all baselines are met, plus details of any regressions
   */
  async regressionCheck(
    inputs: EvalInput[],
    baseline: Map<string, number>,
  ): Promise<{ passed: boolean; regressions: string[]; averages: Map<string, number> }> {
    const batchResults = await this.evaluateBatch(inputs)
    const regressions: string[] = []

    // Aggregate scores per scorer
    const aggregated = new Map<string, number[]>()
    for (const results of batchResults.values()) {
      for (const result of results) {
        if (!aggregated.has(result.scorerId)) aggregated.set(result.scorerId, [])
        aggregated.get(result.scorerId)!.push(result.score)
      }
    }

    // Compute averages and check against baselines
    const averages = new Map<string, number>()
    for (const [scorerId, scores] of aggregated) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      averages.set(scorerId, avg)

      const minScore = baseline.get(scorerId)
      if (minScore !== undefined && avg < minScore) {
        regressions.push(
          `${scorerId}: avg ${avg.toFixed(3)} < baseline ${minScore}`,
        )
      }
    }

    return { passed: regressions.length === 0, regressions, averages }
  }

  /** Get summary statistics for batch results */
  static summarize(batchResults: Map<number, EvalResult[]>): {
    totalInputs: number
    totalPass: number
    totalFail: number
    byScorerPass: Map<string, number>
    byScorerFail: Map<string, number>
  } {
    const byScorerPass = new Map<string, number>()
    const byScorerFail = new Map<string, number>()
    let totalPass = 0
    let totalFail = 0

    for (const results of batchResults.values()) {
      const allPass = results.every(r => r.pass)
      if (allPass) totalPass++
      else totalFail++

      for (const r of results) {
        const key = r.scorerId
        if (r.pass) {
          byScorerPass.set(key, (byScorerPass.get(key) ?? 0) + 1)
        } else {
          byScorerFail.set(key, (byScorerFail.get(key) ?? 0) + 1)
        }
      }
    }

    return {
      totalInputs: batchResults.size,
      totalPass,
      totalFail,
      byScorerPass,
      byScorerFail,
    }
  }
}
