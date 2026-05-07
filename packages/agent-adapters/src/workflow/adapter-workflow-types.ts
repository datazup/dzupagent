import type { DzupEventBus } from '@dzupagent/core'

import type { AdapterProviderId } from '../types.js'

/** Configuration for the adapter workflow. */
export interface AdapterWorkflowConfig {
  id: string
  /** Semantic version of this workflow definition. Default: '1.0.0' */
  version?: string | undefined
  /** Human-readable description */
  description?: string | undefined
}

/** Configuration for a single workflow step. */
export interface AdapterStepConfig {
  /** Step identifier */
  id: string
  /** Prompt template. Can use {{prev}} for previous step result and {{state.key}} for state access */
  prompt: string
  /** Tags for routing */
  tags?: string[] | undefined
  /** Preferred provider for this step */
  preferredProvider?: AdapterProviderId | undefined
  /** Whether this step requires reasoning */
  requiresReasoning?: boolean | undefined
  /** Whether this step requires execution */
  requiresExecution?: boolean | undefined
  /** Max retries on failure. Default 0 */
  maxRetries?: number | undefined
  /** System prompt override for this step */
  systemPrompt?: string | undefined
  /** Working directory override */
  workingDirectory?: string | undefined
  /** Max turns for the adapter */
  maxTurns?: number | undefined
  /** Per-step timeout in ms. Independent of adapter timeout. */
  timeoutMs?: number | undefined
  /** Skip this step if condition returns true */
  skipIf?: (state: Record<string, unknown>) => boolean
  /** Default value when step is skipped */
  skipDefault?: string | undefined
  /**
   * Function-based prompt for type-safe state access.
   * Takes precedence over `prompt` string if both provided.
   */
  promptFn?: (state: Record<string, unknown>) => string
}

/** Result of the entire workflow. */
export interface AdapterWorkflowResult {
  workflowId: string
  success: boolean
  finalState: Record<string, unknown>
  stepResults: AdapterStepResult[]
  totalDurationMs: number
  cancelled?: true | undefined
  /** Semantic version of the workflow definition that produced this result */
  version?: string | undefined
}

/** Result of a single step. */
export interface AdapterStepResult {
  stepId: string
  result: string
  providerId: AdapterProviderId
  success: boolean
  durationMs: number
  retries: number
  error?: string | undefined
}

/** Condition function for branching. Returns the branch key to follow. */
export type BranchCondition = (state: Record<string, unknown>) => string

/** Merge strategy for parallel step results. */
export type ParallelMergeStrategy = 'merge' | 'concat' | 'last-wins'

/** Configuration for a loop construct in the workflow DSL. */
export interface LoopConfig {
  /** Unique identifier for this loop */
  id: string
  /** Maximum iterations before forced exit (safety bound) */
  maxIterations: number
  /** Continue looping while this returns true. Return false to exit. */
  condition: (state: Record<string, unknown>) => boolean
  /** Steps to execute each iteration */
  steps: AdapterStepConfig[]
  /** Action when maxIterations reached. Default: 'continue' */
  onMaxIterations?: 'continue' | 'fail'
}

/** Events emitted during workflow execution. */
export type AdapterWorkflowEvent =
  | { type: 'workflow:started'; workflowId: string; version?: string | undefined }
  | { type: 'step:started'; workflowId: string; stepId: string }
  | { type: 'step:completed'; workflowId: string; stepId: string; durationMs: number; providerId: string }
  | { type: 'step:failed'; workflowId: string; stepId: string; error: string; retryCount: number }
  | { type: 'step:retrying'; workflowId: string; stepId: string; attempt: number; maxRetries: number }
  | { type: 'parallel:started'; workflowId: string; stepIds: string[] }
  | { type: 'parallel:completed'; workflowId: string; stepIds: string[]; durationMs: number }
  | { type: 'branch:evaluated'; workflowId: string; selected: string }
  | { type: 'workflow:completed'; workflowId: string; durationMs: number; version?: string | undefined }
  | { type: 'step:skipped'; workflowId: string; stepId: string }
  | { type: 'workflow:failed'; workflowId: string; error: string }

/** Options for running a workflow. */
export interface AdapterWorkflowRunOptions {
  initialState?: Record<string, unknown> | undefined
  signal?: AbortSignal | undefined
  eventBus?: DzupEventBus | undefined
  onEvent?: (event: AdapterWorkflowEvent) => void
}
