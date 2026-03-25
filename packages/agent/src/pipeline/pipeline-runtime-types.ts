/**
 * Pipeline runtime types — execution state, node results, events,
 * and configuration for the pipeline execution engine.
 *
 * @module pipeline/pipeline-runtime-types
 */

import type {
  PipelineDefinition,
  PipelineNode,
  PipelineCheckpointStore,
} from '@forgeagent/core'

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

export type PipelineState = 'idle' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled'

// ---------------------------------------------------------------------------
// Node result
// ---------------------------------------------------------------------------

export interface NodeResult {
  nodeId: string
  output: unknown
  durationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Pipeline run result
// ---------------------------------------------------------------------------

export interface PipelineRunResult {
  pipelineId: string
  runId: string
  state: PipelineState
  nodeResults: Map<string, NodeResult>
  totalDurationMs: number
  budgetUsed?: { tokens: number; costCents: number }
}

// ---------------------------------------------------------------------------
// Node execution context
// ---------------------------------------------------------------------------

export interface NodeExecutionContext {
  /** Shared mutable pipeline state */
  state: Record<string, unknown>
  /** Results of previously completed nodes */
  previousResults: Map<string, NodeResult>
  /** Cancellation signal */
  signal?: AbortSignal
  /** Remaining budget */
  budget?: { tokensRemaining: number; costRemainingCents: number }
}

// ---------------------------------------------------------------------------
// Node executor function
// ---------------------------------------------------------------------------

export type NodeExecutor = (
  nodeId: string,
  node: PipelineNode,
  context: NodeExecutionContext,
) => Promise<NodeResult>

// ---------------------------------------------------------------------------
// Runtime events
// ---------------------------------------------------------------------------

export type PipelineRuntimeEvent =
  | { type: 'pipeline:started'; pipelineId: string; runId: string }
  | { type: 'pipeline:node_started'; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; nodeId: string; error: string }
  | { type: 'pipeline:suspended'; nodeId: string }
  | { type: 'pipeline:completed'; runId: string; totalDurationMs: number }
  | { type: 'pipeline:failed'; runId: string; error: string }
  | { type: 'pipeline:checkpoint_saved'; runId: string; version: number }
  | { type: 'pipeline:loop_iteration'; nodeId: string; iteration: number; maxIterations: number }

// ---------------------------------------------------------------------------
// Loop metrics
// ---------------------------------------------------------------------------

export interface LoopMetrics {
  iterationCount: number
  iterationDurations: number[]
  converged: boolean
  terminationReason: 'condition_met' | 'max_iterations' | 'budget_exceeded' | 'cancelled'
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export interface PipelineRuntimeConfig {
  /** Pipeline definition to execute */
  definition: PipelineDefinition
  /** Function that executes individual nodes */
  nodeExecutor: NodeExecutor
  /** Optional checkpoint store for persistence */
  checkpointStore?: PipelineCheckpointStore
  /** Named predicate functions for conditional edges and loops */
  predicates?: Record<string, (state: Record<string, unknown>) => boolean>
  /** Cancellation signal */
  signal?: AbortSignal
  /** Event callback */
  onEvent?: (event: PipelineRuntimeEvent) => void
}
