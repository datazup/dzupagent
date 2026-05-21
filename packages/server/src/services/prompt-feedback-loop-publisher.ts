/**
 * PromptFeedbackLoop publisher — owns the event subscription, the
 * `processRun` orchestration, and the auto-publish policy.
 */

import { createHash } from 'node:crypto'

import type { DzupEventBus } from '@dzupagent/core/events'

import {
  clamp01,
  defaultDatasetFactory,
  defaultOnError,
  stringifyError,
} from './prompt-feedback-loop-optimizer.js'
import {
  deriveInput,
  deriveOutput,
  extractPrompts,
  readNormalizedEvents,
  toFailureFeedback,
} from './prompt-feedback-loop-scoring.js'
import type {
  OptimizationResult,
  PromptFeedbackLoopConfig,
  PromptFeedbackProcessResult,
  PromptOptimizer,
  PromptVersion,
  PromptVersionStore,
  ScorerBreakdownEntry,
} from './prompt-feedback-loop-types.js'
import type { AgentEvent } from '@dzupagent/agent-adapters/runs'

export class PromptFeedbackLoop {
  private readonly eventBus: DzupEventBus
  private readonly promptOptimizer: PromptOptimizer
  private readonly promptVersionStore: PromptVersionStore
  private readonly projectDir: string
  private readonly poorRunThreshold: number
  private readonly autoPublishDelta: number
  private readonly promptKeyPrefix: string
  private readonly onError: (runId: string, message: string) => void
  private readonly datasetFactory: NonNullable<PromptFeedbackLoopConfig['datasetFactory']>

  private unsubscribe: (() => void) | null = null
  private readonly inFlight = new Set<string>()

  constructor(config: PromptFeedbackLoopConfig) {
    if (!config.eventBus) {
      throw new Error('PromptFeedbackLoop: eventBus is required')
    }
    if (!config.promptOptimizer) {
      throw new Error('PromptFeedbackLoop: promptOptimizer is required')
    }
    if (!config.promptVersionStore) {
      throw new Error('PromptFeedbackLoop: promptVersionStore is required')
    }
    if (!config.projectDir) {
      throw new Error('PromptFeedbackLoop: projectDir is required')
    }

    this.eventBus = config.eventBus
    this.promptOptimizer = config.promptOptimizer
    this.promptVersionStore = config.promptVersionStore
    this.projectDir = config.projectDir
    this.poorRunThreshold = clamp01(config.poorRunThreshold ?? 0.7)
    // `Infinity` is a legitimate value — it disables auto-publish entirely.
    // Only fall back to the default when the caller supplied `undefined` or a
    // non-numeric value (NaN, etc.).
    this.autoPublishDelta =
      typeof config.autoPublishDelta === 'number' && !Number.isNaN(config.autoPublishDelta)
        ? config.autoPublishDelta
        : 0.05
    this.promptKeyPrefix =
      typeof config.promptKeyPrefix === 'string' && config.promptKeyPrefix.length > 0
        ? config.promptKeyPrefix
        : 'run-prompt'
    this.onError = config.onError ?? defaultOnError
    this.datasetFactory = config.datasetFactory ?? defaultDatasetFactory
  }

  /**
   * Subscribe to `run:scored` events on the bus. Safe to call multiple
   * times — subsequent calls are no-ops while an active subscription is
   * already live.
   */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.eventBus.on('run:scored', (event) => {
      // Fire-and-forget — bus swallows promise rejections, so we handle
      // our own errors here too.
      void this.processRun(event.runId, event.score, event.scorerBreakdown).catch((err) => {
        this.onError(event.runId, `processRun threw: ${stringifyError(err)}`)
      })
    })
  }

  /** Unsubscribe from the bus. No-op when not started. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /**
   * Process a single scored run. Public for testability and for hosts that
   * want to trigger optimization on-demand (e.g. a /rerun endpoint).
   */
  async processRun(
    runId: string,
    score: number,
    scorerBreakdown: readonly ScorerBreakdownEntry[],
  ): Promise<PromptFeedbackProcessResult> {
    if (!runId) {
      this.onError('', 'processRun(): runId is required')
      return {
        runId: '',
        skipped: true,
        skipReason: 'not-started',
        promptsProcessed: 0,
        optimizations: [],
      }
    }

    // Skip anything above (or equal to) the threshold — no optimization needed.
    if (score >= this.poorRunThreshold) {
      return {
        runId,
        skipped: true,
        skipReason: 'above-threshold',
        promptsProcessed: 0,
        optimizations: [],
      }
    }

    // De-dupe concurrent optimizations for the same run (e.g. replayed event).
    if (this.inFlight.has(runId)) {
      return {
        runId,
        skipped: true,
        skipReason: 'already-processing',
        promptsProcessed: 0,
        optimizations: [],
      }
    }
    this.inFlight.add(runId)

    try {
      let events: AgentEvent[] = []
      try {
        events = await readNormalizedEvents(this.projectDir, runId)
      } catch (err) {
        this.onError(runId, `Failed to read normalized-events.jsonl: ${stringifyError(err)}`)
        // Fall through — no events means no prompts, which we handle below.
      }

      const prompts = extractPrompts(events)
      if (prompts.length === 0) {
        return {
          runId,
          skipped: true,
          skipReason: 'no-prompts',
          promptsProcessed: 0,
          optimizations: [],
        }
      }

      const derivedInput = deriveInput(events)
      const derivedOutput = deriveOutput(events)
      const feedback = toFailureFeedback(derivedInput, derivedOutput, scorerBreakdown)

      const optimizations: PromptFeedbackProcessResult['optimizations'] = []

      for (const prompt of prompts) {
        const promptKey = this.derivePromptKey(prompt)
        try {
          const baseline = await this.ensureBaselineVersion(promptKey, prompt)
          const dataset = this.datasetFactory(
            [
              {
                id: `${promptKey}-sample`,
                input: derivedInput,
                expectedOutput: derivedOutput,
              },
            ],
            { name: `feedback-loop:${promptKey}` },
          )

          const optimizationResult = await this.promptOptimizer.optimize({
            promptKey,
            dataset,
            failures: feedback,
          })

          const published = await this.maybePublish(optimizationResult, baseline, runId)

          optimizations.push({ promptKey, optimizationResult, published })
        } catch (err) {
          this.onError(runId, `Optimizer failed for promptKey=${promptKey}: ${stringifyError(err)}`)
        }
      }

      return {
        runId,
        skipped: false,
        promptsProcessed: prompts.length,
        optimizations,
      }
    } finally {
      this.inFlight.delete(runId)
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Ensure an active baseline version exists for the given prompt key. Returns
   * the currently active version after ensuring.
   */
  private async ensureBaselineVersion(
    promptKey: string,
    promptContent: string,
  ): Promise<PromptVersion> {
    const existing = await this.promptVersionStore.getActive(promptKey)
    if (existing) return existing

    return this.promptVersionStore.save({
      promptKey,
      content: promptContent,
      metadata: { source: 'prompt-feedback-loop-baseline' },
      active: true,
    })
  }

  /**
   * Apply the auto-publish policy. Returns `true` when the improved version
   * is left active, `false` when we reverted to the original baseline.
   */
  private async maybePublish(
    result: OptimizationResult,
    baseline: PromptVersion,
    runId: string,
  ): Promise<boolean> {
    if (!result.improved || result.bestVersion.id === result.originalVersion.id) {
      return false
    }

    if (result.scoreImprovement >= this.autoPublishDelta) {
      // The optimizer internally activates its best version at the end of a
      // successful round, so re-activating here is idempotent. We still call
      // it to enforce the publish invariant even when the optimizer was a
      // no-op (e.g. stub in tests). Failures are logged but do not flip the
      // published flag — the intent was to publish, and the optimizer's own
      // activation already landed on disk.
      try {
        await this.promptVersionStore.activate(result.bestVersion.id)
      } catch (err) {
        this.onError(runId, `Failed to re-activate version ${result.bestVersion.id}: ${stringifyError(err)}`)
      }
      return true
    }

    // Not enough improvement — restore the baseline so we don't accidentally
    // leave an unvetted candidate active (the optimizer internally activates
    // the best candidate at the end of a successful round).
    try {
      await this.promptVersionStore.activate(baseline.id)
    } catch (err) {
      this.onError(runId, `Failed to restore baseline ${baseline.id}: ${stringifyError(err)}`)
    }
    return false
  }

  private derivePromptKey(prompt: string): string {
    const hash = createHash('sha1').update(prompt).digest('hex').slice(0, 12)
    return `${this.promptKeyPrefix}:${hash}`
  }
}
