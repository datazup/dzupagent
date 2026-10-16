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
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import { nodeCompletedEvent, nodeStartedEvent } from "./runtime-events.js";
import { findJoinNode } from "../pipeline-shared/edge-resolution.js";
import type { BranchExecutionResult } from "./branch-merge.js";
import { handleFork as handleForkNode } from "./fork-branch-executor.js";
import type {
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "../loop-executor/types.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";
import { persistCheckpointWithIntegrityBoundary } from "../pipeline-shared/checkpoint-integrity-error.js";
import { findAdmittedRecursiveForkGraph } from "../loop-executor/definition-validation/graph-helpers.js";
import {
  executeAdmittedRecursiveFork,
  type RecursiveForkRuntimeDeps,
} from "./recursive-fork-runtime.js";
import type { RunFrame } from "./run-frame.js";

export type { RunFrame } from "./run-frame.js";

export {
  assertForEachCursorWithinSource,
  PipelineForEachCursorCorruptError,
  readItemFrames,
  restoreLoopStateAfterLostCommit,
  retainInFlightItemFrames,
} from "./loop-cursor-state.js";
export { dispatchLoopStage, type LoopStageOutcome } from "./stage-dispatch-loop.js";

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
