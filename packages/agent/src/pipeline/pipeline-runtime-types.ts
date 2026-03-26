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
  | { type: 'pipeline:node_retry'; nodeId: string; attempt: number; maxAttempts: number; error: string; backoffMs: number }

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
// Retry policy
// ---------------------------------------------------------------------------

/** Retry configuration for transient node failures. */
export interface RetryPolicy {
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs?: number
  /** Maximum backoff delay in ms (default: 30000) */
  maxBackoffMs?: number
  /** Backoff multiplier (default: 2) */
  multiplier?: number
  /** Error patterns that are retryable. If empty, all errors are retryable. */
  retryableErrors?: RegExp[]
}

// ---------------------------------------------------------------------------
// OTel structural types (no @forgeagent/otel import — loose coupling)
// ---------------------------------------------------------------------------

/**
 * Minimal span interface compatible with OTelSpan from @forgeagent/otel.
 * Uses structural typing so consumers can pass any compatible span.
 */
export interface OTelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown
  end(): void
}

/**
 * Structural tracer interface for pipeline node instrumentation.
 * Compatible with ForgeTracer from @forgeagent/otel but does not import it.
 */
export interface PipelineTracer {
  startPhaseSpan(phase: string, options?: { attributes?: Record<string, string | number> }): OTelSpanLike
  endSpanOk(span: OTelSpanLike): void
  endSpanWithError(span: OTelSpanLike, error: unknown): void
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
  /** Default retry policy applied when a node has `retries > 0`. */
  retryPolicy?: RetryPolicy
  /** Optional OTel tracer for creating spans per pipeline node */
  tracer?: PipelineTracer
}
