/**
 * ABTestRunner -- A/B testing framework for comparing agent outputs
 * across different providers or configurations.
 *
 * Runs the same test cases against multiple variants (provider + config),
 * scores results with pluggable scorers, and produces a statistical
 * comparison report including Welch's t-test approximations.
 *
 * Composition:
 *   - Public types live in `ab-test-types.ts`
 *   - Statistical / concurrency helpers live in `ab-test-stats.ts`
 *   - Built-in scorers live in `ab-test-scorers.ts`
 *   - Aggregation / comparison live in `ab-test-aggregation.ts`
 *   - Single-job execution lives in `ab-test-execution.ts`
 *
 * This file re-exports those modules to preserve the original public API.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import { Semaphore } from '@dzupagent/core/orchestration'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'

import {
  aggregateVariants,
  compareVariants,
  determineWinner,
} from './ab-test-aggregation.js'
import {
  buildAbortedResult,
  runSingleJob,
  type ABPipelineEvent,
} from './ab-test-execution.js'
import { acquireSemaphore, normalizeConcurrency } from './ab-test-stats.js'
import type {
  ABJob,
  ABTestCase,
  ABTestConfig,
  ABTestPlan,
  ABTestReport,
  ABTestScorer,
  ABTestVariant,
  VariantResult,
} from './ab-test-types.js'

// Re-export public types and built-in scorers for back-compat with
// `agent-adapters/src/index.ts`, which imports them from this file.
export type {
  ABComparison,
  ABTestCase,
  ABTestConfig,
  ABTestPlan,
  ABTestReport,
  ABTestScorer,
  ABTestVariant,
  ABVariantSummary,
  VariantResult,
} from './ab-test-types.js'
export { ContainsKeywordsScorer, ExactMatchScorer, LengthScorer } from './ab-test-scorers.js'

const PIPELINE_ID = 'ab-test-runner'

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

    this.emit({ type: 'pipeline:run_started', pipelineId: PIPELINE_ID, runId: plan.name })

    const jobs: ABJob[] = []
    for (const variant of plan.variants) {
      for (const testCase of plan.testCases) {
        for (let rep = 0; rep < repetitions; rep++) {
          jobs.push({ testCase, variant, repetition: rep })
        }
      }
    }

    const semaphore = new Semaphore(maxConcurrency)
    const resultPromises: Array<Promise<VariantResult>> = []

    for (const job of jobs) {
      if (plan.signal?.aborted) break

      const promise = (async (): Promise<VariantResult> => {
        const acquired = await acquireSemaphore(semaphore, plan.signal)
        try {
          if (!acquired || plan.signal?.aborted) {
            return buildAbortedResult(job)
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

    const variantSummaries = aggregateVariants(rawResults, plan.variants)
    const comparison = compareVariants(rawResults, plan.variants, plan.scorers)
    const winner = determineWinner(variantSummaries, plan.scorers)

    const completedAt = new Date()
    const totalDurationMs = completedAt.getTime() - startedAt.getTime()

    this.emit({
      type: 'pipeline:run_completed',
      pipelineId: PIPELINE_ID,
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
    return runSingleJob(this.registry, testCase, variant, scorers, (event) => this.emit(event))
  }

  private emit(event: ABPipelineEvent): void {
    if (this.eventBus) {
      this.eventBus.emit(event)
    }
  }
}
