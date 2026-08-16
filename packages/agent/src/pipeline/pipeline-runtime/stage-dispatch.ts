/**
 * Per-stage dispatch — the fork and loop stage executors extracted from
 * `PipelineExecutor` so the executor's core graph-walk loop stays focused.
 *
 * These are pure delegations of the previous `dispatchFork`/`dispatchLoop`
 * methods: same restore-branches / fan-out / join routing for fork, same
 * durable-resume / iteration-checkpoint / error-edge routing for loop. The
 * executor threads its private helpers (`saveCheckpoint`, `next`,
 * `recordIdempotencyKey`, `errorEdgeFor`, `forkDeps`, `emit`, `setState`,
 * `runResult`) through the {@link StageContext} bag so behavior is unchanged.
 *
 * @module pipeline/pipeline-runtime/stage-dispatch
 */

import type {
  PipelineNode,
  ForkNode,
  LoopNode,
} from "@dzupagent/core/pipeline";
import type {
  PipelineInteractionResumeV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "@dzupagent/runtime-contracts";
import { digestPipelineDefinition } from "@dzupagent/runtime-contracts";
import type { PipelineInteractionResumeCursor } from "@dzupagent/core/pipeline";
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import {
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
} from "./runtime-events.js";
import { findJoinNode } from "./edge-resolution.js";
import type { BranchExecutionResult } from "./branch-merge.js";
import { handleFork as handleForkNode } from "./fork-branch-executor.js";
import { handleLoop as handleLoopNode } from "./loop-node-handler.js";
import type { LoopResumeOptions } from "../loop-executor.js";
import type {
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "../loop-executor/types.js";
import type { ForkState, LoopState } from "./executor-state-types.js";
import type { PipelineForEachItemFrame } from "@dzupagent/core/pipeline";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";
import {
  persistCheckpointWithIntegrityBoundary,
  PipelineCheckpointCommitConflictError,
} from "./checkpoint-integrity-error.js";
import { lastWriteLostCommit } from "./checkpoint-writer.js";
import { createRuntimePendingInteraction } from "../pipeline-interaction-runtime.js";
import { resolveStatePath } from "../loop-executor/state-path.js";
import { PipelineSourceBindingMismatchError } from "../pipeline-runtime-lifecycle/resume-context.js";

/**
 * Roll a loop's in-memory entry back to what the store still holds, after a
 * checkpoint commit was lost to a compare-and-set conflict (G2a).
 *
 * Exported for direct testing: the run aborts immediately after a lost
 * item-boundary commit and writes no further checkpoint, so this rollback has
 * no *end-to-end* observation point — a mutant deleting it survives every
 * suite. That mirrors the G1 mid-item merge, and for the same underlying
 * reason: the state it protects only becomes readable once a lost commit can
 * be followed by another write against the same frame, which requires the N>1
 * admission. It is unit-tested here and owes an end-to-end test to that slice.
 *
 * Correctness still matters today: leaving the retired-frame/advanced-cursor
 * entry in memory would mean any future caller that persists this frame writes
 * a cursor no durable record backs.
 */
export function restoreLoopStateAfterLostCommit(
  loopState: LoopState,
  loopNodeId: string,
  previous: LoopState[string] | undefined
): void {
  // `delete` rather than assigning `undefined`: the first boundary of a loop
  // has no prior entry, and `LoopState` holds no undefined values.
  if (previous === undefined) {
    delete loopState[loopNodeId];
    return;
  }
  loopState[loopNodeId] = previous;
}

/** Dependency bag exposing the executor's helpers to the stage functions. */
export interface StageContext {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  /** Persist a checkpoint per the configured strategy. */
  saveCheckpoint: (frame: RunFrame) => Promise<void>;
  /** Persist an outer control boundary regardless of the periodic strategy. */
  saveControlCheckpoint: (
    frame: RunFrame,
    suspendedAtNodeId?: string
  ) => Promise<void>;
  /** First next-node id for `nodeId`, evaluated against current state. */
  next: (
    nodeId: string,
    runState: Record<string, unknown>
  ) => string | undefined;
  /** Record the stable idempotency key for a completed node. */
  recordIdempotencyKey: (
    keys: Record<string, string>,
    runId: string,
    node: PipelineNode
  ) => void;
  /** Resolve the error-edge target for a node given an error, if any. */
  errorEdgeFor: (nodeId: string, error: unknown) => string | undefined;
  /** Build the dependency bag for fork/branch fan-out. */
  forkDeps: (runId: string) => Parameters<typeof handleForkNode>[0];
  /** Mutable global cost accumulator shared with standard-node dispatch. */
  budgetTracker: BudgetTrackerState;
  emit: (event: PipelineRuntimeEvent) => void;
  setState: (next: PipelineState) => void;
  runResult: (
    runId: string,
    state: PipelineState,
    nodeResults: Map<string, NodeResult>,
    totalDurationMs: number,
    /** Failure reason; only meaningful when `state` is `"failed"`. */
    error?: string
  ) => PipelineRunResult;
  /** Execute one bounded compiler-lowered loop body through the graph walker. */
  scheduleLoopBodyGraph: (
    loopNode: LoopNode,
    frame: RunFrame,
    input: LoopBodyGraphScheduleInput
  ) => Promise<LoopBodyGraphScheduleResult>;
}

/** Per-run mutable state threaded through a single stage dispatch. */
export interface RunFrame {
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: LoopState;
  forkState: ForkState;
  eventLog: PipelineRuntimeEvent[];
  versionTracker: { version: number };
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor?: PipelineInteractionResumeCursor;
  /**
   * Per-loop digest of each `for_each` loop's resolved item source (E3),
   * recorded when the loop resolves its items. Carried onto the checkpoint's
   * `sourceBinding` so a resume can prove the retained ordered prefix still
   * refers to the same items in the same order. Loops not yet reached are
   * absent — absence is "unprovable", never "agreement".
   */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
  startTime: number;
}

/**
 * Fork stage: restore branches that completed before a crash, fan out the
 * remaining branches, then route to the join node (checkpointing along the
 * way). Returns the next node id to walk to.
 */
export async function dispatchForkStage(
  ctx: StageContext,
  forkNode: ForkNode,
  frame: RunFrame
): Promise<{ nextNodeId: string | undefined }> {
  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
  } = frame;
  const forkId = forkNode.forkId;

  // Restore branches that completed before a crash (W4): rehydrate each saved
  // nodeResults object back into a Map for the merge.
  const saved = frame.forkState[forkId]?.branches ?? {};
  const completedBranches: Record<string, BranchExecutionResult> = {};
  for (const [branchStartId, entry] of Object.entries(saved)) {
    completedBranches[branchStartId] = {
      state: "completed",
      stateDelta: entry.stateDelta,
      nodeResults: new Map(
        Object.entries(entry.nodeResults) as [string, NodeResult][]
      ),
      completedNodeIds: [],
    };
  }

  await handleForkNode(
    ctx.forkDeps(runId),
    forkNode,
    runState,
    nodeResults,
    completedNodeIds,
    {
      completedBranches,
      onBranchComplete: async (branchStartId, result) => {
        const bucket = (frame.forkState[forkId] ??= { branches: {} });
        bucket.branches[branchStartId] = {
          stateDelta: result.stateDelta,
          nodeResults: Object.fromEntries(result.nodeResults),
        };
        await persistCheckpointWithIntegrityBoundary({
          nodeId: branchStartId,
          boundary: "fork_branch_completion",
          save: () => ctx.saveCheckpoint(frame),
        });
      },
    }
  );

  delete frame.forkState[forkId];
  const joinNode = findJoinNode(forkId, ctx.config.definition.nodes);
  if (joinNode) {
    completedNodeIds.push(joinNode.id);
    ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, joinNode);
    await persistCheckpointWithIntegrityBoundary({
      nodeId: joinNode.id,
      boundary: "fork_join_completion",
      save: () => ctx.saveCheckpoint(frame),
    });
    return { nextNodeId: ctx.next(joinNode.id, runState) };
  }
  return { nextNodeId: undefined };
}

/**
 * Loop stage: resume from the persisted iteration cursor, checkpoint after
 * each iteration, then route success (advance) / error (error-edge or fail).
 */
export async function dispatchLoopStage(
  ctx: StageContext,
  loopNode: LoopNode,
  frame: RunFrame
): Promise<
  | { kind: "continue"; nextNodeId: string | undefined }
  | { kind: "return"; value: PipelineRunResult }
> {
  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
  } = frame;

  // E3: pin the resolved item source before the loop runs, so a resume can
  // prove its retained ordered prefix still refers to the same items in the
  // same order. Recorded only for `for_each` loops whose source actually
  // resolves to an array — anything else stays unbound (unprovable), never
  // falsely bound.
  if (loopNode.forEach !== undefined) {
    const resolvedSource = resolveStatePath(runState, loopNode.forEach.source);
    if (Array.isArray(resolvedSource.value)) {
      const currentDigest = digestPipelineDefinition(resolvedSource.value);
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
            "different items."
        );
      }
      frame.loopSourceDigests = {
        ...frame.loopSourceDigests,
        [loopNode.id]: currentDigest,
      };
    }
  }

  // Durable loop resume (W3): start from the persisted cursor (if any) and
  // checkpoint the cursor + accumulated state after every iteration so a
  // crash resumes mid-loop instead of restarting at iteration 0.
  const resumeFrom = frame.loopState[loopNode.id]?.iteration ?? 0;
  const savedLoopState = frame.loopState[loopNode.id];
  const loopResume: LoopResumeOptions = {
    startIteration: resumeFrom,
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
          ])
        ),
      };
    })(),
    ...(savedLoopState?.previousOutput !== undefined
      ? { previousOutput: savedLoopState.previousOutput }
      : {}),
    ...(savedLoopState?.progressDigest !== undefined
      ? { progressDigest: savedLoopState.progressDigest }
      : {}),
    ...(loopNode.bodyGraph === undefined
      ? {}
      : {
          scheduleBodyGraph: (input: LoopBodyGraphScheduleInput) =>
            ctx.scheduleLoopBodyGraph(loopNode, frame, input),
        }),
    onBodyNodeComplete: async (progress) => {
      const previousBoundary = frame.loopState[loopNode.id];
      frame.loopState[loopNode.id] = {
        iteration: progress.completedIterations,
        nextBodyNodeIndex: progress.nextBodyNodeIndex,
        bodyResults: loopBodyResultsForCheckpoint(
          progress.bodyResults,
          ctx.config.definition.checkpoint?.includeProviderSessionRefs === true
        ),
        ...(previousBoundary?.previousOutput !== undefined
          ? { previousOutput: previousBoundary.previousOutput }
          : {}),
        ...(previousBoundary?.progressDigest !== undefined
          ? { progressDigest: previousBoundary.progressDigest }
          : {}),
      };
      await ctx.saveCheckpoint(frame);
    },
    onBodyGraphCheckpoint: async (progress) => {
      retainBodyGraphState(
        frame,
        loopNode.id,
        progress.completedIterations,
        progress.state
      );
      clearCommittedLoopInteractionCursor(
        frame,
        loopNode.id,
        progress.state,
        (nodeId, error) => ctx.errorEdgeFor(nodeId, error)
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
    },
    onItemBodyNodeComplete: async (progress) => {
      const previousBoundary = frame.loopState[loopNode.id];
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
        // NOT COVERED BY A KILLING TEST, deliberately: at `concurrency: 1`
        // only one item is ever in flight, so merging and overwriting are
        // observationally identical and a mutant dropping this spread
        // survives. It becomes observable — and must gain a test — in the
        // slice that admits N>1.
        itemFrames: {
          ...readItemFrames(previousBoundary),
          [String(progress.itemIndex)]: {
            itemIndex: progress.itemIndex,
            nextBodyNodeIndex: progress.nextBodyNodeIndex,
            bodyResults: loopBodyResultsForCheckpoint(
              progress.bodyResults,
              ctx.config.definition.checkpoint?.includeProviderSessionRefs ===
                true
            ),
            ...(progress.attempt === undefined
              ? {}
              : { attempt: progress.attempt }),
          },
        },
        ...(previousBoundary?.previousOutput !== undefined
          ? { previousOutput: previousBoundary.previousOutput }
          : {}),
        ...(previousBoundary?.progressDigest !== undefined
          ? { progressDigest: previousBoundary.progressDigest }
          : {}),
      };
      await ctx.saveCheckpoint(frame);
    },
    onIterationComplete: async (completedIterations, progress) => {
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
        completedIterations
      );
      frame.loopState[loopNode.id] = {
        iteration: completedIterations,
        ...(retainedItemFrames === undefined
          ? {}
          : { itemFrames: retainedItemFrames }),
        ...(progress?.previousOutput !== undefined
          ? { previousOutput: progress.previousOutput }
          : {}),
        ...(progress?.progressDigest !== undefined
          ? { progressDigest: progress.progressDigest }
          : {}),
      };
      await ctx.saveCheckpoint(frame);
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
          previousLoopState
        );
        throw new PipelineCheckpointCommitConflictError(loopNode.id, {
          completedIterations,
          observedVersion: frame.versionTracker.version,
        });
      }
    },
  };

  const handledLoop = await handleLoopNode(
    {
      config: ctx.config,
      nodeMap: ctx.nodeMap,
      emit: ctx.emit,
      budgetTracker: ctx.budgetTracker,
      runId,
    },
    loopNode,
    runState,
    nodeResults,
    loopResume
  );
  const loopResult = handledLoop.result;

  if (handledLoop.control !== undefined) {
    const { outcome, checkpointState, completedIterations } =
      handledLoop.control;
    retainBodyGraphState(
      frame,
      loopNode.id,
      completedIterations,
      checkpointState
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
        Date.now() - frame.startTime
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
        loopResult.error
      ),
    };
  }
  // Loop finished — clear its cursor so resume does not treat it as mid-flight.
  delete frame.loopState[loopNode.id];
  nodeResults.set(loopNode.id, loopResult);
  completedNodeIds.push(loopNode.id);
  ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, loopNode);
  await ctx.saveCheckpoint(frame);
  return { kind: "continue", nextNodeId: ctx.next(loopNode.id, runState) };
}

function retainBodyGraphState(
  frame: RunFrame,
  loopNodeId: string,
  completedIterations: number,
  state: NonNullable<LoopState[string]["bodyGraphState"]>
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
  };
}

function clearCommittedLoopInteractionCursor(
  frame: RunFrame,
  loopNodeId: string,
  state?: NonNullable<LoopState[string]["bodyGraphState"]>,
  errorTarget?: (nodeId: string, error: string) => string | undefined
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

function loopBodyResultsForCheckpoint(
  results: Readonly<Record<string, NodeResult>>,
  includeProviderSessionRefs: boolean
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
    ])
  );
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
  cursor: LoopState[string] | undefined
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
  completedIterations: number
): Record<string, PipelineForEachItemFrame> | undefined {
  if (itemFrames === undefined) return undefined;
  const retained = Object.fromEntries(
    Object.entries(itemFrames).filter(
      ([, itemFrame]) => itemFrame.itemIndex >= completedIterations
    )
  );
  return Object.keys(retained).length === 0 ? undefined : retained;
}
