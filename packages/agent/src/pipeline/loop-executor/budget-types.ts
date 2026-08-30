/**
 * Loop budget host contract for the loop-executor family.
 *
 * Owns everything about how a loop reserves, settles, reconciles and releases
 * per-iteration economics: the durable reservation/progress state, the cost
 * evidence and reconcile outcome unions, and the compatibility/strict host
 * interfaces the runtime dispatches against. Split out of `types.ts` so the
 * economics contract can grow without dragging the loop's structural types
 * along with it; `types.ts` re-exports the whole surface, so consumers are
 * unaffected by where a name lives.
 *
 * @module pipeline/loop-executor/budget-types
 */

import type { NodeResult } from "@dzupagent/runtime-contracts";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import type {
  PipelineForEachItemEconomics,
  PipelineForEachItemOutcome,
} from "@dzupagent/core/pipeline";

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
      evidence?: LoopEconomicsEvidenceV1;
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
      evidence?: LoopEconomicsEvidenceV1;
    }
  | {
      status: "unknown";
      reason?: string;
      evidence?: LoopEconomicsEvidenceV1;
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
  /** Retained evidence whose current authoritative state is being reconciled. */
  evidence?: LoopEconomicsEvidenceV1;
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
      evidence?: LoopEconomicsEvidenceV1;
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
  /** Exact terminal evidence associated with the charged amount. */
  evidence?: LoopEconomicsEvidenceV1;
}

/** Input to a strict host's authoritative per-item cost measurement. */
export interface LoopBudgetCostMeasurementInput
  extends LoopBudgetSettlementScope {
  /** Successful body results for the completed item, keyed by body node id. */
  bodyResults: Readonly<Record<string, NodeResult>>;
  /** Retained pre-dispatch binding that terminal evidence must extend. */
  evidence?: LoopEconomicsEvidenceV1;
}

/** F: return of an unspent reservation on an abort/failure path. */
export interface LoopBudgetReleaseInput extends LoopBudgetSettlementScope {
  /** Conservative amount taken at reserve time, returned in full. */
  reservedCostCents: number;
  /** Why the reservation is being returned rather than settled. */
  reason: "aborted" | "failed";
  /** Retained pre-dispatch binding being released. */
  evidence?: LoopEconomicsEvidenceV1;
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
  settle?(input: LoopBudgetSettlementInput): unknown;
  /** Return an unspent reservation whose work never completed. */
  release?(input: LoopBudgetReleaseInput): unknown;
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
  /** New strict mode: cents-only evidence is readable but cannot dispatch. */
  evidenceMode?: "required";
  /**
   * Optional host-authored `for_each` item ceiling. Predicate loops take their
   * ceiling from `typedWhile.iterationBudgetCents`, so a strict host serving
   * only predicate loops does not need to invent an unrelated item value.
   */
  itemBudgetCents?: number;
  settle(input: LoopBudgetSettlementInput): unknown;
  release(input: LoopBudgetReleaseInput): unknown;
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

