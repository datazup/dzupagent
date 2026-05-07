/**
 * Pure data types for Arrow-based token-budgeted memory selection.
 *
 * Extracted into its own module to break the circular dependency between
 * `agent-types.ts` and `memory-profiles.ts`. This file MUST remain
 * import-free (no runtime or type imports from sibling modules) so it can
 * be safely consumed from either side of the cycle.
 */

/** Configuration for Arrow-based token-budgeted memory selection. */
export interface ArrowMemoryConfig {
  /** Total context window budget in tokens (default: 128000) */
  totalBudget?: number
  /** Max fraction of budget for memory context (default: 0.3) */
  maxMemoryFraction?: number
  /** Min tokens reserved for response (default: 4000) */
  minResponseReserve?: number
  /** Current conversation phase for phase-weighted selection */
  currentPhase?: 'planning' | 'coding' | 'debugging' | 'reviewing' | 'general'
}
