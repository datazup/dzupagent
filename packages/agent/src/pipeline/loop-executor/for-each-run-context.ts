/**
 * Shared per-run context for the `for_each` loop executor and the item
 * boundary helpers split out of `for-each-loop.ts` (DZUPAGENT-CODE-H-11).
 *
 * The context exposes exactly the values and closures the helpers previously
 * captured from `executeForEachLoop`; the loop's mutable aggregation state
 * (ordered-prefix merge, results, flush queue) stays in the executor.
 *
 * @module pipeline/loop-executor/for-each-run-context
 */

import type {
  PipelineForEachItemEconomics,
  PipelineForEachItemOutcome,
} from "@dzupagent/core/pipeline";
import type { LoopNode, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { NodeResult } from "../pipeline-runtime-types.js";
import type { ForEachItemCheckpointProgress, LoopResumeOptions } from "./types.js";
import type { ForEachEconomicsV2Preparation } from "./budget-types.js";
import {
  type ForEachItemEconomicsV2Custody,
  restoreForEachEconomicsV2Custody,
} from "./for-each-item-economics-v2.js";
import type { createItemBudgetLifecycle } from "./for-each-item-budget.js";
import type {
  HeldItemEconomicsV2,
  HeldItemReservation,
} from "./for-each-reservation.js";
import type { ForEachContract } from "./for-each-aggregate-receipt.js";

export type ForEachItemBudgetLifecycle = ReturnType<typeof createItemBudgetLifecycle>;

/** Per-item V2 custody and the economics records derived from it. */
export function createForEachItemCustody(
  economicsV2: ForEachEconomicsV2Preparation | undefined
) {
  // DSL-V2-HOST-BRIDGE-20260918: per-item V2 custody (selections and leaf
  // outcomes), keyed by item index. Its snapshot rides in every economics
  // record the loop writes, so it is durable exactly when the frame is.
  const custodies = new Map<number, ForEachItemEconomicsV2Custody>();
  const economicsV2Of = (
    held: HeldItemReservation | undefined,
    index: number
  ): HeldItemEconomicsV2 | undefined => {
    if (
      held?.economicsV2 !== undefined &&
      held.economicsV2.evidence.resolution.status !== "pending"
    ) {
      return held.economicsV2;
    }
    const custody = custodies.get(index);
    if (custody === undefined) return held?.economicsV2;
    const snapshot = custody.snapshot();
    return {
      evidence: snapshot.evidence,
      ...(snapshot.leafOutcomes === undefined ? {} : { leafOutcomes: snapshot.leafOutcomes }),
    };
  };
  const itemEconomics = (
    held: HeldItemReservation,
    index: number,
    settledCostCents?: number
  ): PipelineForEachItemEconomics => {
    const v2 = economicsV2Of(held, index);
    return {
      reservationId: held.reservationId,
      reservedCostCents: held.reservedCostCents,
      ...(settledCostCents === undefined ? {} : { settledCostCents }),
      ...(held.evidence === undefined ? {} : { evidence: held.evidence }),
      ...(v2 === undefined ? {} : { evidenceV2: v2.evidence }),
      ...(v2?.leafOutcomes === undefined ? {} : { leafOutcomesV2: [...v2.leafOutcomes] }),
    };
  };
  const heldFrom = (
    index: number,
    attempt: number,
    economics: PipelineForEachItemEconomics
  ): HeldItemReservation => ({
    itemIndex: index,
    attempt,
    reservationId: economics.reservationId,
    reservedCostCents: economics.reservedCostCents,
    ...(economics.evidence === undefined ? {} : { evidence: economics.evidence }),
    ...(economics.evidenceV2 === undefined
      ? {}
      : {
          economicsV2: {
            evidence: economics.evidenceV2,
            ...(economics.leafOutcomesV2 === undefined ? {} : { leafOutcomes: economics.leafOutcomesV2 }),
          },
        }),
  });
  const restoreCustody = (
    index: number,
    economics: PipelineForEachItemEconomics
  ): ForEachItemEconomicsV2Custody | undefined => {
    if (economicsV2 === undefined || economics.evidenceV2 === undefined) return undefined;
    const custody = restoreForEachEconomicsV2Custody(economicsV2.inventory, {
      evidenceV2: economics.evidenceV2,
      ...(economics.leafOutcomesV2 === undefined ? {} : { leafOutcomesV2: economics.leafOutcomesV2 }),
    });
    custodies.set(index, custody);
    return custody;
  };
  const adoptResolved = (index: number, evidence: HeldItemEconomicsV2["evidence"]): void => {
    if (economicsV2 === undefined) return;
    custodies.set(index, restoreForEachEconomicsV2Custody(economicsV2.inventory, { evidenceV2: evidence }));
  };
  return { custodies, itemEconomics, heldFrom, restoreCustody, adoptResolved };
}

export type ForEachItemCustody = ReturnType<typeof createForEachItemCustody>;

export type ForEachRunContext = ForEachItemCustody & {
  readonly loopNode: LoopNode;
  readonly bodyNodes: PipelineNode[];
  readonly contract: ForEachContract;
  readonly items: unknown[];
  readonly resume: LoopResumeOptions | undefined;
  readonly startTime: number;
  readonly itemBudgetCents: number | undefined;
  readonly v2Mode: boolean;
  readonly economicsV2: ForEachEconomicsV2Preparation | undefined;
  readonly lifecycle: ForEachItemBudgetLifecycle;
  readonly iterationDurations: number[];
  readonly terminalOutcomes: Set<number>;
  /** Record a stopping budget breach and halt dispatch. */
  breachBudget(): void;
  /** Record the loop's first error; a later error never replaces it. */
  fail(error: NodeResult): void;
  /** Replace the loop's error with a strictly more severe fact. */
  failOverride(error: NodeResult): void;
  recordTerminalOutcome(
    index: number,
    outcome: PipelineForEachItemOutcome,
    held: HeldItemReservation | undefined,
    settledCostCents?: number,
    attemptedWithoutHold?: number
  ): Promise<void>;
  checkpointAggregateReceipt(input: {
    index: number;
    attempt: number;
    outcome: "running" | "completed";
    held: HeldItemReservation | undefined;
    settledCostCents?: number;
    bodyResults: Readonly<Record<string, NodeResult>>;
  }): Promise<void>;
  restoreSettledItem(
    index: number,
    frame?: ForEachItemCheckpointProgress
  ): Promise<boolean>;
};
