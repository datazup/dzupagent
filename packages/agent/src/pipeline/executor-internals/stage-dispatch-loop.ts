/**
 * Loop stage dispatch — `dispatchLoopStage` and the phase helpers it is
 * composed of: bind the for_each item source, assemble the durable resume
 * options, run the loop, then settle a nested control outcome or the plain
 * loop result. Extracted from `stage-dispatch.ts` (DZUPAGENT-CODE-H-11)
 * without behavior change; `stage-dispatch.ts` re-exports `dispatchLoopStage`.
 *
 * @module pipeline/executor-internals/stage-dispatch-loop
 */

import { validateForEachItemGraphs } from "../loop-executor/for-each-graph.js";
import type { LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { digestPipelineDefinition, digestPipelineInteractionValue } from "@dzupagent/runtime-contracts";
import type { NodeResult, PipelineRunResult } from "../pipeline-runtime-types.js";
import {
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
} from "./runtime-events.js";
import {
  handleLoop as handleLoopNode,
  type LoopNodeHandlerResult,
} from "./loop-node-handler.js";
import type { LoopResumeOptions } from "../loop-executor.js";
import type { LoopBodyGraphScheduleInput } from "../loop-executor/types.js";
import {
  persistCheckpointWithIntegrityBoundary,
  PipelineCheckpointCommitConflictError,
} from "../pipeline-shared/checkpoint-integrity-error.js";
import { lastWriteLostCommit } from "./checkpoint-writer.js";
import { createRuntimePendingInteraction } from "../pipeline-interaction-runtime.js";
import { resolveStatePath } from "../loop-executor/state-path.js";
import { PipelineSourceBindingMismatchError } from "../pipeline-shared/source-binding-mismatch-error.js";
import {
  assertForEachCursorWithinSource,
  readItemFrames,
  retainBodyGraphState,
} from "./loop-cursor-state.js";
import { createLoopCheckpointCallbacks } from "./loop-stage-checkpoints.js";
import type { RunFrame } from "./run-frame.js";
import type { StageContext } from "./stage-context.js";

/** Outcome of a loop stage: keep walking, or end the run with a result. */
export type LoopStageOutcome =
  | { kind: "continue"; nextNodeId: string | undefined }
  | { kind: "return"; value: PipelineRunResult };

/**
 * Loop stage: resume from the persisted iteration cursor, checkpoint after
 * each iteration, then route success (advance) / error (error-edge or fail).
 */
export async function dispatchLoopStage(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): Promise<LoopStageOutcome> {
  bindForEachLoopSource(ctx, loopNode, frame);
  const loopResume = buildLoopResumeOptions(ctx, loopNode, frame);

  const handledLoop = await handleLoopNode(
    {
      config: ctx.config,
      nodeMap: ctx.nodeMap,
      emit: ctx.emit,
      budgetTracker: ctx.budgetTracker,
      runId: frame.runId,
    },
    loopNode,
    frame.runState,
    frame.nodeResults,
    loopResume,
  );
  const loopResult = handledLoop.result;

  if (handledLoop.control !== undefined) {
    return settleLoopControlOutcome(
      ctx,
      loopNode,
      frame,
      loopResult,
      handledLoop.control,
    );
  }
  return settleLoopResult(ctx, loopNode, frame, loopResult);
}

/**
 * E3 source binding for a `for_each` loop: verify a resumed loop's retained
 * prefix still describes the resolved item source, then pin its digest.
 */
function bindForEachLoopSource(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): void {
  const { runId, runState } = frame;

  // E3: pin the resolved item source before the loop runs, so a resume can
  // prove its retained ordered prefix still refers to the same items in the
  // same order. Recorded only for `for_each` loops whose source actually
  // resolves to an array — anything else stays unbound (unprovable), never
  // falsely bound.
  if (loopNode.forEach !== undefined) {
    if (loopNode.bodyGraph !== undefined && ctx.config.checkpointStore === undefined) {
      throw new Error(`Loop "${loopNode.id}" conditional items require a checkpoint store`);
    }
    const resolvedSource = resolveStatePath(runState, loopNode.forEach.source);
    if (Array.isArray(resolvedSource.value)) {
      const currentDigest = digestPipelineInteractionValue(
        resolvedSource.value,
      );
      // E3 defect 1, per-loop half: a resumed loop carries a retained ordered
      // prefix (`iteration`) or a mid-item frame computed against the source as
      // it was. If the source has since changed, that prefix names different
      // items — fail closed rather than skip or re-run the wrong ones. Only
      // enforced when the loop is actually resuming: a first pass has no
      // retained prefix to invalidate.
      const recordedDigest = frame.loopSourceDigests?.[loopNode.id];
      const isResuming =
        (frame.loopState[loopNode.id]?.iteration ?? 0) > 0 ||
        readItemFrames(frame.loopState[loopNode.id]) !== undefined;
      if (
        isResuming &&
        recordedDigest !== undefined &&
        recordedDigest !== currentDigest
      ) {
        throw new PipelineSourceBindingMismatchError(
          `Cannot resume loop "${loopNode.id}" in run "${runId}": its item ` +
            `source was checkpointed as ${recordedDigest} but now resolves to ` +
            `${currentDigest}. The retained ordered prefix would refer to ` +
            "different items.",
        );
      }
      validateForEachItemGraphs(
        ctx.config.definition, loopNode, resolvedSource.value,
        readItemFrames(frame.loopState[loopNode.id]),
      );
      if (loopNode.bodyGraph !== undefined && isResuming && recordedDigest === undefined) {
        throw new PipelineSourceBindingMismatchError("Retained item graph has no original ordered-source binding");
      }
      frame.loopSourceDigests = {
        ...frame.loopSourceDigests,
        [loopNode.id]: currentDigest,
      };

      // E3 defect 2 (doc 27 §8 proof 5, cursor sub-part): the retained cursor
      // is durable data, so a truncated write or a hand-edited checkpoint can
      // present a prefix the source cannot support. The executor otherwise
      // clamps it into range, which turns corruption into a silent wrong
      // answer: `iteration: 99` over a 2-item source clamps to 2 and the loop
      // reports success having dispatched nothing.
      //
      // Bind the cursor to the item count here, where the source is resolved,
      // because the count is not itself stored on the checkpoint. Enforced on
      // resume only — a fresh pass has no retained prefix to invalidate.
      if (isResuming) {
        assertForEachCursorWithinSource(
          loopNode.id,
          runId,
          frame.loopState[loopNode.id],
          resolvedSource.value.length,
        );
      }
    }
  }
}

/**
 * Durable loop resume options: the persisted cursor plus the checkpoint
 * callbacks that advance it.
 */
function buildLoopResumeOptions(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
): LoopResumeOptions {
  // Durable loop resume (W3): start from the persisted cursor (if any) and
  // checkpoint the cursor + accumulated state after every iteration so a
  // crash resumes mid-loop instead of restarting at iteration 0.
  const resumeFrom = frame.loopState[loopNode.id]?.iteration ?? 0;
  const savedLoopState = frame.loopState[loopNode.id];
  return {
    startIteration: resumeFrom,
    ...(loopNode.bodyGraph === undefined ? {} : { graphDefinitionDigest: digestPipelineDefinition(ctx.config.definition) }),
    ...(savedLoopState?.nextBodyNodeIndex !== undefined
      ? { startBodyNodeIndex: savedLoopState.nextBodyNodeIndex }
      : {}),
    ...(savedLoopState?.bodyResults !== undefined
      ? {
          bodyResults: savedLoopState.bodyResults as Record<string, NodeResult>,
        }
      : {}),
    ...(savedLoopState?.bodyGraphState === undefined
      ? {}
      : { bodyGraphState: savedLoopState.bodyGraphState }),
    ...(() => {
      // G1: accepts either the keyed `itemFrames` or a pre-G1 singular
      // `itemFrame`, both normalised to the keyed shape before dispatch.
      const savedItemFrames = readItemFrames(savedLoopState);
      if (savedItemFrames === undefined) {
        return {};
      }
      return {
        itemFrames: Object.fromEntries(
          Object.entries(savedItemFrames).map(([key, itemFrame]) => [
            key,
            {
              ...itemFrame,
              bodyResults: (itemFrame.bodyResults ?? {}) as Record<
                string,
                NodeResult
              >,
            },
          ]),
        ),
      };
    })(),
    // 24-H: hand the durable terminal set to the loop so it can refuse to
    // re-dispatch an item a previous run already settled. 24-G persisted this
    // record but never read it back; without this line the executor cannot see
    // it, and an out-of-order completion is charged a second time.
    ...(savedLoopState?.itemOutcomes === undefined
      ? {}
      : { itemOutcomes: savedLoopState.itemOutcomes }),
    ...(savedLoopState?.previousOutput !== undefined
      ? { previousOutput: savedLoopState.previousOutput }
      : {}),
    ...(savedLoopState?.progressDigest !== undefined
      ? { progressDigest: savedLoopState.progressDigest }
      : {}),
    ...(savedLoopState?.iterationOutcome !== undefined
      ? { iterationOutcome: savedLoopState.iterationOutcome }
      : {}),
    ...(savedLoopState?.iterationEconomics !== undefined
      ? { iterationEconomics: savedLoopState.iterationEconomics }
      : {}),
    ...(loopNode.bodyGraph === undefined
      ? {}
      : {
          scheduleBodyGraph: (input: LoopBodyGraphScheduleInput) =>
            ctx.scheduleLoopBodyGraph(loopNode, frame, input),
        }),
    ...createLoopCheckpointCallbacks(ctx, loopNode, frame),
  };
}

/** Settle a nested body-graph control outcome (suspension or terminal exit). */
async function settleLoopControlOutcome(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
  loopResult: NodeResult,
  control: NonNullable<LoopNodeHandlerResult["control"]>,
): Promise<LoopStageOutcome> {
  const { runId, nodeResults, completedNodeIds, nodeIdempotencyKeys } = frame;
  const { outcome, checkpointState, completedIterations } = control;
  retainBodyGraphState(
    frame,
    loopNode.id,
    completedIterations,
    checkpointState,
  );
  nodeResults.set(loopNode.id, loopResult);

  if (outcome.kind === "suspended") {
    const interactionNode = ctx.nodeMap.get(outcome.exitNodeId);
    if (
      interactionNode !== undefined &&
      (interactionNode.type === "gate" ||
        interactionNode.type === "suspend") &&
      interactionNode.interaction !== undefined
    ) {
      frame.pendingInteraction = createRuntimePendingInteraction({
        definition: ctx.config.definition,
        runId,
        node: interactionNode,
        scope: {
          kind: "loop",
          loopNodeId: loopNode.id,
          iteration: completedIterations,
        },
        occurrence: completedIterations,
        expectedCheckpointVersion: frame.versionTracker.version + 1,
        ...(ctx.config.interaction?.ttlMs === undefined
          ? {}
          : { ttlMs: ctx.config.interaction.ttlMs }),
        ...(ctx.config.interaction?.now === undefined
          ? {}
          : { now: ctx.config.interaction.now }),
      });
      delete frame.interactionResumeCursor;
    }
    await persistCheckpointWithIntegrityBoundary({
      nodeId: loopNode.id,
      boundary: "loop_suspension",
      save: () => ctx.saveControlCheckpoint(frame, loopNode.id),
    });
    ctx.setState("suspended");
    ctx.emit(pipelineSuspendedEvent(loopNode.id));
    const value = ctx.runResult(
      runId,
      "suspended",
      nodeResults,
      Date.now() - frame.startTime,
    );
    if (frame.pendingInteraction !== undefined) {
      value.pendingInteraction = frame.pendingInteraction;
    }
    return {
      kind: "return",
      value,
    };
  }

  completedNodeIds.push(loopNode.id);
  ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, loopNode);
  // A terminal nested outcome is itself the durable replay authority. Clear
  // the consumed cursor in the same checkpoint so a crash after this save
  // cannot re-enter the loop and escape into its outer continuation.
  delete frame.interactionResumeCursor;
  await persistCheckpointWithIntegrityBoundary({
    nodeId: loopNode.id,
    boundary: "loop_terminal",
    save: () => ctx.saveControlCheckpoint(frame, outcome.exitNodeId),
  });
  const totalMs = Date.now() - frame.startTime;
  ctx.setState("completed");
  ctx.emit(pipelineCompletedEvent(runId, totalMs));
  return {
    kind: "return",
    value: ctx.runResult(runId, "completed", nodeResults, totalMs),
  };
}

/** Route a finished loop: error edge, run failure, or clear cursor and advance. */
async function settleLoopResult(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame,
  loopResult: NodeResult,
): Promise<LoopStageOutcome> {
  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
  } = frame;
  if (loopResult.error) {
    const errorNext = ctx.errorEdgeFor(loopNode.id, loopResult.error);
    if (errorNext) {
      nodeResults.set(loopNode.id, loopResult);
      return { kind: "continue", nextNodeId: errorNext };
    }
    ctx.setState("failed");
    nodeResults.set(loopNode.id, loopResult);
    ctx.emit(pipelineFailedEvent(runId, loopResult.error));
    return {
      kind: "return",
      value: ctx.runResult(
        runId,
        "failed",
        nodeResults,
        Date.now() - frame.startTime,
        // Same string as the event: a loop fail-closed (for_each budget denial
        // included) is exactly the case where the caller needs the reason.
        loopResult.error,
      ),
    };
  }
  // Loop finished — clear its cursor so resume does not treat it as mid-flight.
  //
  // 24-G: the RESUME cursor is what must go; the terminal set must not. This is
  // the same lifetime conflict as `retainInFlightItemFrames`, one level up:
  // deleting the whole entry here would erase every per-item outcome at exactly
  // the moment the loop succeeds, so a fully-successful run — the case where
  // every item settled and the accounting is most complete — would be the one
  // run that recorded nothing. `iteration` is reset to 0 alongside it because a
  // finished loop has no cursor to resume from, and leaving the count would
  // read as mid-flight progress.
  const finishedIterations = frame.loopState[loopNode.id]?.iteration ?? 0;
  const finishedOutcomes = frame.loopState[loopNode.id]?.itemOutcomes;
  if (finishedOutcomes === undefined) {
    delete frame.loopState[loopNode.id];
  } else {
    frame.loopState[loopNode.id] = {
      iteration: 0,
      itemOutcomes: finishedOutcomes,
    };
  }
  nodeResults.set(loopNode.id, loopResult);
  completedNodeIds.push(loopNode.id);
  ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, loopNode);
  await (loopNode.forEach !== undefined && loopNode.bodyGraph !== undefined
    ? ctx.saveControlCheckpoint(frame)
    : ctx.saveCheckpoint(frame));
  if (loopNode.forEach !== undefined && loopNode.bodyGraph !== undefined &&
      lastWriteLostCommit(frame.versionTracker)) {
    throw new PipelineCheckpointCommitConflictError(loopNode.id, {
      completedIterations: finishedIterations,
      observedVersion: frame.versionTracker.version,
    });
  }
  return { kind: "continue", nextNodeId: ctx.next(loopNode.id, runState) };
}
