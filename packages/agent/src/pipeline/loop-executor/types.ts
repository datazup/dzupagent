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
  economics?: {
    reservationId: string;
    reservedCostCents: number;
    settledCostCents?: number;
  };
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
 * Durable strict-economics state for the predicate-loop iteration currently
 * named by the loop cursor.
 *
 * Reuses the exact `for_each` outcome/economics vocabulary. The callback is
 * separate from body progress because the reservation must be committed before
 * the first body node dispatches, when no body node has completed yet.
 */
export interface LoopIterationBudgetCheckpointProgress {
  /** Number of full iterations completed before this in-flight iteration. */
  completedIterations: number;
  /** Lifecycle state observed by the predicate-loop executor. */
  outcome: PipelineForEachItemOutcome;
  /** Exact reservation bytes, including actual cost after settlement. */
  economics: PipelineForEachItemEconomics;
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

/**
 * Authoritative cost evidence for one completed `for_each` item.
 *
 * A strict ceiling never represents missing/non-finite usage as zero. Hosts
 * must say whether cost is known, and the runtime validates known cents before
 * presenting them to settlement.
 */
export type LoopBudgetCostEvidence =
  | {
      status: "known";
      costCents: number;
    }
  | {
      status: "unknown";
      reason?: string;
    };

/**
 * G2b: the outcome of a reserve whose result the runtime could not observe.
 *
 * In strict mode neither a thrown reserve nor an answered
 * `{ status: "unknown" }` proves that no ledger row exists. A clean absence is
 * represented by reconciliation's explicit `absent`/`released` outcomes; all
 * other uncertainty remains blocked.
 *
 * Doc 27 §8 prereq 6 requires uncertainty to be treated as outcome-unknown: block
 * release and redispatch until reconciliation proves the outcome. Releasing
 * blind would return money the host may never have taken; redispatching blind
 * would double-charge.
 */
export interface LoopBudgetReconcileInput extends LoopBudgetSettlementScope {
  /** Deterministic identity of the reservation whose fate is unknown. */
  reservationId: string;
  /** The ceiling the reserve was attempted against. */
  budgetCents: number;
  /** Failure detail from the call that could not be observed. */
  reason: string;
  /**
   * G2d (doc 27 §8 prereq 7): which lifecycle call went unobserved.
   *
   * Prereq 7 requires terminal settlement for every started/completed/failed/
   * unknown/cancelled item, so reconciliation is no longer reachable only from
   * `reserve`. The three boundaries need different remediation — a `settle`
   * that vanished may have CHARGED the item, whereas a `release` that vanished
   * may have REFUNDED it — so a host cannot respond correctly without knowing
   * which one it is.
   *
   * Required, because the single producer (`for-each-loop.ts`) has passed it
   * on every call since G2d. Declaring it optional described a caller that
   * does not exist and cost a host the ability to switch on it without a
   * needless undefined branch. This appears only as a CALLBACK PARAMETER —
   * no consumer constructs the input — so tightening it informs hosts rather
   * than breaking them.
   */
  boundary: "reserve" | "settle" | "release";
}

/**
 * G2b: a host's authoritative answer about a reservation it may or may not
 * hold. This is the ONLY thing that can clear an outcome-unknown item.
 */
export type LoopBudgetReconcileOutcome =
  | {
      /** The reservation still exists and remains available for settlement. */
      status: "reserved";
      reservedCostCents: number;
    }
  | {
      /** The item was already settled; cost evidence is authoritative. */
      status: "settled";
      cost: LoopBudgetCostEvidence;
    }
  | {
      /** The host holds the reservation; it is now released. Safe to proceed. */
      status: "released";
    }
  | {
      /** The host never created it. Nothing is outstanding. Safe to proceed. */
      status: "absent";
    }
  | {
      /** The host still cannot prove the outcome. The item stays blocked. */
      status: "unknown";
    }
  | {
      /**
       * 24-H (doc 27 §8 proof 6, conflict half): the host observed the
       * reservation clearly and it belongs to ANOTHER writer.
       *
       * Distinct from `unknown`, which means "I could not observe it". Both
       * block, but they are opposite epistemic states and send an operator to
       * opposite places: `unknown` says look for a transport fault, `conflict`
       * says look for the rival writer named below.
       *
       * Before this member the fact was unrepresentable, which is why proof 6's
       * conflict half sat open across three packets. A host that knew perfectly
       * well who held the reservation had to answer with a lie: `unknown`
       * (blocks, but misreports certainty as a failure to observe) or
       * `absent`/`released` (which UNBLOCK the item and redispatch work whose
       * money another writer owns).
       */
      status: "conflict";
      /**
       * Opaque host-authored identity of the holder — a run id, worker id, or
       * whatever the host's ledger keys by. Surfaced verbatim in the failure so
       * an operator can find the rival writer.
       *
       * Keyed by ITEM rather than by reservation id, and that is forced rather
       * than chosen: `deriveItemReservationId` embeds `attempt`, and 24-F's
       * attempt advance means a resumed item deliberately presents a DIFFERENT
       * id from the one the dead attempt opened. A conflict keyed by id could
       * never be recognised across the resume that provokes it.
       */
      heldBy: string;
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
  /**
   * G2b (doc 27 §8 prereq 5): deterministic reservation ID. Stable for a given
   * `(runId, loopNodeId, itemIndex, attempt)`, so a reserve replayed after a
   * crash presents the SAME id and the host can recognise it as the same
   * reservation rather than opening a second one.
   *
   * Optional so a pre-G2b host that ignores it is unaffected; present on every
   * `for_each` per-item reserve once the runtime threads a `runId`.
   */
  reservationId?: string;
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
  /**
   * G2b: the same deterministic ID the reserve carried. A host correlates by
   * this alone; the positional triple above is retained for compatibility with
   * F-era hosts that key their ledger by it.
   */
  reservationId?: string;
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

/** Input to a strict host's authoritative per-item cost measurement. */
export interface LoopBudgetCostMeasurementInput
  extends LoopBudgetSettlementScope {
  /** Successful body results for the completed item, keyed by body node id. */
  bodyResults: Readonly<Record<string, NodeResult>>;
}

/** F: return of an unspent reservation on an abort/failure path. */
export interface LoopBudgetReleaseInput extends LoopBudgetSettlementScope {
  /** Conservative amount taken at reserve time, returned in full. */
  reservedCostCents: number;
  /** Why the reservation is being returned rather than settled. */
  reason: "aborted" | "failed";
}

/**
 * Compatibility reservation lifecycle for hosts without a hard item ceiling.
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
  /**
   * G2b: prove the outcome of a reserve the runtime could not observe. Absent ⇒
   * the runtime cannot prove the outcome itself, so it fails the item closed and
   * blocks redispatch — it never guesses.
   */
  reconcile?(
    input: LoopBudgetReconcileInput
  ): LoopBudgetReconcileOutcome | Promise<LoopBudgetReconcileOutcome>;
}

/**
 * Compatibility host used only when no hard per-item ceiling is active.
 *
 * The optional lifecycle members deliberately preserve the pre-strict
 * reserve-only shape for predicate loops and unpriced `for_each` execution.
 * `itemBudgetCents` is forbidden: authoring a hard ceiling selects the strict
 * discriminant below and therefore requires the complete lifecycle.
 */
export interface LoopBudgetCompatibilityHost extends LoopBudgetLifecycle {
  mode?: "compatibility";
  itemBudgetCents?: never;
  /** Legacy extractor retained for source compatibility outside strict mode. */
  extractItemCostCents?: (
    nodeId: string,
    result: NodeResult
  ) => number | undefined;
}

/**
 * Fail-closed budget host for a hard `for_each` item ceiling.
 *
 * Every lifecycle operation is required. The cost measurement is explicitly
 * known/unknown so missing usage cannot silently settle as zero (or as an
 * assumed reservation amount).
 */
export interface LoopBudgetStrictHost extends LoopBudgetLifecycle {
  mode: "strict";
  /**
   * Optional host-authored `for_each` item ceiling. Predicate loops take their
   * ceiling from `typedWhile.iterationBudgetCents`, so a strict host serving
   * only predicate loops does not need to invent an unrelated item value.
   */
  itemBudgetCents?: number;
  settle(input: LoopBudgetSettlementInput): void | Promise<void>;
  release(input: LoopBudgetReleaseInput): void | Promise<void>;
  reconcile(
    input: LoopBudgetReconcileInput
  ): LoopBudgetReconcileOutcome | Promise<LoopBudgetReconcileOutcome>;
  measureItemCost(
    input: LoopBudgetCostMeasurementInput
  ): LoopBudgetCostEvidence | Promise<LoopBudgetCostEvidence>;
}

/** Discriminated host contract for compatible and strict budget profiles. */
export type LoopBudgetHost =
  | LoopBudgetCompatibilityHost
  | LoopBudgetStrictHost;

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
  ) => void | Promise<void>;
  /**
   * F: return an unspent reservation when its work aborted or failed. Absent ⇒
   * the pre-F leak, preserved rather than fixed, for reserve-only hosts.
   */
  releaseIterationBudget?: (
    input: LoopBudgetReleaseInput
  ) => void | Promise<void>;
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
