/**
 * Release and outcome-unknown reconciliation for `for_each` item budgets.
 *
 * Everything here is about giving a reservation back, or proving what actually
 * happened when the host could not say. A reserve, settle or release that
 * answers "outcome unknown" leaves the ledger in a state where neither
 * releasing the money nor redispatching the item is safe (doc 27 section 8
 * prereq 6), so the item is reconciled against the host and fails closed rather
 * than being guessed at.
 *
 * The reserve/settle half lives in `for-each-item-budget.ts`, which composes
 * both halves into one lifecycle. Nothing here calls into that module.
 *
 * @module pipeline/loop-executor/for-each-item-budget-release
 */

import type {
  LoopNode,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type {
  LoopBudgetReconcileOutcome,
  LoopResumeOptions,
} from "./types.js";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import { validateLoopEconomicsBoundary } from "./economics-evidence.js";
import {
  deriveItemReservationId,
  reservedCostCentsFromEvidence,
  type HeldItemReservation,
} from "./for-each-reservation.js";

/** The loop values the item budget lifecycle closes over. */
export interface ItemBudgetLifecycleDeps {
  loopNode: LoopNode;
  bodyNodes: PipelineNode[];
  /** Hard per-item ceiling; `undefined` disables the whole lifecycle. */
  itemBudgetCents: number | undefined;
  resume: LoopResumeOptions | undefined;
}

/**
 * Build the release / reconcile half of the per-item budget lifecycle.
 *
 * Every returned member is the same closure the loop executor previously
 * declared inline, so call sites and behaviour are unchanged.
 */
export function createReleaseAndReconcile(deps: ItemBudgetLifecycleDeps) {
  const { loopNode, bodyNodes, itemBudgetCents, resume } = deps;

  type ReconciledReservation =
    | Exclude<LoopBudgetReconcileOutcome, { status: "unknown" | "conflict" }>
    | { status: "blocked"; error: string };

  const releaseItem = async (
    held: HeldItemReservation | undefined,
    reason: "aborted" | "failed"
  ): Promise<{ outcomeUnknown: string } | undefined> => {
    if (held === undefined) return undefined;
    try {
      await resume?.releaseIterationBudget?.({
        loopNodeId: loopNode.id,
        iteration: held.itemIndex + 1,
        itemIndex: held.itemIndex,
        ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
        reservationId: held.reservationId,
        reservedCostCents: held.reservedCostCents,
        reason,
        ...(held.evidence === undefined ? {} : { evidence: held.evidence }),
      });
    } catch (error) {
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
      };
    }
    return undefined;
  };


  const readReconciledSettledCost = (
    outcome: Extract<LoopBudgetReconcileOutcome, { status: "settled" }>,
    boundary: "reserve" | "settle" | "release"
  ):
    | {
        settledCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
        overrun?: string;
      }
    | { error: string } => {
    if (outcome.cost.status === "unknown") {
      return {
        error:
          `Loop "${loopNode.id}" reconciliation after ${boundary} reported ` +
          `settled usage/cost as unknown: ${outcome.cost.reason ?? "no reason"}`,
      };
    }
    const settledCostCents = outcome.cost.costCents;
    if (!Number.isSafeInteger(settledCostCents) || settledCostCents < 0) {
      return {
        error:
          `Loop "${loopNode.id}" reconciliation after ${boundary} reported ` +
          `invalid settled cost ${String(settledCostCents)}`,
      };
    }
    return {
      settledCostCents,
      ...(outcome.cost.evidence === undefined
        ? {}
        : { evidence: outcome.cost.evidence }),
    };
  };

  type ReleaseResolution =
    | { status: "released" }
    | {
        status: "settled";
        settledCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
      }
    | { status: "blocked"; error: string };

  /** Resolve an unobserved release, retrying once only when reconcile proves
   * the original reservation is still held by this writer. */

  /**
   * Observe an outcome-unknown reservation without assigning one generic
   * meaning to every lifecycle boundary. `released`, `absent`, `reserved`, and
   * `settled` are returned to the boundary-specific caller; only
   * unknown/conflict/transport failure collapse to a fail-closed block.
   */
  const reconcileUnknownReservation = async (
    index: number,
    attempt: number,
    reason: string,
    boundary: "reserve" | "settle" | "release",
    retained?: HeldItemReservation
  ): Promise<ReconciledReservation> => {
    const reservationId = deriveItemReservationId({
      ...(resume?.budgetRunId === undefined
        ? {}
        : { runId: resume.budgetRunId }),
      loopNodeId: loopNode.id,
      itemIndex: index,
      attempt,
    });
    const reconcile = resume?.reconcileIterationBudget;
    const blocked =
      `Loop "${loopNode.id}" item ${index} reservation ${reservationId} is ` +
      `outcome-unknown after its ${boundary} could not be observed and was ` +
      `not reconciled: ${reason}`;
    if (reconcile === undefined) return { status: "blocked", error: blocked };
    let outcome;
    try {
      outcome = await reconcile({
        loopNodeId: loopNode.id,
        iteration: index + 1,
        itemIndex: index,
        ...(attempt > 0 ? { attempt } : {}),
        reservationId,
        budgetCents: itemBudgetCents as number,
        reason,
        boundary,
        ...(retained?.evidence === undefined
          ? {}
          : { evidence: retained.evidence }),
      });
    } catch (error) {
      // A reconcile that itself fails proves nothing — stay blocked.
      return {
        status: "blocked",
        error:
          `${blocked} (reconciliation failed: ` +
          `${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (outcome.status === "conflict") {
      return {
        status: "blocked",
        error:
          `Loop "${loopNode.id}" item ${index} reservation ${reservationId} is ` +
          `held by another writer "${outcome.heldBy}" after its ${boundary}: ` +
          `${reason}`,
      };
    }
    if (outcome.status === "unknown") {
      return { status: "blocked", error: blocked };
    }
    if (outcome.status === "reserved") {
      const evidenceError = validateLoopEconomicsBoundary({
        evidenceMode: resume?.budgetEvidenceMode,
        evidence: outcome.evidence,
        runId: resume?.budgetRunId,
        loopNodeId: loopNode.id,
        reservationId,
        itemIndex: index,
        attempt,
        iteration: index + 1,
        reservedCostCents: outcome.reservedCostCents,
        terminalStatus: "pending",
        expectedNodeIds: bodyNodes.map(({ id }) => id),
        requiredExecutionNodeIds: bodyNodes
          .filter(({ type }) => type === "agent")
          .map(({ id }) => id),
        ...(retained?.evidence === undefined
          ? {}
          : {
              currentReservationBindingDigest:
                retained.evidence.reservationBindingDigest,
            }),
      });
      if (evidenceError !== undefined) {
        return {
          status: "blocked",
          error: `reconciliation returned invalid exact economics evidence: ${evidenceError}`,
        };
      }
    }
    if (outcome.status === "settled" && outcome.cost.status === "known") {
      const evidence = outcome.cost.evidence;
      const evidenceReservedCostCents =
        retained?.reservedCostCents ??
        reservedCostCentsFromEvidence(evidence);
      const evidenceError = validateLoopEconomicsBoundary({
        evidenceMode: resume?.budgetEvidenceMode,
        evidence,
        runId: resume?.budgetRunId,
        loopNodeId: loopNode.id,
        reservationId,
        itemIndex: index,
        attempt,
        iteration: index + 1,
        reservedCostCents: evidenceReservedCostCents,
        settledCostCents: outcome.cost.costCents,
        terminalStatus: "recorded",
        expectedNodeIds: bodyNodes.map(({ id }) => id),
        requiredExecutionNodeIds: bodyNodes
          .filter(({ type }) => type === "agent")
          .map(({ id }) => id),
        ...(retained?.evidence === undefined
          ? {}
          : {
              currentReservationBindingDigest:
                retained.evidence.reservationBindingDigest,
            }),
      });
      if (evidenceError !== undefined) {
        return {
          status: "blocked",
          error: `settlement reconciliation returned invalid exact economics evidence: ${evidenceError}`,
        };
      }
    }
    return outcome;
  };

  /**
   * Settle a completed item's reservation.
   *
   * Returns authoritative charged cents (plus an overrun marker when needed),
   * or an explicit unknown-cost / unobservable-settle result. `undefined`
   * applies only when no strict reservation was held.
   */

  const resolveUnknownRelease = async (
    held: HeldItemReservation,
    releaseReason: "aborted" | "failed",
    reason: string
  ): Promise<ReleaseResolution> => {
    const interpret = async (
      reconciliation: ReconciledReservation,
      allowRetry: boolean
    ): Promise<ReleaseResolution> => {
      if (reconciliation.status === "blocked") return reconciliation;
      if (
        reconciliation.status === "released" ||
        reconciliation.status === "absent"
      ) {
        return { status: "released" };
      }
      if (reconciliation.status === "settled") {
        const settled = readReconciledSettledCost(reconciliation, "release");
        return "error" in settled
          ? { status: "blocked", error: settled.error }
          : {
              status: "settled",
              settledCostCents: settled.settledCostCents,
              ...(settled.evidence === undefined
                ? {}
                : { evidence: settled.evidence }),
            };
      }
      if (
        !Number.isSafeInteger(reconciliation.reservedCostCents) ||
        reconciliation.reservedCostCents !== held.reservedCostCents
      ) {
        return {
          status: "blocked",
          error:
            `Loop "${loopNode.id}" item ${held.itemIndex} release ` +
            "reconciliation disagreed with the durable reservation amount",
        };
      }
      if (!allowRetry) {
        return {
          status: "blocked",
          error:
            `Loop "${loopNode.id}" item ${held.itemIndex} reservation remains ` +
            "held after a retried release; outcome is still unknown",
        };
      }
      const retry = await releaseItem(held, releaseReason);
      if (retry === undefined) return { status: "released" };
      const retried = await reconcileUnknownReservation(
        held.itemIndex,
        held.attempt,
        retry.outcomeUnknown,
        "release",
        held
      );
      return interpret(retried, false);
    };

    return interpret(
      await reconcileUnknownReservation(
        held.itemIndex,
        held.attempt,
        reason,
        "release",
        held
      ),
      true
    );
  };

  type SettlementResolution =
    | {
        status: "settled";
        settledCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
        overrun?: string;
      }
    | { status: "blocked"; error: string };

  /** Resolve an unobserved settlement from the body-complete receipt. */

  const resolveUnknownSettlement = async (
    held: HeldItemReservation,
    actualCostCents: number,
    reason: string,
    terminalEvidence?: LoopEconomicsEvidenceV1
  ): Promise<SettlementResolution> => {
    const observed = await reconcileUnknownReservation(
      held.itemIndex,
      held.attempt,
      reason,
      "settle",
      held
    );
    if (observed.status === "blocked") return observed;
    if (observed.status === "released" || observed.status === "absent") {
      return {
        status: "blocked",
        error:
          `Loop "${loopNode.id}" item ${held.itemIndex} settlement was not ` +
          `applied: reconciliation reported ${observed.status}; redispatch is blocked`,
      };
    }
    if (observed.status === "settled") {
      const settled = readReconciledSettledCost(observed, "settle");
      if ("error" in settled) return { status: "blocked", error: settled.error };
      return {
        status: "settled",
        settledCostCents: settled.settledCostCents,
        ...(settled.evidence === undefined
          ? {}
          : { evidence: settled.evidence }),
        ...(settled.settledCostCents > held.reservedCostCents
          ? {
              overrun:
                `Loop "${loopNode.id}" item ${held.itemIndex} settled ` +
                `${settled.settledCostCents} cents, exceeding its ` +
                `${held.reservedCostCents}-cent reservation`,
            }
          : {}),
      };
    }
    if (
      !Number.isSafeInteger(observed.reservedCostCents) ||
      observed.reservedCostCents !== held.reservedCostCents
    ) {
      return {
        status: "blocked",
        error:
          `Loop "${loopNode.id}" item ${held.itemIndex} settle reconciliation ` +
          "disagreed with the durable reservation amount",
      };
    }

    // The host authoritatively says the first settle did not land and the
    // original hold remains, so retrying this idempotent reservation is safe.
    try {
      await resume?.settleIterationBudget?.({
        loopNodeId: loopNode.id,
        iteration: held.itemIndex + 1,
        itemIndex: held.itemIndex,
        ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
        reservationId: held.reservationId,
        reservedCostCents: held.reservedCostCents,
        actualCostCents,
        ...(terminalEvidence === undefined
          ? {}
          : { evidence: terminalEvidence }),
      });
    } catch (error) {
      const retried = await reconcileUnknownReservation(
        held.itemIndex,
        held.attempt,
        error instanceof Error ? error.message : String(error),
        "settle",
        held
      );
      if (retried.status === "settled") {
        const settled = readReconciledSettledCost(retried, "settle");
        if ("error" in settled) {
          return { status: "blocked", error: settled.error };
        }
        return {
          status: "settled",
          settledCostCents: settled.settledCostCents,
          ...(settled.evidence === undefined
            ? {}
            : { evidence: settled.evidence }),
          ...(settled.settledCostCents > held.reservedCostCents
            ? {
                overrun:
                  `Loop "${loopNode.id}" item ${held.itemIndex} settled ` +
                  `${settled.settledCostCents} cents, exceeding its ` +
                  `${held.reservedCostCents}-cent reservation`,
              }
            : {}),
        };
      }
      return retried.status === "blocked"
        ? retried
        : {
            status: "blocked",
            error:
              `Loop "${loopNode.id}" item ${held.itemIndex} retried settle ` +
              `remains unresolved (${retried.status}); redispatch is blocked`,
          };
    }
    return {
      status: "settled",
      settledCostCents: actualCostCents,
      ...(terminalEvidence === undefined
        ? {}
        : { evidence: terminalEvidence }),
      ...(actualCostCents > held.reservedCostCents
        ? {
            overrun:
              `Loop "${loopNode.id}" item ${held.itemIndex} settled ` +
              `${actualCostCents} cents, exceeding its ` +
              `${held.reservedCostCents}-cent reservation`,
          }
        : {}),
    };
  };


  return {
    releaseItem,
    readReconciledSettledCost,
    reconcileUnknownReservation,
    resolveUnknownRelease,
    resolveUnknownSettlement,
  };
}
