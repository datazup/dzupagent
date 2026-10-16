/**
 * Reservation admission outcomes for one `for_each` item, split out of
 * `for-each-loop.ts` (DZUPAGENT-CODE-H-11) with their logic unchanged.
 *
 * A reserve whose outcome is unknown is reconciled, and an over-ceiling
 * reservation is released, before any body work; both end the item.
 *
 * @module pipeline/loop-executor/for-each-item-admission
 */

import {
  deriveItemReservationId,
  type HeldItemReservation,
} from "./for-each-reservation.js";
import type {
  ForEachItemBudgetLifecycle,
  ForEachRunContext,
} from "./for-each-run-context.js";

export type ForEachReserveResult = Awaited<ReturnType<ForEachItemBudgetLifecycle["reserveItem"]>>;

export type ForEachItemAdmission =
  | { readonly terminal: true }
  | { readonly terminal: false; readonly held: HeldItemReservation | undefined };

/**
 * Close a refused reservation (`terminal: true`), or pass through the admitted
 * hold, if any, that the item's body work is charged against.
 */
export async function admitItemReservation(
  run: ForEachRunContext,
  input: {
    index: number;
    attempt: number;
    held: HeldItemReservation | ForEachReserveResult;
    retryReleasedGraph: boolean;
    iterStart: number;
  }
): Promise<ForEachItemAdmission> {
  const { index, attempt, held, retryReleasedGraph, iterStart } = input;
  const { loopNode, resume, startTime, itemBudgetCents, iterationDurations, breachBudget, fail, recordTerminalOutcome } = run;
  const { reconcileUnknownReservation, releaseItem, readReconciledSettledCost, resolveUnknownRelease } = run.lifecycle;
  // A thrown reserve is reconciled before dispatch. Absent/released proves a
  // clean denial; reserved proves a hold exists and therefore requires the
  // strict host's release lifecycle before denial. Settled, unknown, and
  // conflict cannot authorize body work and remain blocked.
  if (typeof held === "object" && held !== null && "outcomeUnknown" in held) {
    const reconciliation = await reconcileUnknownReservation(
      index,
      attempt,
      held.outcomeUnknown,
      "reserve"
    );
    let reconciledHeld: HeldItemReservation | undefined;
    let blocked: string | undefined;
    if (reconciliation.status === "blocked") {
      blocked = reconciliation.error;
    } else if (reconciliation.status === "settled") {
      const settled = readReconciledSettledCost(reconciliation, "reserve");
      blocked =
        "error" in settled
          ? settled.error
          : `Loop "${loopNode.id}" item ${index} was charged ` +
            `${settled.settledCostCents} cents before its body was admitted; ` +
            "dispatch is blocked";
    } else if (reconciliation.status === "reserved") {
      if (
        !Number.isSafeInteger(reconciliation.reservedCostCents) ||
        reconciliation.reservedCostCents < 0 ||
        reconciliation.reservedCostCents > (itemBudgetCents as number)
      ) {
        blocked =
          `Loop "${loopNode.id}" item ${index} reserve reconciliation ` +
          `reported invalid hold ${String(reconciliation.reservedCostCents)}`;
      } else {
        reconciledHeld = {
          itemIndex: index,
          attempt,
          reservationId: deriveItemReservationId({
            ...(resume?.budgetRunId === undefined
              ? {}
              : { runId: resume.budgetRunId }),
            loopNodeId: loopNode.id,
            itemIndex: index,
            attempt,
          }),
          reservedCostCents: reconciliation.reservedCostCents,
          ...(reconciliation.evidence === undefined
            ? {}
            : { evidence: reconciliation.evidence }),
        };
        const release = await releaseItem(reconciledHeld, "failed");
        if (release !== undefined) {
          const releaseResolution = await resolveUnknownRelease(
            reconciledHeld,
            "failed",
            release.outcomeUnknown
          );
          if (releaseResolution.status !== "released") {
            blocked =
              releaseResolution.status === "blocked"
                ? releaseResolution.error
                : `Loop "${loopNode.id}" item ${index} was charged ` +
                  `${releaseResolution.settledCostCents} cents while closing ` +
                  "a reserve that failed before dispatch";
          }
        }
      }
    }

    if (held.malformed === true && blocked === undefined) {
      blocked =
        `Loop "${loopNode.id}" item ${index} reserve returned malformed ` +
        "evidence; reconciliation cannot turn that contradictory response " +
        "into authoritative admission";
    }

    if (blocked !== undefined) {
      breachBudget();
      fail({
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error: blocked,
      });
      await recordTerminalOutcome(index, "outcome_unknown", reconciledHeld);
      iterationDurations[index] = Date.now() - iterStart;
      return { terminal: true };
    }

    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} budget is unknown: ` +
        "its reservation failed and was reconciled as not outstanding",
    });
    // A clean no-hold denial still consumes a retry attempt. Retain that
    // identity without inventing reservation economics; the selected graph
    // continues to identify the earlier released hold until reserve succeeds.
    await recordTerminalOutcome(index, "denied", reconciledHeld, undefined,
      retryReleasedGraph ? attempt : undefined);
    iterationDurations[index] = Date.now() - iterStart;
    return { terminal: true };
  }

  if (
    typeof held === "object" &&
    held !== null &&
    "deniedHeld" in held
  ) {
    const deniedHeld = held.deniedHeld;
    const release = await releaseItem(deniedHeld, "failed");
    const resolution =
      release === undefined
        ? ({ status: "released" } as const)
        : await resolveUnknownRelease(
            deniedHeld,
            "failed",
            release.outcomeUnknown
          );
    if (resolution.status !== "released") {
      breachBudget();
      fail({
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          resolution.status === "blocked"
            ? resolution.error
            : `Loop "${loopNode.id}" item ${index} was charged ` +
              `${resolution.settledCostCents} cents while closing an ` +
              "over-ceiling reservation",
      });
      await recordTerminalOutcome(
        index,
        "outcome_unknown",
        held.retainEvidence === false ? undefined : deniedHeld
      );
      iterationDurations[index] = Date.now() - iterStart;
      return { terminal: true };
    }

    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        held.denialReason ??
        (`Loop "${loopNode.id}" item ${index} reservation of ` +
          `${deniedHeld.reservedCostCents} cents exceeds its ` +
          `${String(itemBudgetCents)}-cent ceiling and was released`),
    });
    await recordTerminalOutcome(
      index,
      "denied",
      held.retainEvidence === false ? undefined : deniedHeld,
      undefined, retryReleasedGraph ? attempt : undefined
    );
    iterationDurations[index] = Date.now() - iterStart;
    return { terminal: true };
  }

  return { terminal: false, held };
}
