/**
 * ABTestRunner -- A/B testing framework for comparing agent outputs
 * across different providers or configurations.
 *
 * Runs the same test cases against multiple variants (provider + config),
 * scores results with pluggable scorers, and produces a statistical
 * comparison report including Welch's t-test approximations.
 */

import type { DzupEventBus } from '@dzupagent/core'
import { Semaphore } from '@dzupagent/core/orchestration'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCompletedEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ABTestConfig {
  registry: ProviderAdapterRegistry
  eventBus?: DzupEventBus
}

export interface ABTestCase {
  /** Unique test case ID */
  id: string
  /** Input prompt to test */
  input: AgentInput
  /** Optional expected output for scoring */
  expectedOutput?: string
  /** Tags for categorization */
  tags?: string[]
}

export interface ABTestVariant {
  /** Variant name (e.g., 'control', 'treatment-a') */
  name: string
  /** Which provider to use */
  providerId: AdapterProviderId
  /** Optional config overrides for this variant */
  configOverrides?: Partial<AdapterConfig>
}

export interface ABTestScorer {
  readonly name: string
  /** Score a result from 0 to 1. Higher is better. */
  score(result: string, testCase: ABTestCase): Promise<number>
}

export interface ABTestPlan {
  /** Test plan name */
  name: string
  /** Variants to compare */
  variants: ABTestVariant[]
  /** Test cases to run */
  testCases: ABTestCase[]
  /** Scorers to evaluate results */
  scorers: ABTestScorer[]
  /** Number of repetitions per test case per variant. Default 1 */
  repetitions?: number
  /** Max concurrency across all variants. Default 2 */
  maxConcurrency?: number
  /** Abort signal */
  signal?: AbortSignal
}

export interface VariantResult {
  variantName: string
  providerId: AdapterProviderId
  testCaseId: string
  repetition: number
  result: string
  success: boolean
  durationMs: number
  scores: Record<string, number>
  error?: string
}

export interface ABTestReport {
  planName: string
  startedAt: Date
  completedAt: Date
  totalDurationMs: number
  variants: ABVariantSummary[]
  winner: ABVariantSummary | undefined
  /** Statistical comparison between variants */
  comparison: ABComparison[]
  /** Raw results */
  rawResults: VariantResult[]
}

export interface ABVariantSummary {
  variantName: string
  providerId: AdapterProviderId
  totalRuns: number
  successRate: number
  avgDurationMs: number
  avgScores: Record<string, number>
  totalCostEstimateCents: number
}

export interface ABComparison {
  variantA: string
  variantB: string
  scorerName: string
  /** Mean difference (A - B) */
  meanDiff: number
  /** Whether the difference is statistically significant (p < 0.05) */
  significant: boolean
  /** p-value from two-sample t-test approximation */
  pValue: number
  /** Which variant is better for this scorer */
  winner: string | 'tie'
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function normalizeConcurrency(value: number | undefined, defaultValue = 2): number {
  const concurrency = value ?? defaultValue
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `ABTestRunner maxConcurrency must be a finite positive integer; received ${String(concurrency)}`,
    )
  }
  return concurrency
}

async function acquireSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await semaphore.acquire()
    return true
  }

  if (signal.aborted) {
    return false
  }

  const acquirePromise = semaphore.acquire().then(() => {
    if (signal.aborted) {
      semaphore.release()
      return false
    }
    return true
  })

  const abortPromise = new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    acquirePromise.finally(() => signal.removeEventListener('abort', onAbort))
  })

  return await Promise.race([acquirePromise, abortPromise])
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function variance(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  let sum = 0
  for (const v of values) sum += (v - m) ** 2
  return sum / (values.length - 1)
}

/**
 * Standard normal CDF approximation using the Abramowitz & Stegun formula.
 * Accurate to about 1e-5 for the purposes of dev tooling.
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1.0 / (1.0 + p * absX)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2)

  return 0.5 * (1.0 + sign * y)
}

/**
 * Welch's t-test approximation for two independent samples.
 *
 * Uses a normal CDF approximation for the p-value, which is conservative
 * but sufficient for developer tooling comparisons.
 */
function welchTTest(samplesA: number[], samplesB: number[]): { tStat: number; pValue: number } {
  const nA = samplesA.length
  const nB = samplesB.length

  if (nA < 2 || nB < 2) {
    return { tStat: 0, pValue: 1 }
  }

  const meanA = mean(samplesA)
  const meanB = mean(samplesB)
  const varA = variance(samplesA)
  const varB = variance(samplesB)

  const seSquared = varA / nA + varB / nB

  if (seSquared === 0) {
    return { tStat: 0, pValue: 1 }
  }

  const tStat = (meanA - meanB) / Math.sqrt(seSquared)

  // Two-tailed p-value using normal CDF approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)))

  return { tStat, pValue }
}

// ---------------------------------------------------------------------------
// Built-in scorers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Job descriptor (internal)
// ---------------------------------------------------------------------------

interface ABJob {
  testCase: ABTestCase
  variant: ABTestVariant
  repetition: number
}

// ---------------------------------------------------------------------------
// ABTestRunner
// ---------------------------------------------------------------------------

export class ABTestRunner {
  private readonly registry: ProviderAdapterRegistry
  private readonly eventBus: DzupEventBus | undefined

  constructor(config: ABTestConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
  }

  /**
   * Run a full A/B test plan.
   *
   * 1. For each variant x testCase x repetition, create a job
   * 2. Run jobs up to maxConcurrency using a semaphore
   * 3. Score each result with all scorers
   * 4. Aggregate into ABVariantSummary per variant
   * 5. Compare variants pair-wise using Welch's t-test
   * 6. Determine winner (highest average across all scorers)
   * 7. Return ABTestReport
   */
  async run(plan: ABTestPlan): Promise<ABTestReport> {
    const startedAt = new Date()
    const repetitions = plan.repetitions ?? 1
    const maxConcurrency = normalizeConcurrency(plan.maxConcurrency)

    this.emit({
      type: 'pipeline:run_started',
      pipelineId: 'ab-test-runner',
      runId: plan.name,
    })

    // 1. Build job list
    const jobs: ABJob[] = []
    for (const variant of plan.variants) {
      for (const testCase of plan.testCases) {
        for (let rep = 0; rep < repetitions; rep++) {
          jobs.push({ testCase, variant, repetition: rep })
        }
      }
    }

    // 2. Execute with concurrency control
    const semaphore = new Semaphore(maxConcurrency)
    const resultPromises: Array<Promise<VariantResult>> = []

    for (const job of jobs) {
      if (plan.signal?.aborted) break

      const promise = (async (): Promise<VariantResult> => {
        const acquired = await acquireSemaphore(semaphore, plan.signal)
        try {
          if (!acquired) {
            return this.buildAbortedResult(job)
          }

          if (plan.signal?.aborted) {
            return this.buildAbortedResult(job)
          }
          return await this.runSingle(job.testCase, job.variant, plan.scorers)
        } finally {
          if (acquired) {
            semaphore.release()
          }
        }
      })()

      resultPromises.push(promise)
    }

    const rawResults = await Promise.all(resultPromises)

    // 4. Aggregate per variant
    const variantSummaries = this.aggregateVariants(rawResults, plan.variants)

    // 5. Pair-wise comparison
    const comparison = this.compareVariants(rawResults, plan.variants, plan.scorers)

    // 6. Determine winner
    const winner = this.determineWinner(variantSummaries, plan.scorers)

    const completedAt = new Date()
    const totalDurationMs = completedAt.getTime() - startedAt.getTime()

    this.emit({
      type: 'pipeline:run_completed',
      pipelineId: 'ab-test-runner',
      runId: plan.name,
      durationMs: totalDurationMs,
    })

    return {
      planName: plan.name,
      startedAt,
      completedAt,
      totalDurationMs,
      variants: variantSummaries,
      winner,
      comparison,
      rawResults,
    }
  }

  /**
   * Run a single test case on a single variant, scoring with all provided scorers.
   */
  async runSingle(
    testCase: ABTestCase,
    variant: ABTestVariant,
    scorers: ABTestScorer[],
  ): Promise<VariantResult> {
    const adapter = this.registry.get(variant.providerId)

    if (!adapter) {
      return {
        variantName: variant.name,
        providerId: variant.providerId,
        testCaseId: testCase.id,
        repetition: 0,
        result: '',
        success: false,
        durationMs: 0,
        scores: {},
        error: `Adapter "${variant.providerId}" is not registered`,
      }
    }

    // Apply config overrides if provided
    if (variant.configOverrides) {
      adapter.configure(variant.configOverrides)
    }

    const startMs = Date.now()
    let resultText = ''

    this.emit({
      type: 'pipeline:node_started',
      pipelineId: 'ab-test-runner',
      runId: `${variant.name}:${testCase.id}`,
      nodeId: variant.providerId,
      nodeType: 'adapter',
    })

    try {
      const gen = adapter.execute(testCase.input)

      for await (const event of gen) {
        if (event.type === 'adapter:completed') {
          const completed = event as AgentCompletedEvent
          resultText = completed.result
        }
      }

      const durationMs = Date.now() - startMs

      // Score with all scorers
      const scores = await this.scoreResult(resultText, testCase, scorers)

      this.emit({
        type: 'pipeline:node_completed',
        pipelineId: 'ab-test-runner',
        runId: `${variant.name}:${testCase.id}`,
        nodeId: variant.providerId,
        durationMs,
      })

      return {
        variantName: variant.name,
        providerId: variant.providerId,
        testCaseId: testCase.id,
        repetition: 0,
        result: resultText,
        success: true,
        durationMs,
        scores,
      }
    } catch (err) {
      const durationMs = Date.now() - startMs
      const message = err instanceof Error ? err.message : String(err)

      this.emit({
        type: 'pipeline:node_failed',
        pipelineId: 'ab-test-runner',
        runId: `${variant.name}:${testCase.id}`,
        nodeId: variant.providerId,
        error: message,
      })

      // Score failures with 0 for all scorers
      const scores: Record<string, number> = {}
      for (const scorer of scorers) {
        scores[scorer.name] = 0
      }

      return {
        variantName: variant.name,
        providerId: variant.providerId,
        testCaseId: testCase.id,
        repetition: 0,
        result: '',
        success: false,
        durationMs,
        scores,
        error: message,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private -- scoring
  // ---------------------------------------------------------------------------

  private async scoreResult(
    result: string,
    testCase: ABTestCase,
    scorers: ABTestScorer[],
  ): Promise<Record<string, number>> {
    const scores: Record<string, number> = {}

    const scorePromises = scorers.map(async (scorer) => {
      const score = await scorer.score(result, testCase)
      return { name: scorer.name, score }
    })

    const settled = await Promise.allSettled(scorePromises)
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        scores[entry.value.name] = entry.value.score
      }
      // On failure, scorer is simply omitted from scores
    }

    return scores
  }

  // ---------------------------------------------------------------------------
  // Private -- aggregation
  // ---------------------------------------------------------------------------

  private aggregateVariants(
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

      // Average scores across all scorers
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

      // Estimate cost: this is a rough heuristic. Real cost tracking
      // should be done via the CostTrackingMiddleware.
      const totalCostEstimateCents = 0

      summaries.push({
        variantName: variant.name,
        providerId: variant.providerId,
        totalRuns,
        successRate,
        avgDurationMs,
        avgScores,
        totalCostEstimateCents,
      })
    }

    return summaries
  }

  // ---------------------------------------------------------------------------
  // Private -- statistical comparison
  // ---------------------------------------------------------------------------

  private compareVariants(
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

  // ---------------------------------------------------------------------------
  // Private -- winner selection
  // ---------------------------------------------------------------------------

  /**
   * Determine the overall winner: the variant with the highest average
   * score across all scorers.
   */
  private determineWinner(
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

  // ---------------------------------------------------------------------------
  // Private -- helpers
  // ---------------------------------------------------------------------------

  private buildAbortedResult(job: ABJob): VariantResult {
    return {
      variantName: job.variant.name,
      providerId: job.variant.providerId,
      testCaseId: job.testCase.id,
      repetition: job.repetition,
      result: '',
      success: false,
      durationMs: 0,
      scores: {},
      error: 'Aborted',
    }
  }

  // ---------------------------------------------------------------------------
  // Private -- event bus
  // ---------------------------------------------------------------------------

  private emit(
    event:
      | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
      | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
      | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
      | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
      | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string },
  ): void {
    if (this.eventBus) {
      this.eventBus.emit(event)
    }
  }
}
