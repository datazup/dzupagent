/**
 * OrchestrationMergeStrategy — pluggable result merging for parallel multi-agent runs.
 *
 * NOTE: This is named OrchestrationMergeStrategy (not MergeStrategy) to avoid
 * collision with the existing workflow MergeStrategy type alias in workflow-types.ts.
 *
 * Built-in strategies: AllRequired, UsePartial, FirstWins
 */

/** Result from a single agent in a parallel orchestration */
export interface AgentResult<T = unknown> {
  /** Agent ID */
  agentId: string
  /** Execution status */
  status: 'success' | 'timeout' | 'error'
  /** Output (only present when status === 'success') */
  output?: T
  /** Error message (only present when status === 'error') */
  error?: string
  /** Duration of this agent's execution in ms */
  durationMs?: number
}

/** The merged result returned to the supervisor */
export interface MergedResult<T = unknown> {
  /** Overall status of the merge */
  status: 'success' | 'partial' | 'all_timeout' | 'all_failed'
  /** The merged/selected output */
  output?: T
  /** Per-agent results preserved for debugging */
  agentResults: AgentResult<T>[]
  /** Number of agents that succeeded */
  successCount: number
  /** Number of agents that timed out */
  timeoutCount: number
  /** Number of agents that failed */
  errorCount: number
}

/**
 * OrchestrationMergeStrategy — defines how parallel agent results are combined.
 *
 * The supervisor invokes merge() after all parallel agents complete (or timeout).
 */
export interface OrchestrationMergeStrategy<T = unknown> {
  /**
   * Merge results from parallel agents into a single MergedResult.
   * Called after all agents finish (or their timeouts expire).
   */
  merge(results: AgentResult<T>[]): MergedResult<T>
}

/** Strategy names for built-in strategies */
export type BuiltInMergeStrategyName = 'all-required' | 'use-partial' | 'first-wins'
