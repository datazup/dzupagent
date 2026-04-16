/**
 * Reflection module types for post-run analysis and pattern detection.
 *
 * These types support analyzing completed agent runs to extract recurring
 * patterns (repeated tool calls, error loops, successful strategies, slow steps)
 * and compute aggregate quality scores. The data feeds into the self-improvement
 * / learning loop.
 *
 * @module reflection/reflection-types
 */

// ---------------------------------------------------------------------------
// ReflectionPattern
// ---------------------------------------------------------------------------

/** A detected behavioral pattern from a completed run. */
export interface ReflectionPattern {
  /**
   * The category of detected pattern:
   * - `repeated_tool`: The same tool was called multiple times consecutively
   * - `error_loop`: A step failed repeatedly in sequence
   * - `successful_strategy`: A tool/step sequence that completed without errors
   * - `slow_step`: A step that took significantly longer than the median
   */
  type: 'repeated_tool' | 'error_loop' | 'successful_strategy' | 'slow_step'
  /** Human-readable description of what was detected. */
  description: string
  /** How many times this pattern occurred in the run. */
  occurrences: number
  /** Zero-based indices of the workflow events where the pattern was observed. */
  stepIndices: number[]
}

// ---------------------------------------------------------------------------
// ReflectionSummary
// ---------------------------------------------------------------------------

/** Aggregate summary of a completed agent run, produced by `ReflectionAnalyzer`. */
export interface ReflectionSummary {
  /** The run's unique identifier. */
  runId: string
  /** When the run finished. */
  completedAt: Date
  /** Total wall-clock duration in milliseconds. */
  durationMs: number
  /** Total number of workflow events (steps) processed. */
  totalSteps: number
  /** Number of tool-related events (step:started / step:completed pairs). */
  toolCallCount: number
  /** Number of step:failed events. */
  errorCount: number
  /** Detected behavioral patterns. */
  patterns: ReflectionPattern[]
  /** Overall quality score in the range [0, 1]. */
  qualityScore: number
}

// ---------------------------------------------------------------------------
// RunReflectionStore
// ---------------------------------------------------------------------------

/**
 * Persistence interface for reflection summaries.
 *
 * Implementations range from a simple in-memory map (for testing/dev) to
 * database-backed stores for production.
 */
export interface RunReflectionStore {
  /** Persist a reflection summary. */
  save(summary: ReflectionSummary): Promise<void>
  /** Retrieve a summary by run ID, or `undefined` if not found. */
  get(runId: string): Promise<ReflectionSummary | undefined>
  /** List summaries ordered by `completedAt` descending (most recent first). */
  list(limit?: number): Promise<ReflectionSummary[]>
  /** Return all patterns of a given type across all stored summaries. */
  getPatterns(type: ReflectionPattern['type']): Promise<ReflectionPattern[]>
}
