/**
 * ReflectionLearningBridge --- bridges ReflectionAnalyzer summaries into
 * the self-learning / LearningMiddleware feedback loop.
 *
 * This module provides:
 *   1. `createReflectionLearningBridge()` --- convenience factory that
 *      returns an `onReflectionComplete` callback ready to be wired into
 *      `DzupAgentConfig.onReflectionComplete`.
 *   2. `buildWorkflowEventsFromToolStats()` --- converts ToolStat[]
 *      (from the tool loop) into WorkflowEvent[] consumable by
 *      ReflectionAnalyzer.
 *
 * Design principles:
 *   - Zero coupling to specific learning middleware implementations
 *   - All persistence is fire-and-forget (best-effort)
 *   - Purely additive --- no changes to existing interfaces
 *
 * @module reflection/learning-bridge
 */

import type { ReflectionSummary, RunReflectionStore } from './reflection-types.js'
import type { WorkflowEvent } from '../workflow/workflow-types.js'
import type { ToolStat, StopReason } from '../agent/tool-loop.js'

// ---------------------------------------------------------------------------
// Bridge Configuration
// ---------------------------------------------------------------------------

/** Options for creating a reflection-to-learning bridge. */
export interface ReflectionLearningBridgeConfig {
  /**
   * Callback invoked with each ReflectionSummary.
   * Use this to feed summaries into LearningMiddleware, PostRunAnalyzer,
   * or any custom learning system.
   */
  onSummary: (summary: ReflectionSummary) => Promise<void>

  /**
   * Optional reflection store for persisting summaries.
   * When provided, the bridge saves summaries before calling onSummary.
   */
  store?: RunReflectionStore

  /**
   * Optional filter: only forward summaries that match a condition.
   * For example, only forward summaries with quality below a threshold
   * so the learning system focuses on problematic runs.
   */
  filter?: (summary: ReflectionSummary) => boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `onReflectionComplete` callback that bridges reflection summaries
 * into a learning system.
 *
 * Usage:
 * ```typescript
 * const agent = new DzupAgent({
 *   ...config,
 *   onReflectionComplete: createReflectionLearningBridge({
 *     store: new InMemoryReflectionStore(),
 *     onSummary: async (summary) => {
 *       await learningMiddleware.onPipelineEnd({
 *         runId: summary.runId,
 *         overallScore: summary.qualityScore,
 *       })
 *     },
 *   }),
 * })
 * ```
 */
export function createReflectionLearningBridge(
  config: ReflectionLearningBridgeConfig,
): (summary: ReflectionSummary) => Promise<void> {
  return async (summary: ReflectionSummary): Promise<void> => {
    // Apply filter if configured
    if (config.filter && !config.filter(summary)) {
      return
    }

    // Persist to store (best-effort)
    if (config.store) {
      await config.store.save(summary)
    }

    // Forward to the learning handler
    await config.onSummary(summary)
  }
}

// ---------------------------------------------------------------------------
// WorkflowEvent builder
// ---------------------------------------------------------------------------

/**
 * Convert ToolStat[] and a StopReason into WorkflowEvent[] suitable for
 * ReflectionAnalyzer.analyze().
 *
 * Each ToolStat produces:
 *   - N `step:started` events (one per call)
 *   - N `step:completed` events with duration = avgMs
 *   - M `step:failed` events (for error count)
 *
 * The sequence ends with a `workflow:completed` or `workflow:failed` event
 * based on the StopReason.
 */
export function buildWorkflowEventsFromToolStats(
  toolStats: ToolStat[],
  stopReason: StopReason,
): WorkflowEvent[] {
  const events: WorkflowEvent[] = []

  // Phase 1: Emit started + completed for all successful calls
  for (const stat of toolStats) {
    const successfulCalls = stat.calls - stat.errors
    const avgMs = stat.avgMs

    for (let i = 0; i < successfulCalls; i++) {
      events.push({ type: 'step:started', stepId: stat.name })
      events.push({ type: 'step:completed', stepId: stat.name, durationMs: avgMs })
    }
  }

  // Phase 2: Emit all failures consecutively so ReflectionAnalyzer can
  // detect error_loop patterns (it requires consecutive step:failed events).
  for (const stat of toolStats) {
    for (let i = 0; i < stat.errors; i++) {
      events.push({
        type: 'step:failed',
        stepId: stat.name,
        error: `Tool "${stat.name}" failed`,
      })
    }
  }

  // Terminal event
  const totalDurationMs = toolStats.reduce((sum, s) => sum + s.totalMs, 0)
  if (stopReason === 'stuck' || stopReason === 'error') {
    events.push({
      type: 'workflow:failed',
      error: `Run ended with stopReason="${stopReason}"`,
    })
  } else {
    events.push({
      type: 'workflow:completed',
      durationMs: totalDurationMs,
    })
  }

  return events
}
