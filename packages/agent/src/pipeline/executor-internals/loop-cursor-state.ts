/**
 * Loop cursor state — the pure helpers that read, retire, validate and roll
 * back a loop's durable `loopState` entry. Extracted from `stage-dispatch.ts`
 * (DZUPAGENT-CODE-H-11) without behavior change; `stage-dispatch.ts`
 * re-exports the public members so existing importers resolve unchanged.
 *
 * @module pipeline/executor-internals/loop-cursor-state
 */

import type { NodeResult } from "../pipeline-runtime-types.js";
import type { LoopState } from "./executor-state-types.js";
import type { PipelineForEachItemFrame } from "@dzupagent/core/pipeline";
import { isTerminalItemOutcome } from "@dzupagent/core/pipeline";
import type { RunFrame } from "./run-frame.js";

/**
 * Roll a loop's in-memory entry back to what the store still holds, after a
 * checkpoint commit was lost to a compare-and-set conflict (G2a).
 *
 * Exported for direct testing: the run aborts immediately after a lost
 * item-boundary commit and writes no further checkpoint, so this rollback has
 * no *end-to-end* observation point — a mutant deleting it survives every
 * suite.
 *
 * 24-I RESOLVED THIS AS UNPAYABLE, not as pending. The pre-24-I text said the
 * debt would come due once a lost commit could be followed by another write
 * against the same frame, and expected the N>1 admission to supply it. It does
 * not: each caller (`loop-stage-checkpoints.ts`) THROWS
 * `PipelineCheckpointCommitConflictError` on the line after this call, the
 * throw propagates out of the worker and aborts the
 * run, and nothing writes against the frame again — at any concurrency.
 * Failing closed is precisely what prevents the second write. A mutant
 * deleting the call was confirmed to survive a real concurrent-run test
 * (`pipeline-for-each-lost-commit-rollback-e2e.test.ts`, which records the
 * finding). Unlike the G1 mid-item merge, which N>1 genuinely did make
 * killable, this one is subsumed by the throw on every reachable path.
 *
 * Its unit tests here are therefore the honest and final coverage. Do not
 * re-attempt an end-to-end test for it.
 *
 * Correctness still matters today: leaving the retired-frame/advanced-cursor
 * entry in memory would mean any future caller that persists this frame writes
 * a cursor no durable record backs.
 */
export function restoreLoopStateAfterLostCommit(
  loopState: LoopState,
  loopNodeId: string,
  previous: LoopState[string] | undefined,
): void {
  // `delete` rather than assigning `undefined`: the first boundary of a loop
  // has no prior entry, and `LoopState` holds no undefined values.
  if (previous === undefined) {
    delete loopState[loopNodeId];
    return;
  }
  loopState[loopNodeId] = previous;
}

export function retainBodyGraphState(
  frame: RunFrame,
  loopNodeId: string,
  completedIterations: number,
  state: NonNullable<LoopState[string]["bodyGraphState"]>,
): void {
  const previousBoundary = frame.loopState[loopNodeId];
  frame.loopState[loopNodeId] = {
    iteration: completedIterations,
    bodyGraphState: state,
    ...(previousBoundary?.previousOutput !== undefined
      ? { previousOutput: previousBoundary.previousOutput }
      : {}),
    ...(previousBoundary?.progressDigest !== undefined
      ? { progressDigest: previousBoundary.progressDigest }
      : {}),
    ...(previousBoundary?.iterationEconomics === undefined
      ? {}
      : {
          iterationOutcome:
            previousBoundary.iterationEconomics.settledCostCents === undefined
              ? ("running" as const)
              : (previousBoundary.iterationOutcome ?? "completed"),
          iterationEconomics: previousBoundary.iterationEconomics,
        }),
  };
}

export function clearCommittedLoopInteractionCursor(
  frame: RunFrame,
  loopNodeId: string,
  state?: NonNullable<LoopState[string]["bodyGraphState"]>,
  errorTarget?: (nodeId: string, error: string) => string | undefined,
): void {
  const cursor = frame.interactionResumeCursor;
  if (cursor?.scope.kind !== "loop" || cursor.scope.loopNodeId !== loopNodeId) {
    return;
  }
  const selected = cursor.selectedSuccessorNodeId;
  const selectedResult =
    selected === undefined ? undefined : state?.nodeResults[selected];
  const selectedErrorTarget =
    selected !== undefined && selectedResult?.error !== undefined
      ? errorTarget?.(selected, selectedResult.error)
      : undefined;
  const selectedCommitted =
    selected === undefined
      ? state === undefined ||
        (state.completed &&
          state.outcome?.kind === "normal" &&
          state.outcome.exitNodeId === cursor.nodeId)
      : state === undefined ||
        state.completedNodeIds.includes(selected) ||
        (selectedResult?.error !== undefined &&
          selectedErrorTarget !== undefined &&
          state.nextNodeId === selectedErrorTarget);
  if (selectedCommitted) delete frame.interactionResumeCursor;
}

export function loopBodyResultsForCheckpoint(
  results: Readonly<Record<string, NodeResult>>,
  includeProviderSessionRefs: boolean,
): Record<string, NodeResult> {
  return Object.fromEntries(
    Object.entries(results).map(([nodeId, result]) => [
      nodeId,
      {
        nodeId: result.nodeId,
        output: result.output,
        durationMs: result.durationMs,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.errorMetadata !== undefined
          ? { errorMetadata: result.errorMetadata }
          : {}),
        ...(includeProviderSessionRefs &&
        result.providerSessionRefs !== undefined
          ? { providerSessionRefs: result.providerSessionRefs }
          : {}),
      },
    ]),
  );
}

/**
 * Reject a `for_each` cursor the resolved source cannot support (E3 defect 2).
 *
 * Doc 27 §8 proof 5 requires cursor corruption to be rejected *before* any item
 * is dispatched. Three ways a durable cursor can disagree with its source:
 *
 * - the ordered prefix (`iteration`) exceeds the item count, so the checkpoint
 *   claims more items finished than exist;
 * - an in-flight frame is filed at an index outside the source;
 * - a frame's self-reported `itemIndex` disagrees with the key it is filed
 *   under. `readItemFrames` keys a pre-G1 singular frame *by its own*
 *   `itemIndex`, so the two are assumed equal downstream; a disagreement would
 *   resume the wrong item's body cursor. Note `PipelineCheckpointSchema`
 *   already rejects this earlier on the `resume` path, so this branch is
 *   defence-in-depth for callers that reach the executor without that parse.
 *
 * Fail closed rather than clamp: a stranded run is operator-recoverable, but a
 * clamped cursor silently skips or re-runs committed item bodies. A negative or
 * fractional `iteration` is rejected by the checkpoint schema on the
 * serializing path; this guard covers the in-memory path too by treating any
 * non-integer prefix as corrupt.
 */
export function assertForEachCursorWithinSource(
  loopNodeId: string,
  runId: string,
  cursor: LoopState[string] | undefined,
  itemCount: number,
): void {
  if (cursor === undefined) return;

  const iteration = cursor.iteration ?? 0;
  if (!Number.isInteger(iteration) || iteration < 0 || iteration > itemCount) {
    throw new PipelineForEachCursorCorruptError(
      `Cannot resume loop "${loopNodeId}" in run "${runId}": its checkpoint ` +
        `retains a completed prefix of ${iteration} item(s), but the source ` +
        `resolves to ${itemCount}. The cursor does not describe this source.`,
    );
  }

  const itemFrames = readItemFrames(cursor);
  if (itemFrames === undefined) return;
  for (const [key, itemFrame] of Object.entries(itemFrames)) {
    const keyedIndex = Number(key);
    if (itemFrame.itemIndex !== keyedIndex) {
      throw new PipelineForEachCursorCorruptError(
        `Cannot resume loop "${loopNodeId}" in run "${runId}": an in-flight ` +
          `item frame is filed at index ${key} but reports item index ` +
          `${itemFrame.itemIndex}. Resuming would restore one item's body ` +
          "cursor onto another item.",
      );
    }
    if (keyedIndex < 0 || keyedIndex >= itemCount) {
      throw new PipelineForEachCursorCorruptError(
        `Cannot resume loop "${loopNodeId}" in run "${runId}": an in-flight ` +
          `item frame names index ${key}, which is outside the ${itemCount} ` +
          "item(s) the source resolves to.",
      );
    }
    assertItemFrameOutcomeCoherent(loopNodeId, runId, itemFrame);
  }
}

/**
 * Reject a frame whose durable outcome and economics contradict each other
 * (24-F, doc 27 §8 proof 5's outcome and economics sub-parts).
 *
 * The checkpoint schema already enforces every fact that is checkable on ONE
 * field: the outcome vocabulary is closed, and costs are non-negative
 * integers. What it cannot express is agreement *between* fields, which is
 * where item corruption actually shows up — money that disagrees with the
 * lifecycle state it is filed under, or with the item that opened it.
 *
 * Fail closed for the same reason the cursor guard does: a stranded run is
 * operator-recoverable, whereas resuming an item whose economics are already
 * self-contradictory settles committed work against the wrong ledger row and
 * cannot be undone.
 *
 * Absence is UNPROVABLE, never agreement. A pre-24-F frame carries no outcome
 * and no economics, and an unpriced host records a terminal outcome with no
 * economics at all; both resume untouched. Only a frame that positively states
 * two facts which cannot both hold is refused.
 */
function assertItemFrameOutcomeCoherent(
  loopNodeId: string,
  runId: string,
  itemFrame: PipelineForEachItemFrame,
): void {
  const { economics, outcome, itemIndex } = itemFrame;
  if (economics === undefined) return;

  // A settled amount is what a TERMINAL item produces. Carrying one under a
  // non-terminal outcome means the ledger closed this item's spend while the
  // frame still invites a re-dispatch — resuming would charge it twice.
  if (
    economics.settledCostCents !== undefined &&
    outcome !== undefined &&
    !isTerminalItemOutcome(outcome)
  ) {
    throw new PipelineForEachCursorCorruptError(
      `Cannot resume loop "${loopNodeId}" in run "${runId}": item ` +
        `${itemIndex} records a settled cost of ` +
        `${economics.settledCostCents} cent(s) while its outcome is ` +
        `"${outcome}", which is not terminal. A settled item cannot still be ` +
        "awaiting dispatch.",
    );
  }

  // Settling above the reservation is the breach `settleItem` fails the live
  // loop closed on. A checkpoint that already records one must not be resumed
  // back into the run as though the ceiling held.
  if (
    economics.settledCostCents !== undefined &&
    economics.settledCostCents > economics.reservedCostCents
  ) {
    throw new PipelineForEachCursorCorruptError(
      `Cannot resume loop "${loopNodeId}" in run "${runId}": item ` +
        `${itemIndex} settled ${economics.settledCostCents} cent(s) against ` +
        `a ${economics.reservedCostCents}-cent reservation, exceeding the ` +
        "ceiling authored for it.",
    );
  }

  // `deriveItemReservationId` embeds the item index, so the id is checkable
  // against the frame holding it. A mismatch proves a frame and a ledger row
  // have been crossed — the money belongs to a different item.
  //
  // Checked by SUFFIX rather than by re-deriving the whole id: the derivation
  // also folds in the run id and attempt, and a resume must not reject a frame
  // merely because it cannot reproduce those inputs. This tests the one
  // segment the frame itself is authoritative about.
  const indexSegment = `:item:${loopNodeId}:${itemIndex}`;
  if (
    economics.reservationId.includes(`:item:${loopNodeId}:`) &&
    !economics.reservationId.endsWith(indexSegment) &&
    !economics.reservationId.includes(`${indexSegment}:attempt:`)
  ) {
    throw new PipelineForEachCursorCorruptError(
      `Cannot resume loop "${loopNodeId}" in run "${runId}": item ` +
        `${itemIndex} holds reservation "${economics.reservationId}", which ` +
        "was minted for a different item. Resuming would settle this item's " +
        "work against another item's reservation.",
    );
  }
}

/** A resume was rejected because its `for_each` cursor cannot describe the source. */
export class PipelineForEachCursorCorruptError extends Error {
  override readonly name = "PipelineForEachCursorCorruptError";
}

/**
 * Read a loop cursor's in-flight for-each frames in the keyed G1 shape.
 *
 * Accepts either spelling so a checkpoint written before G1 still resumes: a
 * singular `itemFrame` is normalised to a one-entry map keyed by its own
 * `itemIndex`. Returns `undefined` when the loop sits on an item boundary, so
 * iteration-only checkpoints stay byte-identical rather than gaining an empty
 * record. The schema rejects a checkpoint carrying both spellings, so
 * preferring `itemFrames` here cannot silently discard a live frame.
 */
export function readItemFrames(
  cursor: LoopState[string] | undefined,
): Record<string, PipelineForEachItemFrame> | undefined {
  if (cursor?.itemFrames !== undefined) {
    return Object.keys(cursor.itemFrames).length === 0
      ? undefined
      : cursor.itemFrames;
  }
  if (cursor?.itemFrame !== undefined) {
    return { [String(cursor.itemFrame.itemIndex)]: cursor.itemFrame };
  }
  return undefined;
}

/**
 * Drop the frames the ordered prefix has absorbed, keeping those still live.
 *
 * `completedIterations` is the ordered prefix: every item indexed below it is
 * fully complete, so its frame would resume into finished work. Frames at or
 * above it belong to items still in flight and must survive another item's
 * flush. Returns `undefined` when nothing remains, keeping an item-boundary
 * cursor free of an empty record.
 */
export function retainInFlightItemFrames(
  itemFrames: Record<string, PipelineForEachItemFrame> | undefined,
  completedIterations: number,
): Record<string, PipelineForEachItemFrame> | undefined {
  if (itemFrames === undefined) return undefined;
  const retained = Object.fromEntries(
    Object.entries(itemFrames).filter(
      ([, itemFrame]) => itemFrame.itemIndex >= completedIterations,
    ),
  );
  return Object.keys(retained).length === 0 ? undefined : retained;
}