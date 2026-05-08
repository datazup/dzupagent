/**
 * Single-job execution helpers for the A/B testing framework.
 *
 * Extracted from `ab-test-runner.ts` to keep the runner focused on
 * plan-level orchestration. These helpers run a single (testCase, variant)
 * pair through the appropriate provider adapter and score the result.
 */

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AgentCompletedEvent } from '../types.js'

import type {
  ABJob,
  ABTestCase,
  ABTestScorer,
  ABTestVariant,
  VariantResult,
} from './ab-test-types.js'

/**
 * Pipeline lifecycle events emitted while executing test jobs. The runner
 * forwards these onto the configured `DzupEventBus`, when present.
 */
export type ABPipelineEvent =
  | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
  | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
  | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string }

export type ABEmitFn = (event: ABPipelineEvent) => void

const PIPELINE_ID = 'ab-test-runner'

/**
 * Score a result with all configured scorers. Failures are silently
 * dropped (the scorer is simply omitted from the resulting record) so a
 * single bad scorer cannot poison the run.
 */
export async function scoreResult(
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
  }

  return scores
}

/**
 * Run a single test case on a single variant, scoring with all provided scorers.
 *
 * Emits `pipeline:node_started`, `pipeline:node_completed`, and
 * `pipeline:node_failed` events via the supplied emit function.
 */
export async function runSingleJob(
  registry: ProviderAdapterRegistry,
  testCase: ABTestCase,
  variant: ABTestVariant,
  scorers: ABTestScorer[],
  emit: ABEmitFn,
): Promise<VariantResult> {
  const adapter = registry.get(variant.providerId)

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

  if (variant.configOverrides) {
    adapter.configure(variant.configOverrides)
  }

  const startMs = Date.now()
  const runId = `${variant.name}:${testCase.id}`
  let resultText = ''

  emit({
    type: 'pipeline:node_started',
    pipelineId: PIPELINE_ID,
    runId,
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
    const scores = await scoreResult(resultText, testCase, scorers)

    emit({
      type: 'pipeline:node_completed',
      pipelineId: PIPELINE_ID,
      runId,
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

    emit({
      type: 'pipeline:node_failed',
      pipelineId: PIPELINE_ID,
      runId,
      nodeId: variant.providerId,
      error: message,
    })

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

/**
 * Build a synthetic `VariantResult` for an aborted job so the caller
 * always gets a one-to-one mapping from job to result.
 */
export function buildAbortedResult(job: ABJob): VariantResult {
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
