/**
 * Deterministic reservation identity and evidence-derived cost for `for_each`
 * item budgets.
 *
 * Shared by the loop executor and the item budget lifecycle, which both need to
 * name a reservation the same way across a resume. Kept in its own leaf module
 * so neither imports the other.
 *
 * @module pipeline/loop-executor/for-each-reservation
 */

import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";

/**
 * F: a reservation held for one in-flight item, carried from the reserve at
 * the item's first body node to whichever of the three exits it reaches.
 */
export interface HeldItemReservation {
  readonly reservedCostCents: number;
  readonly itemIndex: number;
  readonly attempt: number;
  /** G2b: deterministic identity presented to settle/release. */
  readonly reservationId: string;
  /** Exact pre-dispatch or terminal execution/economics/effect evidence. */
  readonly evidence?: LoopEconomicsEvidenceV1;
}

/**
 * G2b: derive the deterministic reservation identity for one item attempt.
 *
 * The id must be stable across a resume so a replayed reserve is recognised as
 * the same reservation rather than double-charged, and it embeds the item index
 * and attempt so two in-flight items cannot collide.
 *
 * Exported for direct unit test: at `concurrency` 1 every observable difference
 * this function makes is also reachable end-to-end, but pinning the format here
 * keeps the wire contract falsifiable independently of the loop.
 */
export function deriveItemReservationId(params: {
  runId?: string;
  loopNodeId: string;
  itemIndex: number;
  attempt: number;
}): string {
  const run = params.runId === undefined ? "" : params.runId;
  const base = `resv:v1:${run}:item:${params.loopNodeId}:${params.itemIndex}`;
  return params.attempt > 0 ? `${base}:attempt:${params.attempt}` : base;
}

/**
 * Reserved cost implied by exact economics evidence, or `-1` when the evidence
 * is absent or any execution is not priced — an unpriced execution cannot prove
 * a reserved amount, and guessing one would understate the hold.
 */
export function reservedCostCentsFromEvidence(
  evidence: LoopEconomicsEvidenceV1 | undefined
): number {
  if (
    evidence === undefined ||
    evidence.executions.some(({ money }) => money.status !== "priced")
  ) {
    return -1;
  }
  let reservedMicros = 0;
  for (const { money } of evidence.executions) {
    if (money.status !== "priced") return -1;
    reservedMicros += money.reservation.reservedAmountMicros;
    if (!Number.isSafeInteger(reservedMicros)) return -1;
  }
  return Math.ceil(reservedMicros / 10_000);
}
