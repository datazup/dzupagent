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
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import { pipelineFailedEvent } from "./runtime-events.js";
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
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";

/** Dependency bag exposing the executor's helpers to the stage functions. */
export interface StageContext {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  /** Persist a checkpoint per the configured strategy. */
  saveCheckpoint: (frame: RunFrame) => Promise<void>;
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
    totalDurationMs: number
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
        await ctx.saveCheckpoint(frame);
      },
    }
  );

  delete frame.forkState[forkId];
  const joinNode = findJoinNode(forkId, ctx.config.definition.nodes);
  if (joinNode) {
    completedNodeIds.push(joinNode.id);
    ctx.recordIdempotencyKey(nodeIdempotencyKeys, runId, joinNode);
    await ctx.saveCheckpoint(frame);
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
          bodyResults: savedLoopState.bodyResults as Record<
            string,
            NodeResult
          >,
        }
      : {}),
    ...(savedLoopState?.bodyGraphState === undefined
      ? {}
      : { bodyGraphState: savedLoopState.bodyGraphState }),
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
      const previousBoundary = frame.loopState[loopNode.id];
      frame.loopState[loopNode.id] = {
        iteration: progress.completedIterations,
        bodyGraphState: progress.state,
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
      frame.loopState[loopNode.id] = {
        iteration: completedIterations,
        ...(progress?.previousOutput !== undefined
          ? { previousOutput: progress.previousOutput }
          : {}),
        ...(progress?.progressDigest !== undefined
          ? { progressDigest: progress.progressDigest }
          : {}),
      };
      await ctx.saveCheckpoint(frame);
    },
  };

  const loopResult = await handleLoopNode(
    {
      config: ctx.config,
      nodeMap: ctx.nodeMap,
      emit: ctx.emit,
      budgetTracker: ctx.budgetTracker,
    },
    loopNode,
    runState,
    nodeResults,
    loopResume
  );

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
        Date.now() - frame.startTime
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
