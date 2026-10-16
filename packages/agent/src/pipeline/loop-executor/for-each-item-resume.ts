/**
 * Resume-time item boundaries for the `for_each` loop executor, split out of
 * `for-each-loop.ts` (DZUPAGENT-CODE-H-11) with their logic unchanged:
 *
 * - `blockRetainedItem` validates an item's retained frame/outcome economics
 *   and restores or blocks an item that must never be redispatched;
 * - `settlePreparedCompletion` settles a durable body-complete aggregate
 *   receipt without dispatching the item body again.
 *
 * @module pipeline/loop-executor/for-each-item-resume
 */

import type { PipelineForEachItemOutcome } from "@dzupagent/core/pipeline";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import type { NodeResult } from "../pipeline-runtime-types.js";
import type {
  ForEachItemCheckpointProgress,
  ForEachItemTerminalOutcome,
  LoopBodyGraphCheckpointState,
} from "./types.js";
import { restoreForEachEconomicsV2Custody } from "./for-each-item-economics-v2.js";
import type {
  HeldItemEconomicsV2,
  HeldItemReservation,
} from "./for-each-reservation.js";
import { readAggregateReceipt } from "./for-each-aggregate-receipt.js";
import type { ForEachRunContext } from "./for-each-run-context.js";

/**
 * Returns `true` when the item is settled here — restored from its durable
 * receipt or blocked from redispatch — and `false` when it may run.
 */
export async function blockRetainedItem(
  run: ForEachRunContext,
  index: number,
  itemResume: ForEachItemCheckpointProgress | undefined,
  priorOutcome: ForEachItemTerminalOutcome | undefined
): Promise<boolean> {
  const { loopNode, bodyNodes, resume, startTime, itemBudgetCents, v2Mode, economicsV2, terminalOutcomes, breachBudget, fail, recordTerminalOutcome, restoreSettledItem, heldFrom } = run;
  const { validateRetainedItemEconomics } = run.lifecycle;
  const retainedCandidates = [
    itemResume?.economics === undefined
      ? undefined
      : {
          attempt: itemResume.attempt ?? 0,
          economics: itemResume.economics,
        },
    priorOutcome?.economics === undefined
      ? undefined
      : {
          attempt: priorOutcome.attempt ?? 0,
          economics: priorOutcome.economics,
        },
  ].filter((candidate) => candidate !== undefined);
  let retainedEconomicsError: string | undefined;
  if (
    itemBudgetCents !== undefined &&
    (resume?.budgetEvidenceMode === "required" || v2Mode) &&
    retainedCandidates.length === 0 &&
    ((itemResume?.nextBodyNodeIndex ?? 0) > 0 ||
      priorOutcome?.outcome === "completed")
  ) {
    retainedEconomicsError =
      "evidence-required resume state contains durable work without reservation economics";
  }
  for (const candidate of retainedCandidates) {
    retainedEconomicsError ??= validateRetainedItemEconomics(
      index,
      candidate.attempt,
      candidate.economics
    );
  }
  if (
    retainedEconomicsError === undefined &&
    retainedCandidates.length === 2
  ) {
    if (v2Mode) {
      // The terminal record is written after the last frame and may carry
      // later outcomes (releases, an unknown leaf); both must be the same
      // admission, and the later record is the custody of record.
      if (
        retainedCandidates[0]!.economics.evidenceV2?.admissionDigest !==
        retainedCandidates[1]!.economics.evidenceV2?.admissionDigest
      ) {
        retainedEconomicsError =
          "item frame and terminal outcome carry different V2 admissions";
      }
    } else {
      try {
        if (
          canonicalInputDigest(retainedCandidates[0]!.economics) !==
          canonicalInputDigest(retainedCandidates[1]!.economics)
        ) {
          retainedEconomicsError =
            "item frame and terminal outcome carry different economics evidence";
        }
      } catch {
        retainedEconomicsError =
          "retained economics evidence is not canonically serializable";
      }
    }
  }
  if (retainedEconomicsError !== undefined) {
    terminalOutcomes.add(index);
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} checkpoint exact economics ` +
        `evidence is invalid: ${retainedEconomicsError}; redispatch is blocked`,
    });
    return true;
  }
  if (
    priorOutcome?.outcome !== "completed" &&
    priorOutcome?.economics?.settledCostCents !== undefined
  ) {
    // A failed/cancelled/denied attempt that was nevertheless charged must
    // never become a retry candidate. The terminal set lacks a dedicated
    // "failed-but-charged" tag, so retain its exact economics and stop here.
    terminalOutcomes.add(index);
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} is terminal with a settled ` +
        `charge of ${priorOutcome.economics.settledCostCents} cents; ` +
        "redispatch is blocked",
    });
    return true;
  }
  // DSL-V2-HOST-BRIDGE-20260918 (§3.4 row 3): a V2 unit blocked on an
  // unknown leaf may re-present exactly that leaf — the frame's dispatch
  // intent — to the host under the same key. Anything else stays blocked.
  const v2ResumableUnknown = (): boolean => {
    const economics = priorOutcome?.economics;
    const frame = itemResume?.graph?.frame as LoopBodyGraphCheckpointState | undefined;
    if (economicsV2 === undefined || economics?.evidenceV2 === undefined || frame === undefined) return false;
    const custody = restoreForEachEconomicsV2Custody(economicsV2.inventory, {
      evidenceV2: economics.evidenceV2,
      ...(economics.leafOutcomesV2 === undefined ? {} : { leafOutcomesV2: economics.leafOutcomesV2 }),
    });
    const unknown = custody.unknownNodeIds();
    return unknown.length > 0 && unknown.every((nodeId) => nodeId === frame.nextNodeId);
  };
  if (
    priorOutcome?.outcome === "outcome_unknown" &&
    itemResume?.nextBodyNodeIndex !== bodyNodes.length &&
    !v2ResumableUnknown()
  ) {
    // Without a body-complete receipt the checkpoint does not retain which
    // lifecycle boundary became unobservable. Re-dispatching would guess
    // that an earlier reserve/release left no live money, so keep the item
    // blocked for operator reconciliation. Body-complete settle recovery is
    // the one distinguishable case and continues below.
    terminalOutcomes.add(index);
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} has a durable outcome-unknown ` +
        "reservation without a body-complete receipt; redispatch is blocked",
    });
    return true;
  }
  const frameCompleted = itemResume?.outcome === "completed";
  if (priorOutcome?.outcome === "completed" || frameCompleted) {
    terminalOutcomes.add(index);
    if (frameCompleted && priorOutcome?.outcome !== "completed") {
      const economics = itemResume.economics;
      const held =
        economics === undefined
          ? undefined
          : heldFrom(index, itemResume.attempt ?? 0, economics);
      await recordTerminalOutcome(
        index,
        "completed",
        held,
        economics?.settledCostCents
      );
    }
    if (await restoreSettledItem(index)) return true;
    // A completed item is never a redispatch candidate. A checkpoint written
    // before aggregate receipts existed may be unreconstructible (notably a
    // single-body collect-from-state item); fail closed rather than repeat
    // its effects or charge it again.
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} is durably completed but its ` +
        "aggregate/output receipt is missing or corrupt; redispatch is blocked",
    });
    return true;
  }
  return false;
}

/**
 * Settle an item whose durable frame already carries its body-complete
 * aggregate receipt. Every path records a terminal outcome or restores the
 * item; none dispatches the body.
 */
export async function settlePreparedCompletion(
  run: ForEachRunContext,
  input: {
    index: number;
    itemResume: ForEachItemCheckpointProgress | undefined;
    startBodyNodeIndex: number;
    resumedAttempt: number;
    retainedBodyResults: Record<string, NodeResult>;
    iterStart: number;
  }
): Promise<void> {
  const { index, itemResume, startBodyNodeIndex, resumedAttempt, retainedBodyResults, iterStart } = input;
  const { loopNode, bodyNodes, contract, items, startTime, itemBudgetCents, v2Mode, iterationDurations, breachBudget, fail, recordTerminalOutcome, checkpointAggregateReceipt, restoreSettledItem, heldFrom, restoreCustody, adoptResolved } = run;
  const { reconcileUnknownReservation, settleItem, readReconciledSettledCost, resolveUnknownSettlement } = run.lifecycle;
  const preparedReceipt = readAggregateReceipt(
    loopNode.id,
    index,
    itemResume?.graph === undefined ? items[index] : itemResume.graph.state[contract.as],
    itemResume?.bodyResults
  );
  const blockPreparedCompletion = async (
    reason: string,
    outcome: PipelineForEachItemOutcome = "outcome_unknown",
    settledCostCents?: number,
    terminalEvidence?: LoopEconomicsEvidenceV1
  ): Promise<void> => {
    breachBudget();
    fail({
      nodeId: loopNode.id,
      output: preparedReceipt?.finalBodyResult?.output.value ?? null,
      durationMs: Date.now() - startTime,
      error:
        `Loop "${loopNode.id}" item ${index} has completed body work that ` +
        `cannot be settled safely: ${reason}; redispatch is blocked`,
    });
    const economics = itemResume?.economics;
    await recordTerminalOutcome(
      index,
      outcome,
      economics === undefined
        ? undefined
        : {
            ...heldFrom(index, resumedAttempt, economics),
            ...(terminalEvidence === undefined
              ? {}
              : { evidence: terminalEvidence }),
          },
      settledCostCents ?? economics?.settledCostCents
    );
    iterationDurations[index] = Date.now() - iterStart;
  };

  if (
    startBodyNodeIndex !== bodyNodes.length ||
    preparedReceipt === undefined
  ) {
    await blockPreparedCompletion(
      "its aggregate/output receipt is missing, corrupt, or has an invalid body cursor"
    );
    return;
  }

  const receiptBodyResults = Object.fromEntries(
    Object.entries(retainedBodyResults).filter(
      ([nodeId]) => nodeId !== loopNode.id
    )
  );
  const economics = itemResume?.economics;
  if (economics === undefined) {
    if (itemBudgetCents !== undefined) {
      await blockPreparedCompletion(
        "the strict ceiling receipt has no reservation economics"
      );
      return;
    }
    await checkpointAggregateReceipt({
      index,
      attempt: resumedAttempt,
      outcome: "completed",
      held: undefined,
      bodyResults: retainedBodyResults,
    });
    await recordTerminalOutcome(index, "completed", undefined);
    if (!(await restoreSettledItem(index, { ...itemResume!, outcome: "completed" }))) {
      await blockPreparedCompletion("its durable aggregate could not be restored");
    }
    return;
  }

  let resumedHeld: HeldItemReservation = heldFrom(index, resumedAttempt, economics);
  if (v2Mode) {
    // The body-complete receipt must carry a custody that its own frame
    // agrees with and that every leaf has resolved; only then is there a
    // settled record to charge against.
    const custody = restoreCustody(index, economics);
    const frame = itemResume?.graph?.frame as LoopBodyGraphCheckpointState | undefined;
    const custodyError = custody === undefined
      ? "the body-complete receipt carries no V2 record"
      : frame === undefined
        ? "the body-complete receipt carries no graph frame"
        : custody.applyFrame(frame);
    if (custodyError !== undefined) {
      await blockPreparedCompletion(`its V2 leaf custody is inconsistent: ${custodyError}`);
      return;
    }
    const resolution = custody!.resolve();
    if (resolution.status !== "settled") {
      await blockPreparedCompletion(
        `its V2 leaf accounting is unresolved: ${resolution.status === "pending" ? resolution.error : "a leaf outcome is unknown"}`
      );
      return;
    }
    adoptResolved(index, resolution.evidence);
    resumedHeld = { ...resumedHeld, economicsV2: { evidence: resolution.evidence } };
  }
  const reconciliation = await reconcileUnknownReservation(
    index,
    resumedAttempt,
    "resume of a durable body-complete aggregate receipt",
    "settle",
    resumedHeld
  );

  let settledCostCents: number | undefined;
  let settledEvidence: LoopEconomicsEvidenceV1 | undefined;
  let settledEvidenceV2: HeldItemEconomicsV2["evidence"] | undefined;
  let settlementOverrun: string | undefined;
  if (reconciliation.status === "settled") {
    const settled = readReconciledSettledCost(reconciliation, "settle");
    if ("error" in settled) {
      await blockPreparedCompletion(settled.error);
      return;
    }
    settledCostCents = settled.settledCostCents;
    settledEvidence = settled.evidence;
    settledEvidenceV2 = settled.evidenceV2;
  } else if (reconciliation.status === "reserved") {
    if (
      !Number.isSafeInteger(reconciliation.reservedCostCents) ||
      reconciliation.reservedCostCents !== economics.reservedCostCents
    ) {
      await blockPreparedCompletion(
        "reconciliation disagreed with the durable reservation amount"
      );
      return;
    }
    if (reconciliation.evidence !== undefined) {
      resumedHeld = { ...resumedHeld, evidence: reconciliation.evidence };
    }
    const settlement = await settleItem(resumedHeld, receiptBodyResults);
    if (settlement !== undefined && "settledCostCents" in settlement) {
      settledCostCents = settlement.settledCostCents;
      settledEvidence = settlement.evidence;
      settledEvidenceV2 = settlement.evidenceV2;
      settlementOverrun = settlement.overrun;
    } else if (settlement !== undefined && "outcomeUnknown" in settlement) {
      const resolved = await resolveUnknownSettlement(
        resumedHeld,
        settlement.actualCostCents,
        settlement.outcomeUnknown,
        settlement.evidence,
        settlement.evidenceV2
      );
      if (resolved.status === "blocked") {
        await blockPreparedCompletion(resolved.error);
        return;
      }
      settledCostCents = resolved.settledCostCents;
      settledEvidence = resolved.evidence;
      settledEvidenceV2 = resolved.evidenceV2;
      settlementOverrun = resolved.overrun;
    } else {
      const detail =
        settlement !== undefined && "costUnknown" in settlement
          ? settlement.costUnknown
          : "settlement produced no authoritative receipt";
      await blockPreparedCompletion(detail);
      return;
    }
  } else {
    const detail =
      reconciliation.status === "blocked"
        ? reconciliation.error
        : `reconciliation returned ${reconciliation.status}; ` +
          "completed work is not authoritatively charged";
    await blockPreparedCompletion(detail);
    return;
  }

  if (settledCostCents === undefined) {
    await blockPreparedCompletion(
      "settlement produced no authoritative known cost"
    );
    return;
  }
  if (
    settlementOverrun !== undefined ||
    settledCostCents > economics.reservedCostCents
  ) {
    await blockPreparedCompletion(
      settlementOverrun ??
        `settled ${settledCostCents} cents against a ${economics.reservedCostCents}-cent reservation`,
      "failed",
      settledCostCents,
      settledEvidence
    );
    return;
  }
  const settledHeld: HeldItemReservation = {
    ...resumedHeld,
    ...(settledEvidence === undefined ? {} : { evidence: settledEvidence }),
    ...(settledEvidenceV2 === undefined ? {} : { economicsV2: { evidence: settledEvidenceV2 } }),
  };
  await checkpointAggregateReceipt({
    index,
    attempt: resumedAttempt,
    outcome: "completed",
    held: settledHeld,
    settledCostCents,
    bodyResults: retainedBodyResults,
  });
  await recordTerminalOutcome(
    index,
    "completed",
    settledHeld,
    settledCostCents
  );
  if (!(await restoreSettledItem(index, { ...itemResume!, outcome: "completed" }))) {
    await blockPreparedCompletion("its durable aggregate could not be restored");
  }
}
