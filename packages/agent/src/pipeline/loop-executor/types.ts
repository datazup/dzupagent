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
import type {
  PipelineForEachItemEconomics,
  PipelineForEachItemOutcome,
} from "@dzupagent/core/pipeline";

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
  /**
   * 24-F: durable lifecycle state of this item at the moment of the
   * checkpoint. Omitted by callers that cannot classify the item, so a
   * checkpoint never claims an outcome it did not observe.
   */
  outcome?: PipelineForEachItemOutcome;
  /**
   * 24-F: the reservation this item holds when the checkpoint is taken.
   *
   * Reported by the loop rather than derived by the runtime writer: the loop
   * is the only layer that knows whether a reserve actually succeeded, and
   * re-deriving the id downstream would reproduce the *current* attempt's id
   * rather than the one the host actually opened.
   */
  economics?: PipelineForEachItemEconomics;
}

/**
 * 24-G: one item's terminal classification, reported as the item leaves the
 * loop for good.
 *
 * Separate from {@link ForEachItemCheckpointProgress} because it carries no
 * body cursor: an item reporting a terminal outcome has nowhere to resume to,
 * and reusing the in-flight shape would invite a reader to resume from a record
 * that exists precisely to say the item must not be resumed.
 */
export interface ForEachItemTerminalOutcome {
  /** Zero-based index of the item within the resolved source. */
  itemIndex: number;
  /** The classification the loop observed at the item's exit. */
  outcome: PipelineForEachItemOutcome;
  /**
   * The reservation the item's final attempt held, when one existed. Omitted
   * when the host authored no ceiling, and for an item that never dispatched.
   */
  economics?: PipelineForEachItemEconomics;
  /** Attempt this outcome describes; omitted at 0. */
  attempt?: number;
}

/** Iteration output/progress retained at a completed iteration boundary. */
export interface LoopIterationCheckpointProgress {
  /** Final body-node output exposed as `loop.previous` next iteration. */
  previousOutput?: unknown;
  /** Canonical digest of the configured progress node's output. */
  progressDigest?: `sha256:${string}`;
}

/**
 * The loop budget host contract lives in `budget-types.ts`. It is re-exported
 * here so this module stays the single import site for the loop-executor type
 * surface.
 */
import type {
  LoopIterationBudgetCheckpointProgress,
  LoopIterationBudgetReservation,
  LoopBudgetCostEvidence,
  LoopBudgetReconcileInput,
  LoopBudgetReconcileOutcome,
  LoopIterationBudgetReservationInput,
  LoopBudgetSettlementInput,
  LoopBudgetCostMeasurementInput,
  LoopBudgetReleaseInput,
} from "./budget-types.js";

export type {
  LoopIterationBudgetCheckpointProgress,
  LoopIterationBudgetReservation,
  LoopBudgetCostEvidence,
  LoopBudgetReconcileInput,
  LoopBudgetReconcileOutcome,
  LoopIterationBudgetReservationInput,
  LoopBudgetSettlementScope,
  LoopBudgetSettlementInput,
  LoopBudgetCostMeasurementInput,
  LoopBudgetReleaseInput,
  LoopBudgetLifecycle,
  LoopBudgetCompatibilityHost,
  LoopBudgetStrictHost,
  LoopBudgetHost,
} from "./budget-types.js";

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
   * another.
   *
   * 24-I RE-DATED: previously "`concurrency` is still pinned to 1 everywhere,
   * so exactly one entry is populated today". N>1 is admitted, and at N>1 as
   * many entries are populated as there are items in flight.
   */
  itemFrames?: Readonly<Record<string, ForEachItemCheckpointProgress>>;
  /**
   * 24-H: durable terminal outcomes recorded by a PREVIOUS run of this loop,
   * keyed exactly as {@link itemFrames}. This is the resume-side half of the
   * record 24-G shipped, and its first reader.
   *
   * Needed because the ordered-prefix cursor cannot protect every settled item.
   * `startIteration` skips everything BELOW the prefix, but an item that
   * completed out of order sits ABOVE it — index 3 completing after index 2
   * failed — and is otherwise re-dispatched, re-reserved under an advanced
   * `attempt` id, and settled a second time for work already paid for.
   *
   * Absent for a first run and for any pre-24-G checkpoint, in which case the
   * loop behaves exactly as before: absence means "this run recorded no
   * outcomes", never "no item is settled".
   */
  itemOutcomes?: Readonly<Record<string, ForEachItemTerminalOutcome>>;
  /** Previous completed iteration's final body output. */
  previousOutput?: unknown;
  /** Previous completed iteration's canonical progress digest. */
  progressDigest?: `sha256:${string}`;
  /** Durable lifecycle state for the current predicate-loop iteration. */
  iterationOutcome?: PipelineForEachItemOutcome;
  /** Exact durable reservation bytes for that predicate-loop iteration. */
  iterationEconomics?: PipelineForEachItemEconomics;
  /** Host admission hook for an authored hard per-iteration ceiling. */
  reserveIterationBudget?: (
    input: LoopIterationBudgetReservationInput
  ) => LoopIterationBudgetReservation | Promise<LoopIterationBudgetReservation>;
  /**
   * F: reconcile a reservation against actual spend. Absent ⇒ no settlement
   * occurs and behaviour is byte-identical to the reserve-only contract.
   */
  settleIterationBudget?: (
    input: LoopBudgetSettlementInput
  ) => unknown;
  /**
   * F: return an unspent reservation when its work aborted or failed. Absent ⇒
   * the pre-F leak, preserved rather than fixed, for reserve-only hosts.
   */
  releaseIterationBudget?: (
    input: LoopBudgetReleaseInput
  ) => unknown;
  /**
   * G2b: prove the outcome of a reserve that threw. Absent ⇒ an outcome-unknown
   * reserve fails the item closed with release and redispatch both blocked,
   * which is the fail-closed default doc 27 §8 prereq 6 requires.
   */
  reconcileIterationBudget?: (
    input: LoopBudgetReconcileInput
  ) => LoopBudgetReconcileOutcome | Promise<LoopBudgetReconcileOutcome>;
  /**
   * G2b: run identity used to derive the deterministic reservation ID. Absent ⇒
   * the ID degrades to a run-less form, which is still stable within the run but
   * not across runs. The runtime always threads it.
   */
  budgetRunId?: string;
  /**
   * F: hard monetary ceiling admitted per `for_each` item. The `forEach`
   * compile-time contract carries no budget field, so this ceiling is authored
   * by the host runtime config rather than by the flow document. Absent ⇒
   * `for_each` takes no reservation at all, which is the pre-F behaviour.
   */
  itemBudgetCents?: number;
  /**
   * Strict hard-ceiling profile selected by the host. `itemBudgetCents`
   * requires this mode and every lifecycle hook below.
   */
  budgetMode?: "strict";
  /** Enforce exact V1 execution/economics/effect evidence before dispatch. */
  budgetEvidenceMode?: "required";
  /** Authoritative known/unknown item cost measurement in strict mode. */
  measureItemCost?: (
    input: LoopBudgetCostMeasurementInput
  ) => LoopBudgetCostEvidence | Promise<LoopBudgetCostEvidence>;
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
  onBodyNodeComplete?: (progress: LoopBodyCheckpointProgress) => Promise<void>;
  /**
   * Persist predicate-loop reservation state before body dispatch and at each
   * terminal settlement/release boundary.
   */
  onIterationBudgetCheckpoint?: (
    progress: LoopIterationBudgetCheckpointProgress
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
   * 24-G: invoked once per item as it reaches a terminal state, including for
   * items the loop never dispatched because it stopped early.
   *
   * Distinct from `onItemBodyNodeComplete` because the runtime persists it to a
   * different place for a different lifetime: `itemFrames` is retired the
   * moment the ordered prefix passes an item, whereas
   * `loopState[loopId].itemOutcomes[itemIndex]` must survive that retirement.
   * Routing terminal outcomes through the in-flight callback would have them
   * erased by the very next item boundary.
   */
  onItemTerminalOutcome?: (
    outcome: ForEachItemTerminalOutcome
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
