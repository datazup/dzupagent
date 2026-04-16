/**
 * ReflectionAnalyzer -- extracts patterns and computes quality scores
 * from a sequence of WorkflowEvents emitted during an agent run.
 *
 * Stateless: each `analyze()` call is independent and produces a
 * self-contained ReflectionSummary.
 *
 * @module reflection/reflection-analyzer
 */

import type { WorkflowEvent } from '../workflow/workflow-types.js'
import type { ReflectionPattern, ReflectionSummary } from './reflection-types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Thresholds for pattern detection. */
export interface ReflectionAnalyzerConfig {
  /**
   * A step is considered "slow" if its duration exceeds this multiple of the
   * median step duration. Default: 3.
   */
  slowStepMultiplier?: number
  /**
   * Minimum consecutive occurrences of the same step ID in step:started events
   * to flag as a repeated_tool pattern. Default: 2.
   */
  repeatedToolThreshold?: number
  /**
   * Minimum consecutive step:failed events to flag as an error_loop. Default: 2.
   */
  errorLoopThreshold?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Compute the median of a non-empty numeric array. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

// ---------------------------------------------------------------------------
// ReflectionAnalyzer
// ---------------------------------------------------------------------------

export class ReflectionAnalyzer {
  private readonly slowMultiplier: number
  private readonly repeatedThreshold: number
  private readonly errorLoopThreshold: number

  constructor(config?: ReflectionAnalyzerConfig) {
    this.slowMultiplier = config?.slowStepMultiplier ?? 3
    this.repeatedThreshold = config?.repeatedToolThreshold ?? 2
    this.errorLoopThreshold = config?.errorLoopThreshold ?? 2
  }

  /**
   * Analyze a completed run's workflow events and produce a ReflectionSummary.
   *
   * @param runId - The unique run identifier
   * @param events - The full ordered sequence of WorkflowEvents from the run
   */
  analyze(runId: string, events: WorkflowEvent[]): ReflectionSummary {
    const now = new Date()
    const patterns: ReflectionPattern[] = []

    // --- Gather basic stats ---
    const errorCount = events.filter((e) => e.type === 'step:failed').length
    const toolCallCount = events.filter((e) => e.type === 'step:completed').length

    // Total workflow duration from workflow:completed event, or sum of step durations
    const workflowCompleted = events.find((e) => e.type === 'workflow:completed')
    const durationMs =
      workflowCompleted?.type === 'workflow:completed'
        ? workflowCompleted.durationMs
        : this.sumStepDurations(events)

    // --- Detect patterns ---
    patterns.push(...this.detectRepeatedTools(events))
    patterns.push(...this.detectErrorLoops(events))
    patterns.push(...this.detectSlowSteps(events))
    patterns.push(...this.detectSuccessfulStrategies(events))

    // --- Compute quality score ---
    const qualityScore = this.computeQualityScore(events, errorCount, toolCallCount, patterns)

    return {
      runId,
      completedAt: now,
      durationMs,
      totalSteps: events.length,
      toolCallCount,
      errorCount,
      patterns,
      qualityScore,
    }
  }

  // ---- Pattern detectors ---------------------------------------------------

  /**
   * Detect repeated consecutive tool calls (same stepId in step:started).
   */
  private detectRepeatedTools(events: WorkflowEvent[]): ReflectionPattern[] {
    const patterns: ReflectionPattern[] = []
    const startedEvents = events
      .map((e, i) => ({ event: e, index: i }))
      .filter((x) => x.event.type === 'step:started')

    if (startedEvents.length < this.repeatedThreshold) return patterns

    let currentId: string | undefined
    let runIndices: number[] = []

    const flushRun = (): void => {
      if (currentId !== undefined && runIndices.length >= this.repeatedThreshold) {
        patterns.push({
          type: 'repeated_tool',
          description: `Tool '${currentId}' called ${runIndices.length} times consecutively`,
          occurrences: runIndices.length,
          stepIndices: [...runIndices],
        })
      }
    }

    for (const entry of startedEvents) {
      const stepId =
        entry.event.type === 'step:started' ? entry.event.stepId : ''
      if (stepId === currentId) {
        runIndices.push(entry.index)
      } else {
        flushRun()
        currentId = stepId
        runIndices = [entry.index]
      }
    }
    flushRun()

    return patterns
  }

  /**
   * Detect consecutive step:failed events (error loops).
   */
  private detectErrorLoops(events: WorkflowEvent[]): ReflectionPattern[] {
    const patterns: ReflectionPattern[] = []
    let consecutiveFailures: number[] = []

    const flushRun = (): void => {
      if (consecutiveFailures.length >= this.errorLoopThreshold) {
        patterns.push({
          type: 'error_loop',
          description: `${consecutiveFailures.length} consecutive step failures detected`,
          occurrences: consecutiveFailures.length,
          stepIndices: [...consecutiveFailures],
        })
      }
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!
      if (event.type === 'step:failed') {
        consecutiveFailures.push(i)
      } else {
        flushRun()
        consecutiveFailures = []
      }
    }
    flushRun()

    return patterns
  }

  /**
   * Detect steps whose duration significantly exceeds the median.
   */
  private detectSlowSteps(events: WorkflowEvent[]): ReflectionPattern[] {
    const patterns: ReflectionPattern[] = []
    const completedWithDuration = events
      .map((e, i) => ({ event: e, index: i }))
      .filter(
        (x): x is { event: Extract<WorkflowEvent, { type: 'step:completed' }>; index: number } =>
          x.event.type === 'step:completed',
      )

    if (completedWithDuration.length < 2) return patterns

    const durations = completedWithDuration.map((x) => x.event.durationMs)
    const med = median(durations)
    const threshold = med * this.slowMultiplier

    for (const entry of completedWithDuration) {
      if (entry.event.durationMs > threshold) {
        patterns.push({
          type: 'slow_step',
          description: `Step '${entry.event.stepId}' took ${entry.event.durationMs}ms (median: ${Math.round(med)}ms, threshold: ${Math.round(threshold)}ms)`,
          occurrences: 1,
          stepIndices: [entry.index],
        })
      }
    }

    return patterns
  }

  /**
   * Detect sequences of successful step completions without intervening failures.
   * Only reports sequences of 3+ consecutive completions as a "successful strategy".
   */
  private detectSuccessfulStrategies(events: WorkflowEvent[]): ReflectionPattern[] {
    const patterns: ReflectionPattern[] = []
    let successRun: number[] = []
    const minSuccessRun = 3

    const flushRun = (): void => {
      if (successRun.length >= minSuccessRun) {
        patterns.push({
          type: 'successful_strategy',
          description: `${successRun.length} consecutive steps completed successfully`,
          occurrences: successRun.length,
          stepIndices: [...successRun],
        })
      }
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!
      if (event.type === 'step:completed') {
        successRun.push(i)
      } else if (event.type === 'step:failed') {
        flushRun()
        successRun = []
      }
      // Other event types (step:started, branch:evaluated, etc.) don't break the run
    }
    flushRun()

    return patterns
  }

  // ---- Quality score -------------------------------------------------------

  /**
   * Compute a quality score in [0, 1] based on run characteristics.
   *
   * Scoring components:
   * - Base score: 1.0
   * - Error penalty: -0.15 per failed step (capped at -0.6)
   * - Error loop penalty: -0.1 per error_loop pattern
   * - Repeated tool penalty: -0.05 per repeated_tool pattern
   * - Workflow failure penalty: -0.3 if workflow:failed is present
   * - Success bonus: +0.1 if all steps completed without errors
   */
  private computeQualityScore(
    events: WorkflowEvent[],
    errorCount: number,
    _toolCallCount: number,
    patterns: ReflectionPattern[],
  ): number {
    let score = 1.0

    // Error penalty (capped)
    score -= Math.min(errorCount * 0.15, 0.6)

    // Pattern-based penalties
    const errorLoops = patterns.filter((p) => p.type === 'error_loop').length
    score -= errorLoops * 0.1

    const repeatedTools = patterns.filter((p) => p.type === 'repeated_tool').length
    score -= repeatedTools * 0.05

    // Workflow failure
    const hasWorkflowFailure = events.some((e) => e.type === 'workflow:failed')
    if (hasWorkflowFailure) {
      score -= 0.3
    }

    // Success bonus: no errors and at least one completed step
    if (errorCount === 0 && events.some((e) => e.type === 'step:completed')) {
      score = Math.min(score + 0.1, 1.0)
    }

    return clamp01(score)
  }

  // ---- Utility -------------------------------------------------------------

  private sumStepDurations(events: WorkflowEvent[]): number {
    let total = 0
    for (const e of events) {
      if (e.type === 'step:completed') {
        total += e.durationMs
      }
    }
    return total
  }
}
