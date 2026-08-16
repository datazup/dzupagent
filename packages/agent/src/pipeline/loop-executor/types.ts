/**
 * Shared types for the loop-executor family.
 *
 * @module pipeline/loop-executor/types
 */

import type {
  LoopMetrics,
  NodeExecutionContext,
  NodeResult,
  PipelineState,
} from "@dzupagent/runtime-contracts";

/** A predicate loop's durable position after one body node completes. */
export interface LoopBodyCheckpointProgress {
  /** Number of full iterations completed before the current iteration. */
  completedIterations: number;
  /** Zero-based body-node index to dispatch next. */
  nextBodyNodeIndex: number;
  /** Results from successful body nodes in the current iteration. */
  bodyResults: Readonly<Record<string, NodeResult>>;
}

/**
 * A `for_each` loop's durable position part-way through one item (E3).
 *
 * Distinct from {@link LoopBodyCheckpointProgress}, which is the predicate
 * loop's cursor: that one is keyed by a completed-iteration count, whereas an
 * item has an explicit index into the resolved source.
 */
export interface ForEachItemCheckpointProgress {
  /** Zero-based index of the in-flight item. */
  itemIndex: number;
  /** Zero-based body-node index to dispatch next for this item. */
  nextBodyNodeIndex: number;
  /** Results from body nodes already completed within this item. */
  bodyResults: Readonly<Record<string, NodeResult>>;
  /** Attempt counter for this item; omitted on the first attempt. */
  attempt?: number;
}

/** Iteration output/progress retained at a completed iteration boundary. */
export interface LoopIterationCheckpointProgress {
  /** Final body-node output exposed as `loop.previous` next iteration. */
  previousOutput?: unknown;
  /** Canonical digest of the configured progress node's output. */
  progressDigest?: `sha256:${string}`;
}

export type LoopIterationBudgetReservation =
  | {
      /** A host-authoritative conservative upper bound was reserved. */
      status: "reserved";
      reservedCostCents: number;
    }
  | {
      /** No authoritative monetary upper bound is available. */
      status: "unknown";
    };

export interface LoopIterationBudgetReservationInput {
  loopNodeId: string;
  iteration: number;
  budgetCents: number;
  bodyNodeIds: readonly string[];
  state: Readonly<Record<string, unknown>>;
}

/** Input to the runtime-owned bounded graph scheduler for one iteration. */
export interface LoopBodyGraphScheduleInput {
  iteration: number;
  context: NodeExecutionContext;
  resumeState?: LoopBodyGraphCheckpointState;
  onCheckpoint?: (
    state: LoopBodyGraphCheckpointState,
    options?: { mandatory?: boolean }
  ) => Promise<void>;
}

/** Result returned by the bounded graph scheduler for one iteration. */
export interface LoopBodyGraphScheduleResult {
  /** Boundary-classified result; callers must not infer semantics from state. */
  outcome: LoopBodyGraphScheduleOutcome;
  /** Underlying scoped executor state retained for diagnostics/compatibility. */
  state: PipelineState;
  /** Results produced by body nodes during this iteration only. */
  bodyResults: ReadonlyMap<string, NodeResult>;
  /** Last result on the path that actually executed, when one exists. */
  lastResult?: NodeResult;
  /** Canonical failure detail when the scoped run did not complete. */
  error?: string;
  /**
   * Complete retained frame for a suspended or terminal control outcome.
   * The owning loop stage persists this together with the outer marker so a
   * scoped control node can never publish a partial/private checkpoint.
   */
  checkpointState?: LoopBodyGraphCheckpointState;
}

/** Explicit outcome of one bounded structured loop-body traversal. */
export type LoopBodyGraphScheduleOutcome =
  | { kind: "normal"; exitNodeId: string }
  | { kind: "suspended"; exitNodeId: string }
  | { kind: "terminal"; exitNodeId: string }
  | { kind: "cancelled" }
  | { kind: "error"; error: string; exitNodeId?: string };

/** Control outcome that transfers ownership from the body graph to its loop. */
export type LoopBodyGraphControlOutcome = Extract<
  LoopBodyGraphScheduleOutcome,
  { kind: "suspended" | "terminal" }
>;

/** Result of executing a loop, including an optional nested control transfer. */
export interface LoopExecutionResult {
  result: NodeResult;
  metrics: LoopMetrics;
  control?: {
    outcome: LoopBodyGraphControlOutcome;
    checkpointState: LoopBodyGraphCheckpointState;
    completedIterations: number;
  };
}

/** Durable scoped-executor frame retained inside one loop iteration. */
export interface LoopBodyGraphCheckpointState {
  completed: boolean;
  nextNodeId?: string;
  outcome?:
    | { kind: "normal"; exitNodeId: string }
    | { kind: "suspended"; exitNodeId: string }
    | { kind: "terminal"; exitNodeId: string };
  completedNodeIds: string[];
  nodeResults: Record<string, NodeResult>;
  nodeIdempotencyKeys: Record<string, string>;
  forkState?: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  >;
}

/**
 * Optional durable-resume hooks for {@link executeLoop} (W3).
 */
export interface LoopResumeOptions {
  /**
   * Iteration index to resume from (number of already-completed iterations).
   * Defaults to 0. Completed iterations are skipped; the loop body is not
   * re-run for them. The continue predicate is still evaluated against the
   * resumed `context.state`.
   */
  startIteration?: number;
  /**
   * Body-node cursor within `startIteration`. Omitted (or 0) starts the
   * iteration at its first body node.
   */
  startBodyNodeIndex?: number;
  /**
   * Successful body results retained for nodes before
   * `startBodyNodeIndex`. The predicate-loop executor validates this cursor
   * fail-closed before restoring the results into `previousResults`.
   */
  bodyResults?: Readonly<Record<string, NodeResult>>;
  /** Scoped graph frame retained for the current incomplete iteration. */
  bodyGraphState?: LoopBodyGraphCheckpointState;
  /**
   * Mid-item frame for a `for_each` loop (E3). Applies only to the item whose
   * `itemIndex` it names; later items start at body node 0. Absent means the
   * loop resumes exactly on an item boundary, which is the pre-E3 behaviour.
   */
  itemFrame?: ForEachItemCheckpointProgress;
  /** Previous completed iteration's final body output. */
  previousOutput?: unknown;
  /** Previous completed iteration's canonical progress digest. */
  progressDigest?: `sha256:${string}`;
  /** Host admission hook for an authored hard per-iteration ceiling. */
  reserveIterationBudget?: (
    input: LoopIterationBudgetReservationInput
  ) =>
    | LoopIterationBudgetReservation
    | Promise<LoopIterationBudgetReservation>;
  /**
   * Runtime-owned bounded scheduler for compiler-lowered graph bodies.
   * Required when `LoopNode.bodyGraph` is present; absence fails closed.
   */
  scheduleBodyGraph?: (
    input: LoopBodyGraphScheduleInput
  ) => Promise<LoopBodyGraphScheduleResult>;
  /** Persist one graph-frame boundary after the scoped executor advances. */
  onBodyGraphCheckpoint?: (input: {
    completedIterations: number;
    state: LoopBodyGraphCheckpointState;
    mandatory?: boolean;
  }) => Promise<void>;
  /**
   * Invoked after each successful predicate-loop body node. The runtime uses
   * this to persist a mid-iteration cursor and its retained body results.
   * For-each loops continue to checkpoint only their completed ordered prefix.
   */
  onBodyNodeComplete?: (
    progress: LoopBodyCheckpointProgress
  ) => Promise<void>;
  /**
   * Invoked after each successful `for_each` body node while the item is still
   * in flight (E3) — never on the item's last body node, whose durable cursor
   * is the ordered-prefix advance reported by `onIterationComplete`. The
   * runtime persists this as `loopState[loopId].itemFrame`.
   */
  onItemBodyNodeComplete?: (
    progress: ForEachItemCheckpointProgress
  ) => Promise<void>;
  /**
   * Invoked after each fully-completed iteration with the running iteration
   * count. Wired by the runtime to persist a checkpoint carrying the loop
   * cursor (`loopState`) and the accumulated `context.state`, so a crash
   * mid-loop resumes from the next iteration rather than from zero.
   */
  onIterationComplete?: (
    completedIterations: number,
    progress?: LoopIterationCheckpointProgress
  ) => Promise<void>;
}
