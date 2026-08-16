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
  PipelineInteractionResumeCursor,
  PipelineLedgerUnavailablePolicy,
} from "@dzupagent/core/pipeline";
import type {
  NodeExecutionContext,
  NodeExecutor as RuntimeNodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  ProviderSessionRef,
  PipelineInteractionResumeV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "@dzupagent/runtime-contracts";
import type { RecoveryCopilot } from "../recovery/recovery-copilot.js";
import type { PipelineStuckDetector } from "../self-correction/pipeline-stuck-detector.js";
import type { TrajectoryCalibrator } from "../self-correction/trajectory-calibrator.js";
import type { RedisClientLike } from "./redis-checkpoint-store.js";
import type { PostgresClientLike } from "./postgres-checkpoint-store.js";
import type { LoopState } from "./pipeline-runtime/executor-state-types.js";

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
  input: RuntimeToolHandlerInput
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
export interface RetryPolicy
  extends Omit<
    CanonicalRetryPolicy,
    "initialBackoffMs" | "maxBackoffMs" | "multiplier" | "jitter"
  > {
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs?: number;
  /**
   * Exponential backoff multiplier applied per attempt (default: 2).
   *
   * Optional here — `calculateBackoff` falls back to `backoffMultiplier`
   * and then to the default, so callers may omit it.
   */
  multiplier?: number;
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
    options?: { attributes?: Record<string, string | number> }
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
   * Host-authoritative conservative reservation used by loops that author a
   * hard `iterationBudgetCents` ceiling. Missing or unknown reservation fails
   * before the first body node dispatches.
   */
  loopIterationBudgetReservation?: {
    reserve(input: {
      loopNodeId: string;
      iteration: number;
      budgetCents: number;
      bodyNodeIds: readonly string[];
      state: Readonly<Record<string, unknown>>;
      /** F: present only for a `for_each` per-item reservation. */
      itemIndex?: number;
      /** F: re-dispatch counter; omitted on a first attempt. */
      attempt?: number;
      /**
       * G2b: deterministic reservation ID, stable across a crash-and-replay of
       * the same item attempt. A host keys its ledger by this to recognise a
       * replayed reserve instead of opening a second reservation.
       */
      reservationId?: string;
    }):
      | { status: "reserved"; reservedCostCents: number }
      | { status: "unknown" }
      | Promise<
          | { status: "reserved"; reservedCostCents: number }
          | { status: "unknown" }
        >;
    /**
     * F: reconcile a reservation against actual spend, releasing the unspent
     * delta. **Optional on purpose** — a pre-F host that supplies `reserve`
     * alone keeps today's behaviour exactly rather than failing closed.
     * `actualCostCents` is integer cents; money never crosses this seam as a
     * float.
     */
    settle?(input: {
      loopNodeId: string;
      iteration: number;
      itemIndex?: number;
      attempt?: number;
      /** G2b: the same deterministic ID the reserve carried. */
      reservationId?: string;
      reservedCostCents: number;
      actualCostCents: number;
    }): void | Promise<void>;
    /**
     * F: return an unspent reservation whose work aborted or failed. Optional
     * for the same compatibility reason as `settle`.
     */
    release?(input: {
      loopNodeId: string;
      iteration: number;
      itemIndex?: number;
      attempt?: number;
      /** G2b: the same deterministic ID the reserve carried. */
      reservationId?: string;
      reservedCostCents: number;
      reason: "aborted" | "failed";
    }): void | Promise<void>;
    /**
     * G2b (doc 27 §8 prereq 6): prove the outcome of a reserve that THREW,
     * whose reservation may or may not exist on the host.
     *
     * Unlike `settle`/`release`, an absent `reconcile` is NOT a no-op: the
     * runtime cannot prove the outcome by itself, so it fails the item closed
     * and blocks both release and redispatch. Only an explicit `released` or
     * `absent` answer clears the item; `unknown` keeps it blocked.
     */
    reconcile?(input: {
      loopNodeId: string;
      iteration: number;
      itemIndex?: number;
      attempt?: number;
      reservationId: string;
      budgetCents: number;
      reason: string;
    }):
      | { status: "released" }
      | { status: "absent" }
      | { status: "unknown" }
      | Promise<
          { status: "released" } | { status: "absent" } | { status: "unknown" }
        >;
    /**
     * F: hard monetary ceiling admitted per `for_each` item. The `forEach`
     * compile-time contract carries no budget field, so a per-item ceiling is
     * authored here by the host rather than by the flow document. Absent ⇒
     * `for_each` takes no reservation, which is the pre-F behaviour.
     */
    itemBudgetCents?: number;
    /**
     * F: extract the actual integer cents a settled body result cost. Absent ⇒
     * actual spend is treated as the full reservation (nothing to release),
     * which is conservative and never under-charges.
     */
    extractItemCostCents?: (
      nodeId: string,
      result: NodeResult
    ) => number | undefined;
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
  /**
   * E2: what to do when the durable ledger is unreachable at node dispatch.
   *
   * `"degrade-open"` (the default, and the pre-E2 behavior) logs
   * `idempotency_disabled_for_node`, synthesizes a lease, and proceeds —
   * trading exactly-once for liveness. `"strict"` fails the node instead,
   * which is the right choice for chargeable per-item work where a retry can
   * double-execute a side effect.
   *
   * Absent ⇒ exactly today's semantics.
   */
  ledgerUnavailablePolicy?: PipelineLedgerUnavailablePolicy;
  /** Finite provider-free interaction policy and injectable clock for tests. */
  interaction?: {
    ttlMs?: number;
    now?: () => Date;
  };
}

/**
 * Per-execution options that cannot safely live on a reusable runtime config.
 * A durable host supplies its authoritative run identity here so checkpoints,
 * events, idempotency keys, effects, and app records all share one ID.
 */
export interface PipelineExecuteOptions {
  runId?: string;
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
    now: number
  ): Promise<unknown | null>;
  heartbeat(
    runId: string,
    nodeId: string,
    owner: string,
    fenceToken: number,
    ttlMs: number,
    now: number
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
    idempotencyKey: string
  ): Promise<{ output?: unknown } | undefined>;
}

/** Lease shape the runtime reads back from `acquire`. */
export interface NodeLeaseLike {
  owner: string;
  fenceToken: number;
}

/**
 * Per-fork branch progress carried across a checkpoint. Each fork records, per
 * branch, its accumulated state delta and node results so a mid-fork crash
 * re-runs only unfinished branches (W4). Previously an inline literal repeated
 * across the runtime; named here so the resume/redeliver paths share one shape.
 */
export interface ForkRuntimeState {
  [forkId: string]: {
    branches: {
      [branchId: string]: {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      };
    };
  };
}

/**
 * Mutable execution context threaded from an entry point (`execute`, `resume`,
 * `redeliverFromCheckpoint`) into the executor's graph walk. Groups the run
 * identity, restored/accumulated run state, and the per-node bookkeeping maps
 * so the runtime and executor pass one object instead of a long argument list.
 */
export interface PipelineRunContext {
  startNodeId: string;
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: LoopState;
  forkState: ForkRuntimeState;
  /**
   * Per-loop digest of each `for_each` loop's resolved item source (E3).
   * Restored from the checkpoint's `sourceBinding` on resume and re-recorded
   * as each loop resolves, so a changed source is detectable.
   */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
  eventLog: PipelineRuntimeEvent[];
  versionTracker: { version: number };
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor?: PipelineInteractionResumeCursor;
  startTime: number;
}
