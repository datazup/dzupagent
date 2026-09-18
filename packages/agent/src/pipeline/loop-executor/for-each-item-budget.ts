/**
 * Strict per-item budget lifecycle for the `for_each` loop executor.
 *
 * A hard item ceiling means every dispatched item must pass through
 * reserve -> (settle | release). This module owns the reserve/settle half and
 * the retained-economics validation they share; the release and
 * outcome-unknown reconciliation half lives in
 * `for-each-item-budget-release.ts`. `createItemBudgetLifecycle` composes both
 * into the single object the loop executor consumes.
 *
 * Split out of `for-each-loop.ts`, which keeps item dispatch, ordered-prefix
 * flushing and aggregation. The lifecycle closes over only the four values in
 * `ItemBudgetLifecycleDeps`, so it is a self-contained collaborator rather than
 * a view of the loop's mutable run state.
 *
 * @module pipeline/loop-executor/for-each-item-budget
 */

import type {
  PipelineForEachItemEconomics,
} from "@dzupagent/core/pipeline";
import type { NodeResult } from "../pipeline-runtime-types.js";
import type {
  LoopBudgetCostEvidence,
} from "./types.js";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import type { LoopEconomicsEvidenceV2 } from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";
import {
  buildLoopEconomicsEvidenceOwner,
  validateLoopEconomicsBoundary,
} from "./economics-evidence.js";
import {
  settledCentsFromEvidenceV2,
  validateForEachEvidenceV2,
} from "./for-each-item-economics-v2.js";
import {
  deriveItemReservationId,
  type HeldItemReservation,
} from "./for-each-reservation.js";
import {
  createReleaseAndReconcile,
  type ItemBudgetLifecycleDeps,
} from "./for-each-item-budget-release.js";

export type { ItemBudgetLifecycleDeps };

/**
 * Build the per-item budget lifecycle for one loop run.
 *
 * Every returned member is the same closure the loop executor previously
 * declared inline, so call sites and behaviour are unchanged.
 */
export function createItemBudgetLifecycle(deps: ItemBudgetLifecycleDeps) {
  const { loopNode, bodyNodes, itemBudgetCents, resume, economicsV2 } = deps;
  const v2Mode = resume?.budgetEvidenceMode === "required-v2";
  const ownerFor = (index: number, attempt: number, reservationId: string) =>
    buildLoopEconomicsEvidenceOwner({
      runId: resume?.budgetRunId,
      loopNodeId: loopNode.id,
      reservationId,
      iteration: index + 1,
      itemIndex: index,
      attempt,
    });

  const reserveItem = async (
    index: number,
    attempt: number,
    state: Record<string, unknown>
  ): Promise<
    | HeldItemReservation
    | undefined
    | { outcomeUnknown: string; malformed?: boolean }
    | {
        deniedHeld: HeldItemReservation;
        denialReason?: string;
        retainEvidence?: boolean;
      }
  > => {
    if (itemBudgetCents === undefined) return undefined;
    const reserve = resume?.reserveIterationBudget;
    const reservationId = deriveItemReservationId({
      ...(resume?.budgetRunId === undefined
        ? {}
        : { runId: resume.budgetRunId }),
      loopNodeId: loopNode.id,
      itemIndex: index,
      attempt,
    });
    // DSL-V2-HOST-BRIDGE-20260918: a V2 host is handed the exact inventory,
    // owner and keys its record must bind to, before it reserves anything.
    const v2Owner = economicsV2 === undefined ? undefined : ownerFor(index, attempt, reservationId);
    const v2Keys = economicsV2 === undefined ? undefined : economicsV2.leafIdempotencyKeys(index, attempt);
    let reservation;
    try {
      reservation =
        reserve === undefined
          ? ({ status: "unknown" } as const)
          : await reserve({
              loopNodeId: loopNode.id,
              iteration: index + 1,
              budgetCents: itemBudgetCents,
              bodyNodeIds: bodyNodes.map(({ id }) => id),
              state,
              itemIndex: index,
              ...(attempt > 0 ? { attempt } : {}),
              reservationId,
              ...(economicsV2 === undefined || v2Owner === undefined || v2Keys === undefined
                ? {}
                : {
                    economicsV2: {
                      owner: v2Owner,
                      unitAttempt: attempt,
                      inventory: economicsV2.inventory,
                      leafIdempotencyKeys: v2Keys,
                    },
                  }),
            });
    } catch (error) {
      // The call may have created the reservation before the transport failed,
      // so its existence is genuinely unknown and neither releasing nor
      // redispatching is safe. Hand it to reconciliation; strict answered
      // `unknown` follows the same authority rule below.
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
      };
    }
    if (reservation.status === "unknown") {
      return {
        outcomeUnknown:
          "the strict host answered that reservation authority is unknown",
      };
    }
    if (
      !Number.isSafeInteger(reservation.reservedCostCents) ||
      reservation.reservedCostCents < 0
    ) {
      return {
        outcomeUnknown:
          `the strict host returned malformed reserved cost ` +
          `${String(reservation.reservedCostCents)}`,
        malformed: true,
      };
    }
    const held: HeldItemReservation = {
      reservedCostCents: reservation.reservedCostCents,
      itemIndex: index,
      attempt,
      reservationId,
      ...(reservation.evidence === undefined
        ? {}
        : { evidence: reservation.evidence }),
    };
    if (v2Mode) {
      const denial =
        economicsV2 === undefined || v2Owner === undefined || v2Keys === undefined
          ? "the V2 unit has no prepared inventory or run identity"
          : reservation.evidence !== undefined
            ? "the V2 host returned V1 exact evidence"
            : reservation.evidenceV2 === undefined
              ? "the V2 host returned no V2 selected/skipped-leaf record"
              : validateForEachEvidenceV2(reservation.evidenceV2, {
                  preparation: economicsV2,
                  owner: v2Owner,
                  unitAttempt: attempt,
                  reservedCostCents: reservation.reservedCostCents,
                  resolutionStatus: "pending",
                  leafIdempotencyKeys: v2Keys,
                });
      if (denial !== undefined) {
        return {
          deniedHeld: held,
          denialReason:
            `Loop "${loopNode.id}" item ${index} returned invalid V2 ` +
            `selected/skipped-leaf economics: ${denial}`,
          retainEvidence: false,
        };
      }
      const admitted: HeldItemReservation = {
        ...held,
        economicsV2: { evidence: reservation.evidenceV2 as LoopEconomicsEvidenceV2 },
      };
      return reservation.reservedCostCents > itemBudgetCents
        ? { deniedHeld: admitted }
        : admitted;
    }
    const evidenceError = validateLoopEconomicsBoundary({
      evidenceMode: resume?.budgetEvidenceMode,
      evidence: reservation.evidence,
      runId: resume?.budgetRunId,
      loopNodeId: loopNode.id,
      reservationId,
      itemIndex: index,
      attempt,
      iteration: index + 1,
      reservedCostCents: reservation.reservedCostCents,
      terminalStatus: "pending",
      expectedNodeIds: bodyNodes.map(({ id }) => id),
      requiredExecutionNodeIds: bodyNodes
        .filter(({ type }) => type === "agent")
        .map(({ id }) => id),
    });
    if (evidenceError !== undefined) {
      return {
        deniedHeld: held,
        denialReason:
          `Loop "${loopNode.id}" item ${index} returned invalid exact ` +
          `economics evidence: ${evidenceError}`,
        retainEvidence: false,
      };
    }
    return reservation.reservedCostCents > itemBudgetCents
      ? { deniedHeld: held }
      : held;
  };


  const validateRetainedItemEconomics = (
    index: number,
    attempt: number,
    economics: PipelineForEachItemEconomics
  ): string | undefined => {
    const reservationId = deriveItemReservationId({
      ...(resume?.budgetRunId === undefined
        ? {}
        : { runId: resume.budgetRunId }),
      loopNodeId: loopNode.id,
      itemIndex: index,
      attempt,
    });
    if (economics.reservationId !== reservationId) {
      return (
        `checkpoint reservation ${economics.reservationId} does not match ` +
        `the deterministic owner ${reservationId}`
      );
    }
    if (
      !Number.isSafeInteger(economics.reservedCostCents) ||
      economics.reservedCostCents < 0 ||
      economics.reservedCostCents > (itemBudgetCents as number)
    ) {
      return `checkpoint carries invalid reserved cost ${String(economics.reservedCostCents)}`;
    }
    if (
      economics.settledCostCents !== undefined &&
      (!Number.isSafeInteger(economics.settledCostCents) ||
        economics.settledCostCents < 0)
    ) {
      return `checkpoint carries invalid settled cost ${String(economics.settledCostCents)}`;
    }
    if (v2Mode) {
      if (economics.evidence !== undefined) {
        return "checkpoint carries V1 exact evidence under the V2 host profile; upgrade is denied";
      }
      if (economics.evidenceV2 === undefined) {
        return "evidence-required-v2 checkpoint carries no V2 selected/skipped-leaf record";
      }
      const owner = ownerFor(index, attempt, reservationId);
      if (economicsV2 === undefined || owner === undefined) {
        return "the V2 unit has no prepared inventory or run identity";
      }
      return validateForEachEvidenceV2(economics.evidenceV2, {
        preparation: economicsV2,
        owner,
        unitAttempt: attempt,
        reservedCostCents: economics.reservedCostCents,
        ...(economics.settledCostCents === undefined
          ? {}
          : { settledCostCents: economics.settledCostCents, resolutionStatus: "settled" as const }),
        leafIdempotencyKeys: economicsV2.leafIdempotencyKeys(index, attempt),
      });
    }
    if (economics.evidenceV2 !== undefined) {
      return "checkpoint carries V2 selected/skipped-leaf economics under a host profile that cannot serve it; downgrade is denied";
    }
    return validateLoopEconomicsBoundary({
      evidenceMode: resume?.budgetEvidenceMode,
      evidence: economics.evidence,
      runId: resume?.budgetRunId,
      loopNodeId: loopNode.id,
      reservationId,
      itemIndex: index,
      attempt,
      iteration: index + 1,
      reservedCostCents: economics.reservedCostCents,
      ...(economics.settledCostCents === undefined
        ? {}
        : { settledCostCents: economics.settledCostCents }),
      terminalStatus:
        economics.settledCostCents === undefined ? "pending" : "recorded",
      expectedNodeIds: bodyNodes.map(({ id }) => id),
      requiredExecutionNodeIds: bodyNodes
        .filter(({ type }) => type === "agent")
        .map(({ id }) => id),
    });
  };

  const settleItem = async (
    held: HeldItemReservation | undefined,
    bodyResults: Readonly<Record<string, NodeResult>>
  ): Promise<
    | undefined
    | {
        outcomeUnknown: string;
        actualCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
        evidenceV2?: LoopEconomicsEvidenceV2;
      }
    | { costUnknown: string }
    // 24-G: a clean settle now reports what was ACTUALLY settled, so the
    // terminal record carries the real charged amount rather than re-deriving
    // it from the reservation. Re-deriving would silently report the reserved
    // amount whenever an extractor returned something smaller.
    | {
        settledCostCents: number;
        evidence?: LoopEconomicsEvidenceV1;
        evidenceV2?: LoopEconomicsEvidenceV2;
        overrun?: string;
      }
  > => {
    if (held === undefined) return undefined;
    // V2: the resolved record is the accounting truth; the host measures
    // against it and must agree with the sum of its recorded charges.
    let derivedCentsV2: number | undefined;
    if (v2Mode) {
      if (held.economicsV2 === undefined) {
        return { costUnknown: "the V2 unit has no resolved record to settle" };
      }
      const derived = settledCentsFromEvidenceV2(held.economicsV2.evidence);
      if (derived.status === "unknown") {
        return { costUnknown: `recorded V2 charges cannot be summed: ${derived.reason}` };
      }
      derivedCentsV2 = derived.cents;
    }
    let cost: LoopBudgetCostEvidence;
    try {
      cost =
        (await resume?.measureItemCost?.({
          loopNodeId: loopNode.id,
          iteration: held.itemIndex + 1,
          itemIndex: held.itemIndex,
          ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
          reservationId: held.reservationId,
          bodyResults,
          ...(held.evidence === undefined ? {} : { evidence: held.evidence }),
          ...(held.economicsV2 === undefined ? {} : { evidenceV2: held.economicsV2.evidence }),
        })) ?? {
          status: "unknown",
          reason: "the strict host did not provide cost evidence",
        };
    } catch (error) {
      cost = {
        status: "unknown",
        reason:
          error instanceof Error ? error.message : String(error),
      };
    }
    if (cost.status === "unknown") {
      return {
        costUnknown:
          cost.reason ?? "the host reported item usage/cost as unknown",
      };
    }
    const actualCostCents = cost.costCents;
    if (!Number.isSafeInteger(actualCostCents) || actualCostCents < 0) {
      return {
        costUnknown:
          `the host reported non-finite/non-integer item cost ` +
          `${String(actualCostCents)}`,
      };
    }
    const evidenceError = validateLoopEconomicsBoundary({
      evidenceMode: resume?.budgetEvidenceMode,
      evidence: cost.evidence,
      runId: resume?.budgetRunId,
      loopNodeId: loopNode.id,
      reservationId: held.reservationId,
      itemIndex: held.itemIndex,
      attempt: held.attempt,
      iteration: held.itemIndex + 1,
      reservedCostCents: held.reservedCostCents,
      settledCostCents: actualCostCents,
      terminalStatus: "recorded",
      expectedNodeIds: bodyNodes.map(({ id }) => id),
      requiredExecutionNodeIds: bodyNodes
        .filter(({ type }) => type === "agent")
        .map(({ id }) => id),
      ...(held.evidence === undefined
        ? {}
        : {
            currentReservationBindingDigest:
              held.evidence.reservationBindingDigest,
          }),
    });
    if (evidenceError !== undefined) {
      return {
        costUnknown:
          `terminal exact economics evidence is invalid; settlement was not ` +
          `attempted: ${evidenceError}`,
      };
    }
    let settledV2: LoopEconomicsEvidenceV2 | undefined;
    if (v2Mode && held.economicsV2 !== undefined) {
      if (actualCostCents !== derivedCentsV2) {
        return {
          costUnknown:
            `the host measured ${actualCostCents} cents but the recorded V2 ` +
            `charges settle ${String(derivedCentsV2)} cents`,
        };
      }
      if (cost.evidence !== undefined) {
        return { costUnknown: "the V2 host measured with V1 exact evidence" };
      }
      settledV2 = cost.evidenceV2 ?? held.economicsV2.evidence;
      const owner = ownerFor(held.itemIndex, held.attempt, held.reservationId);
      const v2Error = economicsV2 === undefined || owner === undefined
        ? "the V2 unit has no prepared inventory or run identity"
        : validateForEachEvidenceV2(settledV2, {
            preparation: economicsV2,
            owner,
            unitAttempt: held.attempt,
            reservedCostCents: held.reservedCostCents,
            settledCostCents: actualCostCents,
            resolutionStatus: "settled",
            leafIdempotencyKeys: economicsV2.leafIdempotencyKeys(held.itemIndex, held.attempt),
            admissionDigest: held.economicsV2.evidence.admissionDigest,
          });
      if (v2Error !== undefined) {
        return {
          costUnknown:
            `terminal V2 selected/skipped-leaf record is invalid; settlement ` +
            `was not attempted: ${v2Error}`,
        };
      }
    }
    try {
      await resume?.settleIterationBudget?.({
        loopNodeId: loopNode.id,
        iteration: held.itemIndex + 1,
        itemIndex: held.itemIndex,
        ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
        reservationId: held.reservationId,
        reservedCostCents: held.reservedCostCents,
        actualCostCents,
        ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
        ...(settledV2 === undefined ? {} : { evidenceV2: settledV2 }),
      });
    } catch (error) {
      // G2d (prereq 7): the item's WORK completed, but whether its reservation
      // was settled is now unknown — the host may have applied the settlement
      // before the transport failed. Releasing would refund money already
      // charged; assuming success would leave a reservation outstanding
      // forever. Only reconciliation can prove which, so hand it over rather
      // than letting the throw escape the loop unclassified.
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
        actualCostCents,
        ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
        ...(settledV2 === undefined ? {} : { evidenceV2: settledV2 }),
      };
    }
    return actualCostCents > held.reservedCostCents
      ? {
          settledCostCents: actualCostCents,
          ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
          ...(settledV2 === undefined ? {} : { evidenceV2: settledV2 }),
          overrun:
            `Loop "${loopNode.id}" item ${held.itemIndex} settled ${actualCostCents} cents, ` +
            `exceeding its ${held.reservedCostCents}-cent reservation`,
        }
      : {
          settledCostCents: actualCostCents,
          ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
          ...(settledV2 === undefined ? {} : { evidenceV2: settledV2 }),
        };
  };

  /**
   * Return an unspent reservation whose work never completed.
   *
   * G2d (prereq 7): returns an `outcomeUnknown` marker when the release call
   * could not be observed. A thrown release is not proof the reservation is
   * still held — the host may have returned it before the transport failed —
   * so redispatching or declaring the item terminally settled would both be
   * guesses. `undefined` means the reservation was returned cleanly.
   */

  return {
    reserveItem,
    validateRetainedItemEconomics,
    settleItem,
    ...createReleaseAndReconcile(deps),
  };
}
