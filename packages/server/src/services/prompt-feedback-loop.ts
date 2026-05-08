/**
 * PromptFeedbackLoop — Step 2 of the closed-loop self-improvement system.
 *
 * Subscribes to `run:scored` events on a `DzupEventBus`, filters on poor-
 * performing runs, extracts the prompts that were used from the persisted
 * run events (`normalized-events.jsonl` / `raw-events.jsonl`), and invokes
 * `PromptOptimizer` with the scorer feedback attached as failures.
 *
 * When the optimizer returns a version whose `scoreImprovement` meets the
 * configured `autoPublishDelta`, the loop activates (auto-publishes) the
 * improved version. Otherwise the original active version is restored so
 * the improvement lands as a candidate only — never silently shipping a
 * regression.
 *
 * Design notes
 * ------------
 * - Purely event-driven: no polling, no direct coupling to run lifecycle.
 * - Stateless between events — all persistence is delegated to
 *   `PromptVersionStore`. The loop itself only tracks live optimizations
 *   to prevent duplicate work on retried events.
 * - Best-effort: any failure surfaces via `onError` (defaults to stderr)
 *   and never throws out of the event handler — a single bad run must not
 *   break the subscription for the entire process.
 * - Prompt-key derivation is a stable hash of prompt content so that
 *   repeated poor runs with the same system prompt accumulate into a
 *   single version history rather than a new key per run.
 *
 * MC-045: module split into focused siblings while keeping this file as the
 * public import path for callers.
 */

export type {
  OptimizationCandidateLike,
  OptimizationResult,
  OptimizationResultLike,
  PromptFeedbackLoopConfig,
  PromptFeedbackProcessResult,
  PromptOptimizer,
  PromptOptimizerLike,
  PromptVersion,
  PromptVersionLike,
  PromptVersionStore,
  PromptVersionStoreLike,
  RunScoredEvent,
  ScorerBreakdownEntry,
} from './prompt-feedback-loop-types.js'

export { PromptFeedbackLoop } from './prompt-feedback-loop-publisher.js'
