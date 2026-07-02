/**
 * Pipeline runtime contracts -- pure, dependency-free types describing the
 * surface that `@dzupagent/agent`'s `PipelineRuntime` exposes to its callers.
 *
 * These types are intentionally hosted here (not in `@dzupagent/agent`) so
 * that downstream packages such as `@dzupagent/agent-adapters/workflow` can
 * import them without taking a dependency on the orchestrator package. This
 * inverts the layering recommended by REC-H-10: workflow code references
 * runtime contracts, the canonical runtime implements them, and the only
 * concrete cross-package edge is the dependency-injected
 * `PipelineExecutorPort` from `@dzupagent/adapter-types`.
 *
 * The generic `TNode` parameter on `NodeExecutor` avoids leaking the full
 * `PipelineNode` discriminated union from `@dzupagent/core` -- callers that
 * need the typed shape parameterise the executor with the canonical node
 * type, while runtime-contracts itself stays free of `@dzupagent/*` imports.
 *
 * The cancellation surface is modelled as a structural `CancellationSignal`
 * so this package can keep its tsconfig `types: []` (no `@types/node`,
 * no `lib.dom`). Concrete callers pass real `AbortSignal` values, which are
 * structurally compatible with the lighter shape defined here.
 *
 * @module runtime-contracts/pipeline
 */

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of `AbortSignal`. Declared inline so that
 * `@dzupagent/runtime-contracts` does not pull in `dom` or `@types/node`
 * libs. Concrete callers pass `AbortSignal` instances which are
 * structurally compatible with this contract.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Pipeline lifecycle state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a pipeline run as observed by external callers.
 * Mirrors the `PipelineExecutorState` exported by `@dzupagent/adapter-types`
 * and is the canonical source consumed by `@dzupagent/agent`'s runtime.
 */
export type PipelineState =
  | "idle"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

// ---------------------------------------------------------------------------
// Node-level execution shapes
// ---------------------------------------------------------------------------

/**
 * Result produced by a single node executor invocation. `output` is opaque
 * to the runtime; downstream nodes interpret it via their own contracts.
 */
export interface NodeResult {
  nodeId: string;
  output: unknown;
  durationMs: number;
  error?: string;
  /**
   * Opaque provider session handles produced by this node, when available.
   * Pipeline checkpoints persist these only when checkpoint policy explicitly
   * requests provider-session-ref capture.
   */
  providerSessionRefs?: ProviderSessionRef[];
}

export interface ProviderSessionRef {
  provider: string;
  sessionId: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-node execution context provided by the runtime to each node executor.
 *
 * `state` is the shared mutable pipeline state. `previousResults` exposes
 * the results of nodes that have already completed in this run. `signal`
 * is the cancellation signal propagated from the runtime configuration.
 * `budget` and `stuckHint` are advisory hints emitted by higher-level
 * runtime concerns (iteration budgets, stuck detection) -- nodes are free
 * to ignore them.
 */
export interface NodeExecutionContext {
  /** Shared mutable pipeline state. */
  state: Record<string, unknown>;
  /** Results of previously completed nodes, keyed by `nodeId`. */
  previousResults: Map<string, NodeResult>;
  /**
   * Cancellation signal forwarded from `PipelineRuntimeConfig.signal`.
   * Typed as the structural `CancellationSignal` so this package does not
   * depend on `@types/node` or `lib.dom`; real `AbortSignal` instances are
   * structurally compatible.
   */
  signal?: CancellationSignal;
  /** Remaining budget hint from the iteration-budget controller. */
  budget?: { tokensRemaining: number; costRemainingCents: number };
  /** Hint from the stuck detector suggesting an alternate strategy. */
  stuckHint?: string;
  /**
   * Stable idempotency key for this node execution, deterministic for a given
   * `(runId, nodeId)`. Node implementations that perform external side effects
   * should pass this to downstream stores so a re-execution after a crash
   * (node ran, but its completion checkpoint did not persist) can be
   * deduplicated. Optional: omitted when the runtime does not supply one.
   */
  idempotencyKey?: string;
}

/**
 * Function executed for each node in the pipeline.
 *
 * The `node` argument is parameterised so this contract does not leak the
 * full `PipelineNode` discriminated union from `@dzupagent/core`. Concrete
 * runtimes pass `PipelineNode` as `TNode`; minimal callers can leave it as
 * `unknown` and rely on `nodeId` for dispatch.
 */
export type NodeExecutor<TNode = unknown> = (
  nodeId: string,
  node: TNode,
  context: NodeExecutionContext
) => Promise<NodeResult>;

// ---------------------------------------------------------------------------
// Aggregate run result
// ---------------------------------------------------------------------------

/**
 * Aggregate result returned by a runtime `execute` call.
 *
 * Mirrors `PipelineExecutorRunResult` in `@dzupagent/adapter-types`; the
 * runtime-contracts version is the authoritative shape used by both the
 * canonical runtime and the workflow builders.
 */
export interface PipelineRunResult {
  pipelineId: string;
  runId: string;
  state: PipelineState;
  nodeResults: Map<string, NodeResult>;
  totalDurationMs: number;
  budgetUsed?: { tokens: number; costCents: number };
}

// ---------------------------------------------------------------------------
// Runtime events
// ---------------------------------------------------------------------------

/**
 * Discriminated union of events emitted by the canonical pipeline runtime.
 *
 * Consumers must branch on `type` and treat the union as open-for-extension:
 * future runtime versions may add new variants without bumping the major
 * version, so unknown shapes should be ignored rather than rejected.
 */
export type PipelineRuntimeEvent =
  | { type: "pipeline:started"; pipelineId: string; runId: string }
  | { type: "pipeline:node_started"; nodeId: string; nodeType: string }
  | { type: "pipeline:node_completed"; nodeId: string; durationMs: number }
  | { type: "pipeline:node_failed"; nodeId: string; error: string }
  | { type: "pipeline:suspended"; nodeId: string }
  | { type: "pipeline:completed"; runId: string; totalDurationMs: number }
  | { type: "pipeline:failed"; runId: string; error: string }
  | { type: "pipeline:checkpoint_saved"; runId: string; version: number }
  | {
      type: "pipeline:loop_iteration";
      nodeId: string;
      iteration: number;
      maxIterations: number;
    }
  | {
      type: "pipeline:node_retry";
      nodeId: string;
      attempt: number;
      maxAttempts: number;
      error: string;
      backoffMs: number;
    }
  | {
      type: "pipeline:recovery_attempted";
      nodeId: string;
      attempt: number;
      maxAttempts: number;
      error: string;
    }
  | {
      type: "pipeline:recovery_succeeded";
      nodeId: string;
      attempt: number;
      summary: string;
    }
  | {
      type: "pipeline:recovery_failed";
      nodeId: string;
      attempt: number;
      error: string;
    }
  | {
      type: "pipeline:stuck_detected";
      nodeId: string;
      reason: string;
      suggestedAction: string;
    }
  | {
      type: "pipeline:node_output_recorded";
      nodeId: string;
      outputHash: string;
    }
  | {
      type: "pipeline:calibration_suboptimal";
      nodeId: string;
      baseline: number;
      currentScore: number;
      deviation: number;
      suggestion: string;
    }
  | {
      type: "pipeline:iteration_budget_warning";
      level: "warn_70" | "warn_90";
      totalCost: number;
      budgetCents: number;
      iteration: number;
    };

// ---------------------------------------------------------------------------
// Loop metrics
// ---------------------------------------------------------------------------

/**
 * Summary metrics for a `loop` node, captured by the runtime and surfaced
 * via node-result outputs for observability and self-correction hooks.
 */
export interface LoopMetrics {
  iterationCount: number;
  iterationDurations: number[];
  converged: boolean;
  terminationReason:
    | "condition_met"
    | "max_iterations"
    | "budget_exceeded"
    | "cancelled";
}
