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
  /**
   * RUN-REFLECTION-STORE-WIDEN: tenant scope stamped by the run worker at
   * persistence time. Optional in the type for back-compat with callers that
   * synthesise summaries (analyzer output, learning bridge, tests). Storage
   * backends apply a 'default' fallback so legacy rows remain filterable.
   */
  tenantId?: string
  /**
   * RUN-REFLECTION-STORE-WIDEN: API key id that owns the originating run.
   * Optional everywhere — legacy ownerless reflections may pre-date owner
   * stamping and stay visible under the `includeLegacyOwnerless` semantics
   * documented on {@link ReflectionListOptions}.
   */
  ownerId?: string
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/**
 * Tenant/owner filter accepted by {@link RunReflectionStore.list} and
 * {@link RunReflectionStore.getPatterns}.
 *
 * - `tenantId` — exact-match. When set, only reflections stamped with the
 *   same tenant are returned.
 * - `ownerId` — exact-match WITH `includeLegacyOwnerless` semantics: rows
 *   whose `ownerId` is null/undefined are still visible. This mirrors the
 *   pattern used by `routing-stats` and the original
 *   `filterReflectionsByOwnership` route helper, so callers migrating from
 *   the in-route filter retain identical visibility for pre-stamping rows.
 *
 * When neither filter is set, behaviour is unchanged from the legacy
 * `list(limit?)` signature.
 */
export interface ReflectionListOptions {
  /** Maximum number of summaries to return. */
  limit?: number
  /** Restrict to reflections stamped with this tenant. */
  tenantId?: string
  /**
   * Restrict to reflections owned by this api-key id OR ownerless legacy
   * rows. Pass `undefined` to disable owner filtering.
   */
  ownerId?: string
}

/**
 * Filter options accepted by {@link RunReflectionStore.getPatterns}. The
 * filter applies to the parent reflection, not to the pattern shape.
 */
export type ReflectionPatternOptions = Pick<ReflectionListOptions, 'tenantId' | 'ownerId'>

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
  /**
   * List summaries ordered by `completedAt` descending (most recent first).
   *
   * Accepts either a numeric `limit` (legacy signature, preserved for
   * back-compat) or a {@link ReflectionListOptions} object with optional
   * tenant/owner filters. When neither filter is set, behaviour is
   * identical to the legacy call.
   */
  list(opts?: number | ReflectionListOptions): Promise<ReflectionSummary[]>
  /**
   * Return all patterns of a given type across stored summaries. Accepts an
   * optional {@link ReflectionPatternOptions} for tenant/owner scoping.
   */
  getPatterns(
    type: ReflectionPattern['type'],
    opts?: ReflectionPatternOptions,
  ): Promise<ReflectionPattern[]>
}
