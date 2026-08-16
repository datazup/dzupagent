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
  /**
   * F: present only for a `for_each` per-item reservation, absent for the
   * predicate-loop per-iteration reservation. A host that reserves per item
   * uses this to key its ledger by item rather than by iteration ordinal.
   */
  itemIndex?: number;
  /** F: re-dispatch counter for this item; omitted on a first attempt. */
  attempt?: number;
}

/**
 * F: identity of the reservation being reconciled. A host correlates a
 * settle/release against its own ledger with this triple, which is exactly
 * what {@link LoopIterationBudgetReservationInput} carried at reserve time.
 */
export interface LoopBudgetSettlementScope {
  loopNodeId: string;
  iteration: number;
  itemIndex?: number;
  attempt?: number;
}

/**
 * F: reconciliation of a reservation against actual spend.
 *
 * `actualCostCents` is an integer count of cents — money never travels
 * through a float in this contract.
 */
export interface LoopBudgetSettlementInput extends LoopBudgetSettlementScope {
  /** Conservative amount taken at reserve time. */
  reservedCostCents: number;
  /** Actual integer cents spent by the settled unit of work. */
  actualCostCents: number;
}

/** F: return of an unspent reservation on an abort/failure path. */
export interface LoopBudgetReleaseInput extends LoopBudgetSettlementScope {
  /** Conservative amount taken at reserve time, returned in full. */
  reservedCostCents: number;
  /** Why the reservation is being returned rather than settled. */
  reason: "aborted" | "failed";
}

/**
 * F: the full reservation lifecycle a host may implement.
 *
 * `reserve` is the only required member: a pre-F host supplying `reserve`
 * alone keeps today's behaviour exactly, because an absent `settle`/`release`
 * degrades to a no-op rather than failing closed. Widening this contract must
 * never break a reserve-only host.
 */
export interface LoopBudgetLifecycle {
  reserve(
    input: LoopIterationBudgetReservationInput
  ): LoopIterationBudgetReservation | Promise<LoopIterationBudgetReservation>;
  /** Reconcile actual spend, releasing the unspent delta. */
  settle?(input: LoopBudgetSettlementInput): void | Promise<void>;
  /** Return an unspent reservation whose work never completed. */
  release?(input: LoopBudgetReleaseInput): void | Promise<void>;
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
   * Mid-item frames for a `for_each` loop (E3 shape, G1 keying), keyed by the
   * item's zero-based index as a decimal string. A frame applies only to the
   * item its key names; every other item starts at body node 0. Absent means
   * the loop resumes exactly on an item boundary (pre-E3 behaviour).
   *
   * Keyed rather than singular so that N in-flight items cannot clobber one
   * another. `concurrency` is still pinned to 1 everywhere, so exactly one
   * entry is populated today.
   */
  itemFrames?: Readonly<Record<string, ForEachItemCheckpointProgress>>;
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
   * F: reconcile a reservation against actual spend. Absent ⇒ no settlement
   * occurs and behaviour is byte-identical to the reserve-only contract.
   */
  settleIterationBudget?: (
    input: LoopBudgetSettlementInput
  ) => void | Promise<void>;
  /**
   * F: return an unspent reservation when its work aborted or failed. Absent ⇒
   * the pre-F leak, preserved rather than fixed, for reserve-only hosts.
   */
  releaseIterationBudget?: (
    input: LoopBudgetReleaseInput
  ) => void | Promise<void>;
  /**
   * F: hard monetary ceiling admitted per `for_each` item. The `forEach`
   * compile-time contract carries no budget field, so this ceiling is authored
   * by the host runtime config rather than by the flow document. Absent ⇒
   * `for_each` takes no reservation at all, which is the pre-F behaviour.
   */
  itemBudgetCents?: number;
  /**
   * F: extract the actual integer cents one settled body result cost. Absent ⇒
   * actual spend is treated as the full reservation, which never
   * under-charges and never reports a false overrun.
   */
  extractItemCostCents?: (
    nodeId: string,
    result: NodeResult
  ) => number | undefined;
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
   * runtime persists this as `loopState[loopId].itemFrames[itemIndex]`.
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
