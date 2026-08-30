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
 * @module pipeline/executor-internals/stage-dispatch
 */

import type { PipelineNode, ForkNode, LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { digestPipelineInteractionValue } from "@dzupagent/runtime-contracts";
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
  nodeCompletedEvent,
  nodeStartedEvent,
} from "./runtime-events.js";
import { findJoinNode } from "../pipeline-shared/edge-resolution.js";
import type { BranchExecutionResult } from "./branch-merge.js";
import { handleFork as handleForkNode } from "./fork-branch-executor.js";
import { handleLoop as handleLoopNode } from "./loop-node-handler.js";
import type { LoopResumeOptions } from "../loop-executor.js";
import type {
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "../loop-executor/types.js";
import type { LoopState } from "./executor-state-types.js";
import type { PipelineForEachItemFrame } from "@dzupagent/core/pipeline";
import { isTerminalItemOutcome } from "@dzupagent/core/pipeline";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";
import {
  persistCheckpointWithIntegrityBoundary,
  PipelineCheckpointCommitConflictError,
} from "../pipeline-shared/checkpoint-integrity-error.js";
import { lastWriteLostCommit } from "./checkpoint-writer.js";
import { createRuntimePendingInteraction } from "../pipeline-interaction-runtime.js";
import { resolveStatePath } from "../loop-executor/state-path.js";
import { PipelineSourceBindingMismatchError } from "../pipeline-shared/source-binding-mismatch-error.js";
import { findAdmittedRecursiveForkGraph } from "../loop-executor/definition-validation/graph-helpers.js";
import {
  executeAdmittedRecursiveFork,
  type RecursiveForkRuntimeDeps,
} from "./recursive-fork-runtime.js";
import type { RunFrame } from "./run-frame.js";

export type { RunFrame } from "./run-frame.js";

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
 * not: the caller below THROWS `PipelineCheckpointCommitConflictError` on the
 * line after this call, the throw propagates out of the worker and aborts the
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

/** Dependency bag exposing the executor's helpers to the stage functions. */
export interface StageContext {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  /** Persist a checkpoint per the configured strategy. */
  saveCheckpoint: (frame: RunFrame) => Promise<void>;
  /** Persist an outer control boundary regardless of the periodic strategy. */
  saveControlCheckpoint: (
    frame: RunFrame,
    suspendedAtNodeId?: string,
  ) => Promise<void>;
  /** First next-node id for `nodeId`, evaluated against current state. */
  next: (
    nodeId: string,
    runState: Record<string, unknown>,
  ) => string | undefined;
  /** Record the stable idempotency key for a completed node. */
  recordIdempotencyKey: (
    keys: Record<string, string>,
    runId: string,
    node: PipelineNode,
  ) => void;
  /** Resolve the error-edge target for a node given an error, if any. */
  errorEdgeFor: (nodeId: string, error: unknown) => string | undefined;
  /** Build the dependency bag for fork/branch fan-out. */
  forkDeps: (runId: string) => Parameters<typeof handleForkNode>[0];
  recursiveForkDeps: () => RecursiveForkRuntimeDeps;
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
    error?: string,
  ) => PipelineRunResult;
  /** Execute one bounded compiler-lowered loop body through the graph walker. */
  scheduleLoopBodyGraph: (
    loopNode: LoopNode,
    frame: RunFrame,
    input: LoopBodyGraphScheduleInput,
  ) => Promise<LoopBodyGraphScheduleResult>;
}

/**
 * Fork stage: restore branches that completed before a crash, fan out the
 * remaining branches, then route to the join node (checkpointing along the
 * way). Returns the next node id to walk to.
 */
export async function dispatchForkStage(
  ctx: StageContext,
  forkNode: ForkNode,
  frame: RunFrame,
): Promise<{ nextNodeId: string | undefined }> {
  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
  } = frame;
  const forkId = forkNode.forkId;
  const joinNode = findJoinNode(forkId, ctx.config.definition.nodes);
  const recursiveGraph =
    joinNode === undefined
      ? undefined
      : findAdmittedRecursiveForkGraph(
          forkNode.id,
          joinNode.id,
          ctx.nodeMap,
          ctx.config.definition.edges,
        );

  if (recursiveGraph !== undefined) {
    if (joinNode === undefined) {
      throw new Error(`Recursive fork "${forkNode.id}" has no owning join.`);
    }
    ctx.emit(nodeStartedEvent(forkNode.id, "fork"));
    if (!completedNodeIds.includes(forkNode.id)) {
      completedNodeIds.push(forkNode.id);
    }
    const recursiveConfig = ctx.config.recursiveFork;
    if (recursiveConfig === undefined) {
      throw new Error(
        `Recursive fork "${forkNode.id}" requires PipelineRuntimeConfig.recursiveFork.durable.`,
      );
    }
    const result = await executeAdmittedRecursiveFork(
      ctx.recursiveForkDeps(),
      forkNode,
      recursiveGraph,
      frame,
      recursiveConfig.durable,
    );
    ctx.emit(nodeCompletedEvent(forkNode.id, 0));
    completedNodeIds.push(joinNode.id);
    ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, joinNode);
    const selectedContinuationNodeId = ctx.next(joinNode.id, runState);
    (frame.recursiveForkCompletions ??= {})[forkNode.id] = {
      ...result.receipt,
      checkpointVersion: frame.versionTracker.version + 1,
      ...(selectedContinuationNodeId === undefined
        ? {}
        : { selectedContinuationNodeId }),
    };
    await persistCheckpointWithIntegrityBoundary({
      nodeId: joinNode.id,
      boundary: "fork_join_completion",
      save: () => ctx.saveCheckpoint(frame),
    });
    return { nextNodeId: selectedContinuationNodeId };
  }

  // Restore branches that completed before a crash (W4): rehydrate each saved
  // nodeResults object back into a Map for the merge.
  const saved = frame.forkState[forkId]?.branches ?? {};
  const completedBranches: Record<string, BranchExecutionResult> = {};
  for (const [branchStartId, entry] of Object.entries(saved)) {
    completedBranches[branchStartId] = {
      state: "completed",
      stateDelta: entry.stateDelta,
      nodeResults: new Map(
        Object.entries(entry.nodeResults) as [string, NodeResult][],
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
    },
  );

  delete frame.forkState[forkId];
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
  frame: RunFrame,
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
    onBodyNodeComplete: async (progress) => {
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
    },
    onIterationBudgetCheckpoint: async (progress) => {
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
    },
    onBodyGraphCheckpoint: async (progress) => {
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
        ...(previousBoundary?.itemOutcomes === undefined
          ? {}
          : { itemOutcomes: previousBoundary.itemOutcomes }),
        ...(previousBoundary?.previousOutput !== undefined
          ? { previousOutput: previousBoundary.previousOutput }
          : {}),
        ...(previousBoundary?.progressDigest !== undefined
          ? { progressDigest: previousBoundary.progressDigest }
          : {}),
      };
      await ctx.saveCheckpoint(frame);
    },
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
    onItemTerminalOutcome: async (outcome) => {
      const previousBoundary = frame.loopState[loopNode.id];
      const liveItemFrames = readItemFrames(previousBoundary);
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
          previousLoopState,
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
    loopResume,
  );
  const loopResult = handledLoop.result;

  if (handledLoop.control !== undefined) {
    const { outcome, checkpointState, completedIterations } =
      handledLoop.control;
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
  await ctx.saveCheckpoint(frame);
  return { kind: "continue", nextNodeId: ctx.next(loopNode.id, runState) };
}

function retainBodyGraphState(
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

function clearCommittedLoopInteractionCursor(
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

function loopBodyResultsForCheckpoint(
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
