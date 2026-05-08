/**
 * PromptFeedbackLoop types — public surface and structural shapes.
 *
 * Declares the optimizer/version-store contracts as local interfaces so the
 * server package does not take a runtime dependency on `@dzupagent/evals`
 * (MC-A02 layer-inversion fix). Hosts construct concrete instances and pass
 * them via config.
 */

import type { DzupEvent, DzupEventBus } from '@dzupagent/core/events'
import type { EvalDatasetLike } from '@dzupagent/eval-contracts'

/**
 * Minimal structural shape of @dzupagent/evals `PromptOptimizer`. Declared
 * locally so the server package does not take a runtime dependency on evals
 * (MC-A02 layer-inversion fix). Hosts that want the feedback loop construct
 * a real `PromptOptimizer` from `@dzupagent/evals` and pass it via config.
 */
export interface PromptOptimizerLike {
  optimize(input: {
    promptKey: string
    dataset: EvalDatasetLike
    failures: Array<{ input: string; output: string; feedback: string }>
  }): Promise<OptimizationResultLike>
}

export interface OptimizationCandidateLike {
  prompt: string
  score: number
}

export interface PromptVersionLike {
  id: string
  promptKey: string
  content: string
  active?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
  createdAt?: string | undefined
}

export interface OptimizationResultLike {
  baselineScore: number
  bestCandidate: OptimizationCandidateLike | null
  candidates: OptimizationCandidateLike[]
  iterations: number
  /** True when the optimizer produced a better version than the original. */
  improved: boolean
  /** Version the optimizer considered best after its round. */
  bestVersion: PromptVersionLike
  /** Version the optimizer was seeded with (baseline). */
  originalVersion: PromptVersionLike
  /** `bestVersion.score - originalVersion.score`. */
  scoreImprovement: number
}

export interface PromptVersionStoreLike {
  getLatest(key: string): Promise<PromptVersionLike | null>
  getActive(key: string): Promise<PromptVersionLike | null>
  save(input: {
    promptKey: string
    content: string
    metadata?: Record<string, unknown> | undefined
    active?: boolean | undefined
  }): Promise<PromptVersionLike>
  activate(versionId: string): Promise<PromptVersionLike>
  list(key: string): Promise<PromptVersionLike[]>
}

// Backward-compat type aliases for the older names used within this module.
// These were previously imported from @dzupagent/evals.
export type OptimizationResult = OptimizationResultLike
export type PromptOptimizer = PromptOptimizerLike
export type PromptVersion = PromptVersionLike
export type PromptVersionStore = PromptVersionStoreLike

// ---------------------------------------------------------------------------
// Public config / types
// ---------------------------------------------------------------------------

export type RunScoredEvent = Extract<DzupEvent, { type: 'run:scored' }>
export type ScorerBreakdownEntry = RunScoredEvent['scorerBreakdown'][number]

export interface PromptFeedbackLoopConfig {
  /** Event bus to subscribe to `run:scored` events on. */
  eventBus: DzupEventBus
  /** Preconfigured optimizer — owns its own meta/eval models + scorers. */
  promptOptimizer: PromptOptimizer
  /** Version store used to seed baseline prompts and publish improvements. */
  promptVersionStore: PromptVersionStore
  /** Root directory where `.dzupagent/runs/<runId>/` lives (same as RunOutcomeAnalyzer). */
  projectDir: string
  /** Score threshold below which a run triggers optimization. Default: 0.7. */
  poorRunThreshold?: number
  /**
   * Minimum improvement delta required to auto-publish (activate) a rewritten
   * prompt. Default: 0.05. Set to `Infinity` to disable auto-publish entirely.
   */
  autoPublishDelta?: number
  /**
   * Optional prefix/namespace for auto-derived prompt keys. Defaults to
   * `run-prompt`, producing keys like `run-prompt:<sha1-12>`.
   */
  promptKeyPrefix?: string
  /**
   * Optional sink for soft-failures. Receives a short error message and the
   * `runId` so hosts can surface it in their own logs. Defaults to a stderr
   * warning.
   */
  onError?: (runId: string, message: string) => void
  /**
   * Factory that constructs an `EvalDatasetLike` from a single (input, output)
   * sample so the optimizer can re-evaluate candidate prompts. Defaults to a
   * minimal inline implementation; hosts may pass
   * `(entries, meta) => EvalDataset.from(entries, meta)` from `@dzupagent/evals`
   * to use the canonical implementation.
   */
  datasetFactory?: (
    entries: ReadonlyArray<{ id: string; input: string; expectedOutput?: string }>,
    meta: { name: string },
  ) => EvalDatasetLike
}

export interface PromptFeedbackProcessResult {
  runId: string
  skipped: boolean
  skipReason?: 'above-threshold' | 'no-prompts' | 'already-processing' | 'not-started'
  promptsProcessed: number
  optimizations: Array<{
    promptKey: string
    optimizationResult: OptimizationResult
    published: boolean
  }>
}
