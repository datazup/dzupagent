/**
 * Loop stage checkpoint callbacks — the durable-resume writers the loop
 * executor invokes at body-node, budget, body-graph, item and iteration
 * boundaries. Extracted verbatim from `dispatchLoopStage` in
 * `stage-dispatch.ts` (DZUPAGENT-CODE-H-11): same loop-state rebuilds, same
 * checkpoint boundaries, same lost-commit rollback-and-throw on each path.
 *
 * @module pipeline/executor-internals/loop-stage-checkpoints
 */

import type { LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { digestPipelineInteractionValue } from "@dzupagent/runtime-contracts";
import type { LoopResumeOptions } from "../loop-executor.js";
import {
  persistCheckpointWithIntegrityBoundary,
  PipelineCheckpointCommitConflictError,
} from "../pipeline-shared/checkpoint-integrity-error.js";
import { lastWriteLostCommit } from "./checkpoint-writer.js";
import { resolveStatePath } from "../loop-executor/state-path.js";
import {
  clearCommittedLoopInteractionCursor,
  loopBodyResultsForCheckpoint,
  readItemFrames,
  restoreLoopStateAfterLostCommit,
  retainBodyGraphState,
  retainInFlightItemFrames,
} from "./loop-cursor-state.js";
import type { RunFrame } from "./run-frame.js";
import type { StageContext } from "./stage-dispatch.js";

/** The checkpoint callbacks `dispatchLoopStage` hands to the loop executor. */
export type LoopCheckpointCallbacks = Required<
  Pick<
    LoopResumeOptions,
    | "onBodyNodeComplete"
    | "onIterationBudgetCheckpoint"
    | "onBodyGraphCheckpoint"
    | "onItemBodyNodeComplete"
    | "onItemTerminalOutcome"
    | "onIterationComplete"
  >
>;

/** Build the full callback set for one loop node, bound to its run frame. */
export function createLoopCheckpointCallbacks(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): LoopCheckpointCallbacks {
  return {
    onBodyNodeComplete: bodyNodeCompleteCheckpoint(ctx, loopNode, frame),
    onIterationBudgetCheckpoint: iterationBudgetCheckpoint(ctx, loopNode, frame),
    onBodyGraphCheckpoint: bodyGraphCheckpoint(ctx, loopNode, frame),
    onItemBodyNodeComplete: itemBodyNodeCompleteCheckpoint(ctx, loopNode, frame),
    onItemTerminalOutcome: itemTerminalOutcomeCheckpoint(ctx, loopNode, frame),
    onIterationComplete: iterationCompleteCheckpoint(ctx, loopNode, frame),
  };
}

function bodyNodeCompleteCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onBodyNodeComplete"]> {
  return async (progress) => {
    const previousBoundary = frame.loopState[loopNode.id];
    frame.loopState[loopNode.id] = {
      iteration: progress.completedIterations,
      nextBodyNodeIndex: progress.nextBodyNodeIndex,
      bodyResults: loopBodyResultsForCheckpoint(
        progress.bodyResults,
        ctx.config.definition.checkpoint?.includeProviderSessionRefs === true,
      ),
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
              previousBoundary.iterationEconomics.settledCostCents ===
              undefined
                ? ("running" as const)
                : (previousBoundary.iterationOutcome ?? "completed"),
            iterationEconomics: previousBoundary.iterationEconomics,
          }),
    };
    await persistCheckpointWithIntegrityBoundary({
      nodeId: loopNode.id,
      boundary: "loop_resume_cursor",
      save: () => ctx.saveCheckpoint(frame),
    });
    if (lastWriteLostCommit(frame.versionTracker)) {
      restoreLoopStateAfterLostCommit(
        frame.loopState,
        loopNode.id,
        previousBoundary,
      );
      throw new PipelineCheckpointCommitConflictError(loopNode.id, {
        completedIterations: progress.completedIterations,
        observedVersion: frame.versionTracker.version,
      });
    }
  };
}

function iterationBudgetCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onIterationBudgetCheckpoint"]> {
  return async (progress) => {
    const previousBoundary = frame.loopState[loopNode.id];
    frame.loopState[loopNode.id] = {
      iteration: progress.completedIterations,
      ...(previousBoundary?.nextBodyNodeIndex === undefined
        ? {}
        : { nextBodyNodeIndex: previousBoundary.nextBodyNodeIndex }),
      ...(previousBoundary?.bodyResults === undefined
        ? {}
        : { bodyResults: previousBoundary.bodyResults }),
      ...(previousBoundary?.bodyGraphState === undefined
        ? {}
        : { bodyGraphState: previousBoundary.bodyGraphState }),
      ...(previousBoundary?.previousOutput === undefined
        ? {}
        : { previousOutput: previousBoundary.previousOutput }),
      ...(previousBoundary?.progressDigest === undefined
        ? {}
        : { progressDigest: previousBoundary.progressDigest }),
      iterationOutcome: progress.outcome,
      iterationEconomics: progress.economics,
    };
    await persistCheckpointWithIntegrityBoundary({
      nodeId: loopNode.id,
      boundary: "loop_resume_cursor",
      save: () => ctx.saveCheckpoint(frame),
    });
    if (lastWriteLostCommit(frame.versionTracker)) {
      restoreLoopStateAfterLostCommit(
        frame.loopState,
        loopNode.id,
        previousBoundary,
      );
      throw new PipelineCheckpointCommitConflictError(loopNode.id, {
        completedIterations: progress.completedIterations,
        observedVersion: frame.versionTracker.version,
      });
    }
  };
}

function bodyGraphCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onBodyGraphCheckpoint"]> {
  return async (progress) => {
    retainBodyGraphState(
      frame,
      loopNode.id,
      progress.completedIterations,
      progress.state,
    );
    clearCommittedLoopInteractionCursor(
      frame,
      loopNode.id,
      progress.state,
      (nodeId, error) => ctx.errorEdgeFor(nodeId, error),
    );
    if (progress.mandatory === true) {
      await persistCheckpointWithIntegrityBoundary({
        nodeId: loopNode.id,
        boundary: "loop_resume_cursor",
        save: () => ctx.saveControlCheckpoint(frame),
      });
    } else {
      await ctx.saveCheckpoint(frame);
    }
  };
}

function itemBodyNodeCompleteCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onItemBodyNodeComplete"]> {
  return async (progress) => {
    const previousBoundary = frame.loopState[loopNode.id];
    let itemOutcomes = previousBoundary?.itemOutcomes;
    const priorOutcome = itemOutcomes?.[String(progress.itemIndex)];
    if (loopNode.bodyGraph !== undefined && progress.outcome === "running" &&
        (progress.attempt ?? 0) > (priorOutcome?.attempt ?? 0) &&
        (priorOutcome?.outcome === "failed" || priorOutcome?.outcome === "cancelled" || priorOutcome?.outcome === "denied") &&
        priorOutcome.economics?.settledCostCents === undefined) {
      // The graph retry has authoritatively reconciled the released attempt.
      // Replace its outcome atomically with the newly reserved graph frame;
      // retaining both would make a crash restore contradictory economics.
      itemOutcomes = { ...itemOutcomes };
      delete itemOutcomes[String(progress.itemIndex)];
    }
    frame.loopState[loopNode.id] = {
      // The ordered-prefix cursor does NOT advance mid-item: `iteration`
      // still counts fully-completed items. Only the frame moves.
      iteration: previousBoundary?.iteration ?? 0,
      // G1: merge this item's frame into the keyed collection instead of
      // replacing it. The pre-G1 code rebuilt a singular `itemFrame`, so a
      // second in-flight item overwrote the first and the loser's mid-item
      // progress was lost — on resume it restarted at body node 0 and
      // re-ran committed side effects.
      //
      // 24-I: NOW COVERED. This spread was uncovered at `concurrency: 1`,
      // where only one item is ever in flight and merging is
      // observationally identical to overwriting. The N>1 admission made it
      // killable, and `pipeline-for-each-concurrent-frame-preservation.test.ts`
      // kills it: with two items parked in flight together, dropping this
      // spread collapses the persisted frame sets from ["0","1"] to
      // singletons. That test is doc 27 §8 proof 3.
      itemFrames: {
        ...readItemFrames(previousBoundary),
        [String(progress.itemIndex)]: {
          itemIndex: progress.itemIndex,
          nextBodyNodeIndex: progress.nextBodyNodeIndex,
          bodyResults: loopBodyResultsForCheckpoint(
            progress.bodyResults,
            ctx.config.definition.checkpoint?.includeProviderSessionRefs ===
              true,
          ),
          ...((progress.graph ?? readItemFrames(previousBoundary)?.[String(progress.itemIndex)]?.graph) === undefined
            ? {}
            : { graph: progress.graph ?? readItemFrames(previousBoundary)![String(progress.itemIndex)]!.graph! }),
          ...(progress.attempt === undefined
            ? {}
            : { attempt: progress.attempt }),
          // 24-F: carry the loop's classification through verbatim rather
          // than inferring one here. A writer that inferred "running" from
          // the presence of a body cursor would manufacture an outcome the
          // loop never observed, and absence must stay unprovable.
          ...(progress.outcome === undefined
            ? {}
            : { outcome: progress.outcome }),
          ...(progress.economics === undefined
            ? {}
            : { economics: progress.economics }),
        },
      },
      // 24-G: this callback REBUILDS the loop-state entry, so the terminal
      // set has to be carried across explicitly. Omitting it would silently
      // erase every recorded outcome at the next mid-body checkpoint — the
      // same class of bug G1 fixed for `itemFrames`.
      ...(itemOutcomes === undefined ? {} : { itemOutcomes }),
      ...(previousBoundary?.previousOutput !== undefined
        ? { previousOutput: previousBoundary.previousOutput }
        : {}),
      ...(previousBoundary?.progressDigest !== undefined
        ? { progressDigest: previousBoundary.progressDigest }
        : {}),
    };
    if (progress.mandatory === true || loopNode.bodyGraph !== undefined) {
      await persistCheckpointWithIntegrityBoundary({
        nodeId: loopNode.id, boundary: "loop_resume_cursor",
        save: () => ctx.saveControlCheckpoint(frame),
      });
      if (lastWriteLostCommit(frame.versionTracker)) {
        restoreLoopStateAfterLostCommit(frame.loopState, loopNode.id, previousBoundary);
        throw new PipelineCheckpointCommitConflictError(loopNode.id, {
          completedIterations: previousBoundary?.iteration ?? 0,
          observedVersion: frame.versionTracker.version,
        });
      }
    } else {
      await ctx.saveCheckpoint(frame);
    }
  };
}

/**
 * 24-G: persist one item's terminal outcome.
 *
 * Written to `itemOutcomes`, NOT to `itemFrames`, because the two have
 * opposite lifetimes: `retainInFlightItemFrames` retires a frame the moment
 * the ordered prefix passes its item, which is precisely when the terminal
 * outcome becomes the only remaining evidence about that item. Routing
 * these through the frame collection would have them erased by the very
 * next item boundary.
 */
function itemTerminalOutcomeCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onItemTerminalOutcome"]> {
  return async (outcome) => {
    const previousBoundary = frame.loopState[loopNode.id];
    let liveItemFrames = readItemFrames(previousBoundary);
    const priorFrame = liveItemFrames?.[String(outcome.itemIndex)];
    if (loopNode.bodyGraph !== undefined && priorFrame?.graph !== undefined &&
        outcome.economics !== undefined &&
        (outcome.attempt ?? 0) > (priorFrame.attempt ?? 0)) {
      // A retry reservation can fail before body progress is published.
      // Retain its terminal economics and the unchanged selected cursor in
      // one checkpoint, including denied and outcome-unknown boundaries.
      liveItemFrames = {
        ...liveItemFrames,
        [String(outcome.itemIndex)]: {
          ...priorFrame, attempt: outcome.attempt!,
          economics: outcome.economics, outcome: outcome.outcome,
        },
      };
    }
    frame.loopState[loopNode.id] = {
      // A terminal outcome is not an item-boundary advance — the ordered
      // prefix is owned by `onIterationComplete` alone. Recording an outcome
      // must never move the cursor, or a failed item would be reported as
      // durably completed.
      iteration: previousBoundary?.iteration ?? 0,
      ...(liveItemFrames === undefined ? {} : { itemFrames: liveItemFrames }),
      itemOutcomes: {
        ...(previousBoundary?.itemOutcomes ?? {}),
        [String(outcome.itemIndex)]: {
          itemIndex: outcome.itemIndex,
          outcome: outcome.outcome,
          ...(outcome.economics === undefined
            ? {}
            : { economics: outcome.economics }),
          ...(outcome.attempt === undefined
            ? {}
            : { attempt: outcome.attempt }),
        },
      },
      ...(previousBoundary?.previousOutput !== undefined
        ? { previousOutput: previousBoundary.previousOutput }
        : {}),
      ...(previousBoundary?.progressDigest !== undefined
        ? { progressDigest: previousBoundary.progressDigest }
        : {}),
    };
    await (loopNode.forEach !== undefined && loopNode.bodyGraph !== undefined
      ? ctx.saveControlCheckpoint(frame)
      : ctx.saveCheckpoint(frame));
    if (loopNode.forEach !== undefined && loopNode.bodyGraph !== undefined &&
        lastWriteLostCommit(frame.versionTracker)) {
      restoreLoopStateAfterLostCommit(frame.loopState, loopNode.id, previousBoundary);
      throw new PipelineCheckpointCommitConflictError(loopNode.id, {
        completedIterations: previousBoundary?.iteration ?? 0,
        observedVersion: frame.versionTracker.version,
      });
    }
  };
}

function iterationCompleteCheckpoint(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): NonNullable<LoopResumeOptions["onIterationComplete"]> {
  return async (completedIterations, progress) => {
    clearCommittedLoopInteractionCursor(frame, loopNode.id);
    // Reaching an item boundary retires the mid-item frames the ordered
    // prefix now covers: those items are done, so a retained frame would
    // resume into one already complete.
    //
    // G1: retire only the *flushed* frames. `completedIterations` is the
    // ordered prefix, so every item indexed below it is fully complete and
    // every frame at or above it is still in flight. The pre-G1 code
    // rebuilt the entry from scratch, which dropped the whole collection —
    // a flush by an early item erased the live frame of a later one.
    // G2a: captured BEFORE the retirement below overwrites it, so a lost
    // commit can restore the in-memory frame to what the store still holds.
    const previousLoopState = frame.loopState[loopNode.id];
    const retainedItemFrames = retainInFlightItemFrames(
      readItemFrames(frame.loopState[loopNode.id]),
      completedIterations,
    );
    frame.loopState[loopNode.id] = {
      iteration: completedIterations,
      ...(retainedItemFrames === undefined
        ? {}
        : { itemFrames: retainedItemFrames }),
      // 24-G: the terminal set survives prefix retirement, unlike the frames
      // retired directly above. That asymmetry IS the design: a frame answers
      // "where do I resume this item?" and is meaningless once the prefix
      // covers it, whereas "what happened to this item, and what did it
      // cost?" is asked mostly about items already behind the prefix.
      // Carrying it through here is what makes the terminal set outlive the
      // very mechanism that made it unrecordable before this packet.
      ...(previousLoopState?.itemOutcomes === undefined
        ? {}
        : { itemOutcomes: previousLoopState.itemOutcomes }),
      ...(progress?.previousOutput !== undefined
        ? { previousOutput: progress.previousOutput }
        : {}),
      ...(progress?.progressDigest !== undefined
        ? { progressDigest: progress.progressDigest }
        : {}),
    };
    if (loopNode.forEach !== undefined && loopNode.bodyGraph !== undefined) {
      // attachAs publishes an intentional source update with this prefix.
      // Bind the new durable source bytes in the same serialized transition.
      frame.loopSourceDigests = {
        ...frame.loopSourceDigests,
        [loopNode.id]: digestPipelineInteractionValue(
          resolveStatePath(frame.runState, loopNode.forEach.source).value,
        ),
      };
      await ctx.saveControlCheckpoint(frame);
    } else {
      await ctx.saveCheckpoint(frame);
    }
    // G2a — serialized checkpoint commits.
    //
    // An item boundary is the one place the loop advances its *durable*
    // ordered prefix, so it is the one place a lost commit corrupts rather
    // than merely delays. `writeCheckpoint` resynchronizes its version
    // counter and returns without persisting when it loses a compare-and-set
    // race; before G2a that loss was indistinguishable from "no store
    // configured", so this callback returned normally and the loop treated
    // `completedIterations` items as durably committed. They were not: the
    // store still holds the rival's checkpoint, whose cursor is behind and
    // whose mid-item frames this callback just retired in memory. A resume
    // from that record replays committed body work with no frame to resume
    // from.
    //
    // Fail closed instead. Restore the pre-write loop state so the in-memory
    // frame matches what is actually durable, then surface the loss: another
    // writer owns this run's version line, and continuing to execute against
    // a stale cursor is precisely the interleaving the exact-1 admission
    // gate exists to prevent.
    if (lastWriteLostCommit(frame.versionTracker)) {
      restoreLoopStateAfterLostCommit(
        frame.loopState,
        loopNode.id,
        previousLoopState,
      );
      throw new PipelineCheckpointCommitConflictError(loopNode.id, {
        completedIterations,
        observedVersion: frame.versionTracker.version,
      });
    }
  };
}
