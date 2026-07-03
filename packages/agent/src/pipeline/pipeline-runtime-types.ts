/**
 * Pipeline runtime types — execution state, node results, events,
 * and configuration for the pipeline execution engine.
 *
 * The pure structural shapes (`PipelineState`, `NodeResult`,
 * `NodeExecutionContext`, `NodeExecutor`, `PipelineRunResult`,
 * `PipelineRuntimeEvent`, `LoopMetrics`) live in
 * `@dzupagent/runtime-contracts`. They are re-exported here so existing
 * imports of `@dzupagent/agent/pipeline` continue to resolve unchanged
 * (BC re-export shim for REC-H-10).
 *
 * Agent-specific extensions (the canonical `RetryPolicy` shape, OTel
 * structural typing, and the full `PipelineRuntimeConfig`) remain in
 * this module because they pull in agent-only collaborators
 * (`RecoveryCopilot`, `PipelineStuckDetector`, `TrajectoryCalibrator`,
 * checkpoint-store client adapters) that should not bleed into the
 * neutral runtime-contracts package.
 *
 * @module pipeline/pipeline-runtime-types
 */

import type {
  PipelineDefinition,
  PipelineNode,
  ToolNode,
  PipelineCheckpointStore,
  PipelineCheckpointExecutionLog,
  PipelineCheckpointProviderSessionRef,
} from "@dzupagent/core/pipeline";
import type {
  NodeExecutionContext,
  NodeExecutor as RuntimeNodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  ProviderSessionRef,
} from "@dzupagent/runtime-contracts";
import type { RecoveryCopilot } from "../recovery/recovery-copilot.js";
import type { PipelineStuckDetector } from "../self-correction/pipeline-stuck-detector.js";
import type { TrajectoryCalibrator } from "../self-correction/trajectory-calibrator.js";
import type { RedisClientLike } from "./redis-checkpoint-store.js";
import type { PostgresClientLike } from "./postgres-checkpoint-store.js";

// ---------------------------------------------------------------------------
// Re-exported pure runtime contracts (REC-H-10 BC shim)
// ---------------------------------------------------------------------------

export type {
  PipelineState,
  NodeResult,
  NodeExecutionContext,
  PipelineRunResult,
  PipelineRuntimeEvent,
  LoopMetrics,
  ProviderSessionRef,
} from "@dzupagent/runtime-contracts";

/**
 * Concrete `NodeExecutor` alias bound to the canonical `PipelineNode`
 * discriminated union from `@dzupagent/core`.
 *
 * `@dzupagent/runtime-contracts` exports a generic `NodeExecutor<TNode>`
 * that is parameterised so the contracts package stays free of a
 * `@dzupagent/core` dependency. Inside the agent runtime we always
 * specialise it to the canonical `PipelineNode`.
 */
export type NodeExecutor = RuntimeNodeExecutor<PipelineNode>;

export interface RuntimeToolHandlerInput {
  nodeId: string;
  node: ToolNode;
  arguments: Record<string, unknown>;
  context: NodeExecutionContext;
}

export interface RuntimeToolStructuredError {
  message: string;
  code?: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeToolHandlerSuccessResult {
  readonly __dzupRuntimeToolResult: true;
  readonly ok: true;
  output: unknown;
  providerSessionRefs?: ProviderSessionRef[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeToolHandlerFailureResult {
  readonly __dzupRuntimeToolResult: true;
  readonly ok: false;
  error: RuntimeToolStructuredError;
  output?: unknown;
  providerSessionRefs?: ProviderSessionRef[];
}

export type RuntimeToolHandlerResult =
  | RuntimeToolHandlerSuccessResult
  | RuntimeToolHandlerFailureResult;

export type RuntimeToolHandler = (
  input: RuntimeToolHandlerInput,
) => Promise<unknown | RuntimeToolHandlerResult>;

export type RuntimeToolHandlers = Record<string, RuntimeToolHandler>;

export interface PipelineExecutionLogEntry
  extends PipelineCheckpointExecutionLog {
  /** Pipeline definition ID this run belongs to. */
  pipelineId: string;
  /** Unique run identifier. */
  pipelineRunId: string;
  /** Checkpoint version that produced this execution-log snapshot. */
  checkpointVersion: number;
  /** Provider session handles captured in the same checkpoint snapshot. */
  providerSessionRefs?: PipelineCheckpointProviderSessionRef[];
}

export interface PipelineExecutionLogStore {
  /** Append one execution-log snapshot produced by a checkpoint save. */
  append(entry: PipelineExecutionLogEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

import type { RetryPolicy as CanonicalRetryPolicy } from "@dzupagent/agent-types";

/**
 * Retry configuration for transient node failures.
 *
 * Extends the canonical `RetryPolicy` from `@dzupagent/agent-types` with a
 * pipeline-specific `retryableErrors` filter. The shared fields
 * (`initialBackoffMs`, `maxBackoffMs`, `multiplier`, `backoffMultiplier`,
 * `jitter`) come from the canonical shape.
 */
export interface RetryPolicy extends Omit<
  CanonicalRetryPolicy,
  "initialBackoffMs" | "maxBackoffMs" | "jitter"
> {
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs?: number;
  /** Maximum backoff delay in ms (default: 30000) */
  maxBackoffMs?: number;
  /**
   * When true, adds random jitter (0-50%) to the calculated backoff delay
   * to prevent thundering-herd problems. Default: false.
   */
  jitter?: boolean;
  /**
   * Error patterns that are retryable. If empty/unset, all errors are retryable.
   * - `string` values match via `error.includes(pattern)`
   * - `RegExp` values match via `pattern.test(error)`
   */
  retryableErrors?: Array<string | RegExp>;
}

// ---------------------------------------------------------------------------
// OTel structural types (no @dzupagent/otel import — loose coupling)
// ---------------------------------------------------------------------------

/**
 * Minimal span interface compatible with OTelSpan from @dzupagent/otel.
 * Uses structural typing so consumers can pass any compatible span.
 */
export interface OTelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  end(): void;
}

/**
 * Structural tracer interface for pipeline node instrumentation.
 * Compatible with DzupTracer from @dzupagent/otel but does not import it.
 */
export interface PipelineTracer {
  startPhaseSpan(
    phase: string,
    options?: { attributes?: Record<string, string | number> },
  ): OTelSpanLike;
  endSpanOk(span: OTelSpanLike): void;
  endSpanWithError(span: OTelSpanLike, error: unknown): void;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export interface PipelineRuntimeConfig {
  /** Pipeline definition to execute */
  definition: PipelineDefinition;
  /** Function that executes individual nodes */
  nodeExecutor: NodeExecutor;
  /**
   * Optional host-provided handlers for compiler-lowered W3 runtime tool nodes
   * (`dzup.runtime.<node.type>`). When this registry is configured, matching
   * namespaced runtime `ToolNode`s are executed here before falling back to the
   * generic `nodeExecutor`; missing handlers fail the node with a clear error.
   */
  runtimeToolHandlers?: RuntimeToolHandlers;
  /**
   * Runtime-tool readiness strategy. `lazy` preserves the historical behavior:
   * a missing `dzup.runtime.*` handler fails when that node executes.
   * `fail_fast` validates the whole graph before a run starts and throws a
   * configuration error for any missing runtime-tool handler.
   */
  runtimeToolReadiness?: "lazy" | "fail_fast";
  /**
   * Optional checkpoint store for persistence.
   *
   * When omitted, the runtime selects a store automatically:
   *   - `redisClient` present → RedisPipelineCheckpointStore
   *   - `pgClient` present    → PostgresPipelineCheckpointStore
   *   - neither               → InMemoryPipelineCheckpointStore
   */
  checkpointStore?: PipelineCheckpointStore;
  /**
   * Named checkpoint stores addressable by `definition.checkpoint.storeRef`.
   * When a definition declares a storeRef and this registry contains a match,
   * that store takes precedence over `checkpointStore`.
   */
  checkpointStores?: Record<string, PipelineCheckpointStore>;
  /**
   * Named execution-log sinks addressable by `definition.executionLog.storeRef`.
   * When the definition declares both `storeRef` and `eventHistory`, checkpoint
   * execution-log snapshots are appended to the matching sink.
   */
  executionLogStores?: Record<string, PipelineExecutionLogStore>;
  /**
   * Pre-connected Redis client (ioredis / node-redis compatible).
   * Used to auto-wire `RedisPipelineCheckpointStore` when `checkpointStore`
   * is not explicitly provided.
   */
  redisClient?: RedisClientLike;
  /**
   * Pre-connected Postgres client (pg.Pool / pg.Client compatible).
   * Used to auto-wire `PostgresPipelineCheckpointStore` when `checkpointStore`
   * is not explicitly provided (and `redisClient` is also absent).
   */
  pgClient?: PostgresClientLike;
  /** Named predicate functions for conditional edges and loops */
  predicates?: Record<string, (state: Record<string, unknown>) => boolean>;
  /** Cancellation signal */
  signal?: AbortSignal;
  /** Event callback */
  onEvent?: (event: PipelineRuntimeEvent) => void;
  /** Default retry policy applied when a node has `retries > 0`. */
  retryPolicy?: RetryPolicy;
  /** Optional OTel tracer for creating spans per pipeline node */
  tracer?: PipelineTracer;
  /** Optional stuck detector for cross-node stuck detection */
  stuckDetector?: PipelineStuckDetector;
  /** Optional recovery copilot for automatic failure recovery */
  recoveryCopilot?: {
    /** The RecoveryCopilot instance to use for recovery attempts */
    copilot: RecoveryCopilot;
    /** Only attempt recovery for these node IDs (if empty/unset, all nodes are eligible) */
    enabledForNodes?: string[];
    /** Max total recovery attempts per pipeline run (default: 3) */
    maxRecoveryAttempts?: number;
  };
  /**
   * Optional trajectory calibrator for step-level quality tracking.
   * When configured, each node's quality score (from output) is compared
   * against historical baselines. Suboptimal results emit a calibration event.
   */
  trajectoryCalibrator?: {
    /** Function to extract a quality score (0-1) from a node result. Returns undefined to skip. */
    extractQuality: (nodeId: string, result: NodeResult) => number | undefined;
    /** Task type for baseline grouping (e.g., 'feature_gen') */
    taskType: string;
    /** The TrajectoryCalibrator instance */
    calibrator: TrajectoryCalibrator;
  };
  /**
   * Optional global iteration budget for the entire pipeline run.
   * When configured, tracks cumulative cost across all retried/failed nodes
   * and emits budget warning events at 70% and 90% thresholds.
   */
  iterationBudget?: {
    /** Maximum total cost in cents across the pipeline run */
    maxCostCents: number;
    /** Function to extract cost from a node result. Returns 0 to skip. */
    extractCost: (nodeId: string, result: NodeResult) => number;
  };
  /**
   * P2: Optional durable node ledger for crash-safe, effectively-once node
   * execution. When provided, each standard node is leased before execution,
   * a completed node replays its prior result instead of re-running, and the
   * completion/failure is recorded fence-gated. **When omitted, execution is
   * byte-for-byte unchanged** (no leasing, no replay) — opt-in only.
   *
   * Typed structurally to avoid a hard `@dzupagent/core/persistence` value
   * import into the types module; the runtime narrows to the concrete
   * `DurableNodeLedger`.
   */
  nodeLedger?: NodeLedgerLike;
}

/**
 * Structural subset of `@dzupagent/core` `DurableNodeLedger` the pipeline
 * runtime needs. Kept structural so the types module stays import-light.
 */
export interface NodeLedgerLike {
  acquire(
    runId: string,
    nodeId: string,
    idempotencyKey: string,
    owner: string,
    ttlMs: number,
    now: number,
  ): Promise<unknown | null>;
  heartbeat(
    runId: string,
    nodeId: string,
    owner: string,
    fenceToken: number,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;
  complete(record: {
    runId: string;
    nodeId: string;
    idempotencyKey: string;
    fenceToken: number;
    output?: unknown;
    durationMs?: number;
  }): Promise<void>;
  fail(record: {
    runId: string;
    nodeId: string;
    idempotencyKey: string;
    fenceToken: number;
    error: string;
    retryable: boolean;
  }): Promise<void>;
  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ output?: unknown } | undefined>;
}

/** Lease shape the runtime reads back from `acquire`. */
export interface NodeLeaseLike {
  owner: string;
  fenceToken: number;
}
