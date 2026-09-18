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

import type { LoopNode, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type {
  LoopBudgetReconcileOutcome,
  LoopResumeOptions,
} from "./types.js";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import type { LoopEconomicsEvidenceV2 } from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";
import type { ForEachEconomicsV2Preparation } from "./budget-types.js";
import {
  buildLoopEconomicsEvidenceOwner,
  validateLoopEconomicsBoundary,
} from "./economics-evidence.js";
import { validateForEachEvidenceV2 } from "./for-each-item-economics-v2.js";
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
  /** DSL-V2-HOST-BRIDGE-20260918: present iff the host profile is `required-v2`. */
  economicsV2?: ForEachEconomicsV2Preparation;
}

/**
 * Build the release / reconcile half of the per-item budget lifecycle.
 *
 * Every returned member is the same closure the loop executor previously
 * declared inline, so call sites and behaviour are unchanged.
 */
export function createReleaseAndReconcile(deps: ItemBudgetLifecycleDeps) {
  const { loopNode, bodyNodes, itemBudgetCents, resume, economicsV2 } = deps;
  const v2Mode = resume?.budgetEvidenceMode === "required-v2";

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
        ...(held.economicsV2 === undefined ? {} : { evidenceV2: held.economicsV2.evidence }),
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
        evidenceV2?: LoopEconomicsEvidenceV2;
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
      ...(outcome.cost.evidenceV2 === undefined
        ? {}
        : { evidenceV2: outcome.cost.evidenceV2 }),
    };
  };

  type ReleaseResolution =
    | { status: "released" }
    | {
        status: "settled";
        settledCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
        evidenceV2?: LoopEconomicsEvidenceV2;
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
        ...(retained?.economicsV2 === undefined
          ? {}
          : { evidenceV2: retained.economicsV2.evidence }),
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
    if (v2Mode) {
      // A V2 unit is reconciled against the same admission it retained. A V1
      // record, or a V2 record of another admission, is a host contradiction
      // and can neither prove a hold nor a settlement.
      const answeredV1 =
        (outcome.status === "reserved" && outcome.evidence !== undefined) ||
        (outcome.status === "settled" && outcome.cost.evidence !== undefined);
      const answeredV2 = outcome.status === "reserved"
        ? outcome.evidenceV2
        : outcome.status === "settled" ? outcome.cost.evidenceV2 : undefined;
      if (answeredV1) {
        return { status: "blocked", error: `Loop "${loopNode.id}" item ${index} reconciliation after ${boundary} answered with V1 evidence under the V2 host profile` };
      }
      if (
        answeredV2 !== undefined &&
        (retained?.economicsV2 === undefined ||
          answeredV2.admissionDigest !== retained.economicsV2.evidence.admissionDigest)
      ) {
        return { status: "blocked", error: `Loop "${loopNode.id}" item ${index} reconciliation after ${boundary} answered with a V2 record of another admission` };
      }
      if (
        answeredV2 !== undefined &&
        outcome.status === "settled" &&
        outcome.cost.status === "known" &&
        economicsV2 !== undefined &&
        retained?.economicsV2 !== undefined
      ) {
        const owner = buildLoopEconomicsEvidenceOwner({
          runId: resume?.budgetRunId,
          loopNodeId: loopNode.id,
          reservationId,
          iteration: index + 1,
          itemIndex: index,
          attempt,
        });
        const check = owner === undefined
          ? "exact loop economics requires a non-empty runtime run identity"
          : validateForEachEvidenceV2(answeredV2, {
              preparation: economicsV2,
              owner,
              unitAttempt: attempt,
              reservedCostCents: retained.reservedCostCents,
              settledCostCents: outcome.cost.costCents,
              resolutionStatus: "settled",
              leafIdempotencyKeys: economicsV2.leafIdempotencyKeys(index, attempt),
              admissionDigest: retained.economicsV2.evidence.admissionDigest,
            });
        if (check !== undefined) {
          return { status: "blocked", error: `settlement reconciliation returned an invalid V2 record: ${check}` };
        }
      }
      return outcome;
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
              ...(settled.evidenceV2 === undefined
                ? {}
                : { evidenceV2: settled.evidenceV2 }),
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
        evidenceV2?: LoopEconomicsEvidenceV2;
        overrun?: string;
      }
    | { status: "blocked"; error: string };

  /** Resolve an unobserved settlement from the body-complete receipt. */

  const resolveUnknownSettlement = async (
    held: HeldItemReservation,
    actualCostCents: number,
    reason: string,
    terminalEvidence?: LoopEconomicsEvidenceV1,
    terminalEvidenceV2?: LoopEconomicsEvidenceV2
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
        ...(settled.evidenceV2 === undefined
          ? {}
          : { evidenceV2: settled.evidenceV2 }),
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
        ...(terminalEvidenceV2 === undefined
          ? {}
          : { evidenceV2: terminalEvidenceV2 }),
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
          ...(settled.evidenceV2 === undefined
            ? {}
            : { evidenceV2: settled.evidenceV2 }),
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
      ...(terminalEvidenceV2 === undefined
        ? {}
        : { evidenceV2: terminalEvidenceV2 }),
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
