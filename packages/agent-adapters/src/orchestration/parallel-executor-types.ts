/**
 * Public types for ParallelExecutor.
 *
 * Split out from `parallel-executor.ts` so that helper modules
 * (abort/result helpers) can share these definitions without
 * pulling in the orchestrator class.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type {
  AdapterProviderId,
  AgentEvent,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Merge strategy
// ---------------------------------------------------------------------------

/**
 * Strategy for selecting among parallel adapter responses (provider selection).
 * Not the same as workflow-level MergeStrategy in workflow-types.ts, which
 * controls data-shape merging of step results.
 */
export type MergeStrategy = 'first-wins' | 'all' | 'best-of-n'

// ---------------------------------------------------------------------------
// Configuration / options
// ---------------------------------------------------------------------------

export interface ParallelExecutorConfig {
  registry: import('../registry/adapter-registry.js').ProviderAdapterRegistry
  eventBus?: DzupEventBus | undefined
}

export interface ParallelExecutionOptions {
  /** Which providers to run on */
  providers: AdapterProviderId[]
  /** How to pick the winning result */
  mergeStrategy: MergeStrategy
  /** Abort signal for external cancellation */
  signal?: AbortSignal | undefined
  /** Maximum time (ms) to wait for all providers */
  timeoutMs?: number | undefined
  /** Scoring function for 'best-of-n' — higher is better */
  scorer?: (result: ProviderResult) => number
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ProviderResult {
  providerId: AdapterProviderId
  sessionId?: string | undefined
  result: string
  success: boolean
  durationMs: number
  usage?: TokenUsage | undefined
  error?: string | undefined
  cancelled?: true | undefined
  events: AgentEvent[]
}

export interface ParallelExecutionResult {
  /** The winning result based on the merge strategy */
  selectedResult: ProviderResult
  /** All provider results (including failures) */
  allResults: ProviderResult[]
  /** Which strategy was used */
  strategy: MergeStrategy
  /** Wall-clock duration for the entire parallel execution */
  totalDurationMs: number
  cancelled?: true | undefined
}
