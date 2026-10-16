/**
 * Terminal exits of one dispatched `for_each` item, split out of
 * `for-each-loop.ts` (DZUPAGENT-CODE-H-11) with their logic unchanged:
 *
 * - `releaseIncompleteItem` returns the reservation of an item that was
 *   aborted or whose body failed;
 * - `settleCompletedItem` persists the item's aggregate receipt and settles
 *   its actual spend against the reservation.
 *
 * @module pipeline/loop-executor/for-each-item-exits
 */

import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import type { NodeResult } from "../pipeline-runtime-types.js";
import type { ForEachItemEconomicsV2Custody } from "./for-each-item-economics-v2.js";
import type {
  HeldItemEconomicsV2,
  HeldItemReservation,
} from "./for-each-reservation.js";
import {
  aggregateReceiptResult,
  collectIterationValue,
} from "./for-each-aggregate-receipt.js";
import type { ForEachRunContext } from "./for-each-run-context.js";

/** Exits 1 and 2: the item was aborted, or one of its body nodes failed. */
export async function releaseIncompleteItem(
  run: ForEachRunContext,
  input: {
    index: number;
    custody: ForEachItemEconomicsV2Custody | undefined;
    custodyBlocked: string | undefined;
    admittedHeld: HeldItemReservation | undefined;
    haltedBeforeBody: boolean;
    iterStart: number;
  }
): Promise<void> {
  const { index, custody, custodyBlocked, admittedHeld, haltedBeforeBody, iterStart } = input;
  const { loopNode, startTime, iterationDurations, breachBudget, failOverride, recordTerminalOutcome, adoptResolved } = run;
  const { releaseItem, resolveUnknownRelease } = run.lifecycle;
  // DSL-V2-HOST-BRIDGE-20260918 (§3.4): an unproven leaf — the host could
  // not say whether it dispatched, or the custody contradicts its frame —
  // leaves money and effects in an unknown state. Nothing is released or
  // settled; the record and its outcomes are retained for reconciliation.
  if (custody !== undefined && custodyBlocked !== undefined) {
    breachBudget();
    failOverride({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} V2 leaf accounting is unresolved: ` +
        `${custodyBlocked}; redispatch is blocked until the host reconciles`,
    });
    await recordTerminalOutcome(index, "outcome_unknown", admittedHeld);
    iterationDurations[index] = Date.now() - iterStart;
    return;
  }
  // V2: every leaf that never dispatched is released with the reason the
  // unit stopped for, so the host receives a resolved record that keeps
  // the charges it recorded and returns nothing else blind.
  let terminalHeld: HeldItemReservation | undefined = admittedHeld;
  if (custody !== undefined && admittedHeld !== undefined) {
    custody.releaseRemaining(haltedBeforeBody ? "cancelled-before-dispatch" : "prior-leaf-failed");
    const resolution = custody.resolve();
    if (resolution.status === "settled") {
      adoptResolved(index, resolution.evidence);
      terminalHeld = { ...admittedHeld, economicsV2: { evidence: resolution.evidence } };
    }
  }
  // F: exits 1 and 2 — aborted, or a body node failed. The item never
  // completed, so its reservation is returned in full rather than settled.
  // Leaking here is the original defect reproduced one level down.
  // 24-I: an item halted mid-flight by another worker's budget breach was
  // stopped by a signal, not by its own body reporting an error, so it
  // releases as `aborted` exactly like a host cancellation does. Reading
  // `context.signal` alone here would release it as `failed` and tell the
  // host this item's work errored when it never ran.
  const releaseOutcome = await releaseItem(
    terminalHeld,
    haltedBeforeBody ? "aborted" : "failed"
  );
  // G2d (prereq 7): a release that could not be observed leaves this item
  // in a non-terminal settlement state. Reconcile is the only proof; until
  // it answers, the loop stops rather than reporting a clean failure over
  // an unaccounted reservation.
  //
  // This OVERWRITES `firstError` rather than using `??=`, unlike every
  // other exit. The body error that triggered this release is already
  // recorded, but an unaccounted reservation is the strictly more severe
  // fact: a failed item is an expected outcome the author can handle,
  // whereas money in an unknown state is an operator-visible integrity
  // breach. Reporting the body error here would hide it.
  let releaseUnresolved = false;
  let releaseSettledCostCents: number | undefined;
  let releaseSettledEvidence: LoopEconomicsEvidenceV1 | undefined;
  let releaseSettledEvidenceV2: HeldItemEconomicsV2["evidence"] | undefined;
  if (releaseOutcome !== undefined) {
    const resolution = await resolveUnknownRelease(
      // `releaseItem` returns an unknown marker only when it received a
      // concrete reservation, so this correlation is guaranteed here.
      terminalHeld as HeldItemReservation,
      haltedBeforeBody ? "aborted" : "failed",
      releaseOutcome.outcomeUnknown
    );
    if (resolution.status === "blocked") {
      releaseUnresolved = true;
      breachBudget();
      failOverride({
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error: resolution.error,
      });
    } else if (resolution.status === "settled") {
      releaseSettledCostCents = resolution.settledCostCents;
      releaseSettledEvidence = resolution.evidence;
      releaseSettledEvidenceV2 = resolution.evidenceV2;
      breachBudget();
      failOverride({
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} failed before completion ` +
          `but release reconciliation proves it was charged ` +
          `${resolution.settledCostCents} cents; redispatch is blocked`,
      });
    }
  }
  // 24-G exits 1 and 2. `aborted` and `failed` are kept distinct for the
  // same reason `denied` is: a cancelled item was stopped by a signal
  // while a failed one ran and its body reported an error, and an operator
  // reconciling work against spend needs to tell those apart.
  //
  // An unresolvable release outranks both. The item's work did stop, but
  // its reservation's state is unproven, and reporting a clean `failed`
  // over money in an unknown state is precisely what G2d fails closed on.
  // This mirrors the `firstError` overwrite directly above.
  await recordTerminalOutcome(
    index,
    releaseUnresolved
      ? "outcome_unknown"
      : // 24-I: `haltedBeforeBody` covers a host abort AND a breach raised
      // by another worker. Both stopped this item at the dispatch gate
      // with no body error of its own, which is what `cancelled` means.
      haltedBeforeBody
      ? "cancelled"
      : "failed",
    // The reservation was released rather than settled, so it carries no
    // settled cost — a released reservation charged nothing.
    terminalHeld === undefined
      ? undefined
      : {
          ...terminalHeld,
          ...(releaseSettledEvidence === undefined ? {} : { evidence: releaseSettledEvidence }),
          ...(releaseSettledEvidenceV2 === undefined ? {} : { economicsV2: { evidence: releaseSettledEvidenceV2 } }),
        },
    releaseSettledCostCents
  );
  iterationDurations[index] = Date.now() - iterStart;
}

/**
 * Exit 3: the item's body completed. Returns the item's collected value once
 * it is settled and durably completed, or `undefined` when the item ended in
 * another terminal outcome.
 */
export async function settleCompletedItem(
  run: ForEachRunContext,
  input: {
    index: number;
    attempt: number;
    custody: ForEachItemEconomicsV2Custody | undefined;
    admittedHeld: HeldItemReservation | undefined;
    iterationState: Record<string, unknown>;
    iterationPreviousResults: Map<string, NodeResult>;
    retainedBodyResults: Record<string, NodeResult>;
    lastBodyResult: NodeResult | undefined;
    iterStart: number;
  }
): Promise<{ collectedValue: { status: "known"; value: unknown } | undefined } | undefined> {
  const {
    index, attempt, custody, admittedHeld, iterationState,
    iterationPreviousResults, retainedBodyResults, lastBodyResult, iterStart,
  } = input;
  const { loopNode, contract, startTime, iterationDurations, breachBudget, fail, recordTerminalOutcome, checkpointAggregateReceipt, adoptResolved } = run;
  const { settleItem, resolveUnknownSettlement } = run.lifecycle;
  // DSL-V2-HOST-BRIDGE-20260918: the body completed, so every leaf must be
  // recorded or released; the resolved record is what settlement charges.
  let completedHeld: HeldItemReservation | undefined = admittedHeld;
  if (custody !== undefined && admittedHeld !== undefined) {
    const resolution = custody.resolve();
    if (resolution.status !== "settled") {
      breachBudget();
      fail({
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} completed its body but its V2 leaf ` +
          `accounting is unresolved: ${resolution.status === "pending" ? resolution.error : "a leaf outcome is unknown"}; ` +
          "redispatch is blocked",
      });
      await recordTerminalOutcome(index, "outcome_unknown", admittedHeld);
      iterationDurations[index] = Date.now() - iterStart;
      return undefined;
    }
    adoptResolved(index, resolution.evidence);
    completedHeld = { ...admittedHeld, economicsV2: { evidence: resolution.evidence } };
  }
  const collectedValue =
    contract.collect === undefined
      ? undefined
      : {
          status: "known" as const,
          value: collectIterationValue(
            iterationState,
            iterationPreviousResults,
            contract.collect.from
          ),
        };
  const aggregateBodyResults: Record<string, NodeResult> = {
    ...retainedBodyResults,
    [loopNode.id]: aggregateReceiptResult(
      loopNode.id,
      index,
      iterationState[contract.as],
      collectedValue,
      lastBodyResult!
    ),
  };
  // Persist the output receipt BEFORE settlement. If the process dies after
  // the host applies the charge but before the completed checkpoint, resume
  // reconciles this exact reservation and restores this receipt; it never
  // dispatches the item body to rebuild output.
  await checkpointAggregateReceipt({
    index,
    attempt,
    outcome: "running",
    held: completedHeld,
    bodyResults: aggregateBodyResults,
  });

  // F: exit 3 — the item completed. Reconcile actual spend against the
  // reservation, releasing the unspent delta. An overrun fails the loop
  // closed (operator decision, 08-16): the authored ceiling was breached.
  let settlement = await settleItem(completedHeld, retainedBodyResults);
  if (
    settlement !== undefined &&
    "costUnknown" in settlement
  ) {
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: lastBodyResult?.output ?? null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} usage/cost is unknown; ` +
        `settlement was not attempted: ${settlement.costUnknown}`,
    });
    await recordTerminalOutcome(
      index,
      "outcome_unknown",
      completedHeld
    );
    iterationDurations[index] = Date.now() - iterStart;
    return undefined;
  }
  // G2d (prereq 7): the settle call itself was unobservable. The item's work
  // is DONE and was charged, so this is not a release path — refunding could
  // return money the host already took. Only reconciliation can prove the
  // reservation's terminal state, and until it does the loop fails closed.
  // 24-G: narrowed on the marker key rather than on `typeof === "object"`,
  // because a clean settle now also returns an object. Matching on the shape
  // alone would route every successful settlement into reconciliation.
  if (
    settlement !== undefined &&
    "outcomeUnknown" in settlement
  ) {
    const resolution = await resolveUnknownSettlement(
      completedHeld as HeldItemReservation,
      settlement.actualCostCents,
      settlement.outcomeUnknown,
      settlement.evidence,
      settlement.evidenceV2
    );
    if (resolution.status === "blocked") {
      breachBudget();
      fail({
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: Date.now() - startTime,
        error: resolution.error,
      });
      await recordTerminalOutcome(
        index,
        "outcome_unknown",
        completedHeld
      );
      iterationDurations[index] = Date.now() - iterStart;
      return undefined;
    }
    settlement = {
      settledCostCents: resolution.settledCostCents,
      ...(resolution.evidence === undefined
        ? {}
        : { evidence: resolution.evidence }),
      ...(resolution.evidenceV2 === undefined
        ? {}
        : { evidenceV2: resolution.evidenceV2 }),
      ...(resolution.overrun === undefined
        ? {}
        : { overrun: resolution.overrun }),
    };
  }
  if (settlement !== undefined && "overrun" in settlement) {
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: lastBodyResult?.output ?? null,
      durationMs: Date.now() - startTime,
      error: settlement.overrun,
    });
    // 24-G: the item's body succeeded but it settled past its authored
    // ceiling, which fails the loop closed. It is `failed` rather than
    // `completed`: the work finished, but the item did not complete within
    // the terms it was admitted under, and reporting `completed` would let
    // accounting close over a breach.
    await recordTerminalOutcome(
      index,
      "failed",
      completedHeld === undefined
        ? undefined
        : {
            ...completedHeld,
            ...(settlement.evidence === undefined ? {} : { evidence: settlement.evidence }),
            ...(settlement.evidenceV2 === undefined ? {} : { economicsV2: { evidence: settlement.evidenceV2 } }),
          },
      settlement.settledCostCents
    );
    iterationDurations[index] = Date.now() - iterStart;
    return undefined;
  }

  const settledCostCents =
    settlement !== undefined && "settledCostCents" in settlement
      ? settlement.settledCostCents
      : undefined;
  const settledHeld: HeldItemReservation | undefined =
    completedHeld === undefined ||
    settlement === undefined ||
    !("settledCostCents" in settlement)
      ? completedHeld
      : {
          ...completedHeld,
          ...(settlement.evidence === undefined ? {} : { evidence: settlement.evidence }),
          ...(settlement.evidenceV2 === undefined ? {} : { economicsV2: { evidence: settlement.evidenceV2 } }),
        };
  // Persist completion and its exact output before publishing the terminal
  // accounting record. Either record can independently block redispatch;
  // the completed frame additionally restores single-body aggregation.
  await checkpointAggregateReceipt({
    index,
    attempt,
    outcome: "completed",
    held: settledHeld,
    ...(settledCostCents === undefined ? {} : { settledCostCents }),
    bodyResults: aggregateBodyResults,
  });

  // 24-G exit 3. The item completed and settled, so its economics is
  // terminal too — this is the only exit that records a settled cost.
  await recordTerminalOutcome(
    index,
    "completed",
    settledHeld,
    settledCostCents
  );

  return { collectedValue };
}
