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
} from '@dzipagent/core'
import type { RecoveryCopilot } from '../recovery/recovery-copilot.js'
import type { PipelineStuckDetector } from '../self-correction/pipeline-stuck-detector.js'
import type { TrajectoryCalibrator } from '../self-correction/trajectory-calibrator.js'

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
  /** Hint from stuck detector suggesting the node should try a different strategy */
  stuckHint?: string
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
  | { type: 'pipeline:recovery_attempted'; nodeId: string; attempt: number; maxAttempts: number; error: string }
  | { type: 'pipeline:recovery_succeeded'; nodeId: string; attempt: number; summary: string }
  | { type: 'pipeline:recovery_failed'; nodeId: string; attempt: number; error: string }
  | { type: 'pipeline:stuck_detected'; nodeId: string; reason: string; suggestedAction: string }
  | { type: 'pipeline:node_output_recorded'; nodeId: string; outputHash: string }
  | { type: 'pipeline:calibration_suboptimal'; nodeId: string; baseline: number; currentScore: number; deviation: number; suggestion: string }
  | { type: 'pipeline:iteration_budget_warning'; level: 'warn_70' | 'warn_90'; totalCost: number; budgetCents: number; iteration: number }

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
  /** Backoff multiplier (default: 2). Alias: `backoffMultiplier`. */
  multiplier?: number
  /** Alias for `multiplier` (default: 2). If both are set, `multiplier` takes precedence. */
  backoffMultiplier?: number
  /**
   * When true, adds random jitter (0-50%) to the calculated backoff delay
   * to prevent thundering-herd problems. Default: false.
   */
  jitter?: boolean
  /**
   * Error patterns that are retryable. If empty/unset, all errors are retryable.
   * - `string` values match via `error.includes(pattern)`
   * - `RegExp` values match via `pattern.test(error)`
   */
  retryableErrors?: Array<string | RegExp>
}

// ---------------------------------------------------------------------------
// OTel structural types (no @dzipagent/otel import — loose coupling)
// ---------------------------------------------------------------------------

/**
 * Minimal span interface compatible with OTelSpan from @dzipagent/otel.
 * Uses structural typing so consumers can pass any compatible span.
 */
export interface OTelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown
  end(): void
}

/**
 * Structural tracer interface for pipeline node instrumentation.
 * Compatible with DzipTracer from @dzipagent/otel but does not import it.
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
  /** Optional stuck detector for cross-node stuck detection */
  stuckDetector?: PipelineStuckDetector
  /** Optional recovery copilot for automatic failure recovery */
  recoveryCopilot?: {
    /** The RecoveryCopilot instance to use for recovery attempts */
    copilot: RecoveryCopilot
    /** Only attempt recovery for these node IDs (if empty/unset, all nodes are eligible) */
    enabledForNodes?: string[]
    /** Max total recovery attempts per pipeline run (default: 3) */
    maxRecoveryAttempts?: number
  }
  /**
   * Optional trajectory calibrator for step-level quality tracking.
   * When configured, each node's quality score (from output) is compared
   * against historical baselines. Suboptimal results emit a calibration event.
   */
  trajectoryCalibrator?: {
    /** Function to extract a quality score (0-1) from a node result. Returns undefined to skip. */
    extractQuality: (nodeId: string, result: NodeResult) => number | undefined
    /** Task type for baseline grouping (e.g., 'feature_gen') */
    taskType: string
    /** The TrajectoryCalibrator instance */
    calibrator: TrajectoryCalibrator
  }
  /**
   * Optional global iteration budget for the entire pipeline run.
   * When configured, tracks cumulative cost across all retried/failed nodes
   * and emits budget warning events at 70% and 90% thresholds.
   */
  iterationBudget?: {
    /** Maximum total cost in cents across the pipeline run */
    maxCostCents: number
    /** Function to extract cost from a node result. Returns 0 to skip. */
    extractCost: (nodeId: string, result: NodeResult) => number
  }
}
