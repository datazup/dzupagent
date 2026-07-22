/**
 * Resume / redeliver orchestration for the pipeline runtime.
 *
 * Extracted from `pipeline-runtime.ts` (DZUPAGENT-ARCH-M-06). Holds the
 * checkpoint-driven entry paths that decide *where* a partially-completed run
 * re-enters the graph and then hand off to the executor:
 *
 *  - `restoreRunContextFromCheckpoint` — rebuild the mutable
 *    {@link PipelineRunContext} (run state + per-node bookkeeping) from a
 *    checkpoint, shared by both resume and redeliver.
 *  - `resumeFromCheckpoint` — the mid-flight-loop / mid-flight-fork /
 *    restart-node / suspend-point cascade.
 *  - `redeliverFromCheckpoint` — restart-from-entry at-least-once redelivery.
 *  - `failReplayBudgetExceeded` — shared terminal for `maxReplayNodes` breaches.
 *
 * The runtime passes a {@link ResumeHost} facade exposing exactly the state
 * mutations, event emission, executor hand-off, and resume-planner helpers
 * these paths need — behaviour is byte-for-byte identical to the original
 * in-class implementation.
 *
 * @module pipeline/pipeline-runtime-lifecycle/resume-orchestrator
 */

import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
import type {
  ForkRuntimeState,
  NodeResult,
  PipelineRunContext,
  PipelineRunResult,
  PipelineRuntimeConfig,
} from "../pipeline-runtime-types.js";

/**
 * Facade the resume/redeliver paths use over the owning runtime. Kept narrow
 * so the orchestration stays testable and free of the runtime's other
 * lifecycle concerns.
 */
export interface ResumeHost {
  readonly config: PipelineRuntimeConfig;
  readonly eventLog: PipelineRunContext["eventLog"];

  assertRuntimeToolReadiness(): void;
  setState(next: "running" | "completed" | "failed"): void;
  setRecoveryAttemptsUsed(count: number): void;

  emitStarted(runId: string): void;
  emitCompleted(runId: string, durationMs: number): void;
  emitFailed(runId: string, message: string): void;

  /** Delegate the graph walk, translating thrown errors into a failed result. */
  runFromNode(ctx: PipelineRunContext): Promise<PipelineRunResult>;

  /** Look up a node id in the runtime's node map. */
  hasNode(nodeId: string): boolean;
  /** Resolve the node(s) after `nodeId` (traversal-time edge resolution). */
  getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[];

  findMidFlightLoopNodeId(
    loopState: Record<string, { iteration: number }>,
    completedNodeIds: string[]
  ): string | undefined;
  findMidFlightForkNodeId(
    forkState: Record<string, { branches: Record<string, unknown> }>
  ): string | undefined;
  findRestartNodeId(
    completedNodeIds: string[],
    runState: Record<string, unknown>
  ): string | undefined;
  countReplayNodesFrom(
    startNodeId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[]
  ): number;
}

interface RestoredContext {
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: Record<string, { iteration: number }>;
  forkState: ForkRuntimeState;
}

/**
 * Rebuild the mutable run context from a checkpoint. `hydrateCompleted`
 * controls whether the restored `completedNodeIds` are pre-seeded with
 * placeholder node results (resume) or left empty for a from-entry redelivery.
 */
export function restoreRunContextFromCheckpoint(
  checkpoint: PipelineCheckpoint,
  additionalState: Record<string, unknown> | undefined,
  options: { hydrateCompleted: boolean }
): RestoredContext {
  const runState: Record<string, unknown> = {
    ...checkpoint.state,
    ...additionalState,
  };
  const nodeResults = new Map<string, NodeResult>();
  // Restore recorded idempotency keys so resumed runs keep stable keys.
  const nodeIdempotencyKeys: Record<string, string> = {
    ...checkpoint.nodeIdempotencyKeys,
  };

  if (options.hydrateCompleted) {
    const completedNodeIds = [...checkpoint.completedNodeIds];
    // Restore the loop iteration cursor so a mid-loop crash resumes from the
    // next iteration rather than restarting the loop (W3).
    const loopState: Record<string, { iteration: number }> = {
      ...checkpoint.loopState,
    };
    // Restore per-fork branch progress so a mid-fork crash re-runs only
    // unfinished branches rather than the whole fork (W4).
    const forkState: ForkRuntimeState = structuredClone(
      checkpoint.forkState ?? {}
    );

    // Mark completed nodes in results (with placeholder results)
    for (const nodeId of completedNodeIds) {
      nodeResults.set(nodeId, { nodeId, output: null, durationMs: 0 });
    }

    return {
      runId: checkpoint.pipelineRunId,
      runState,
      nodeResults,
      completedNodeIds,
      nodeIdempotencyKeys,
      loopState,
      forkState,
    };
  }

  return {
    runId: checkpoint.pipelineRunId,
    runState,
    nodeResults,
    completedNodeIds: [],
    nodeIdempotencyKeys,
    loopState: {},
    forkState: {},
  };
}

/** Shared terminal for a `resume.maxReplayNodes` budget breach. */
export function failReplayBudgetExceeded(
  host: ResumeHost,
  args: {
    runId: string;
    nodeResults: Map<string, NodeResult>;
    replayNodeCount: number;
    maxReplayNodes: number;
    startTime: number;
  }
): PipelineRunResult {
  const errorMessage =
    `Resume replay budget exceeded: ${args.replayNodeCount} nodes would replay, ` +
    `maxReplayNodes is ${args.maxReplayNodes}.`;
  host.setState("failed");
  host.emitFailed(args.runId, errorMessage);
  return {
    pipelineId: host.config.definition.id,
    runId: args.runId,
    state: "failed",
    nodeResults: args.nodeResults,
    totalDurationMs: Date.now() - args.startTime,
  };
}

/** Resume execution from a checkpoint (the full re-entry cascade). */
export async function resumeFromCheckpoint(
  host: ResumeHost,
  checkpoint: PipelineCheckpoint,
  additionalState?: Record<string, unknown>
): Promise<PipelineRunResult> {
  host.assertRuntimeToolReadiness();

  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
  } = restoreRunContextFromCheckpoint(checkpoint, additionalState, {
    hydrateCompleted: true,
  });

  host.setState("running");
  // Restore recovery budget so limits are enforced across process restarts
  host.setRecoveryAttemptsUsed(checkpoint.recoveryAttemptsUsed ?? 0);
  host.emitStarted(runId);

  const startTime = Date.now();

  const runCtx = (startNodeId: string): PipelineRunContext => ({
    startNodeId,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    eventLog: host.eventLog,
    versionTracker: { version: checkpoint.version },
    startTime,
  });

  // Mid-loop crash (W3): no suspend point, but a loop cursor is in flight.
  // Re-enter at that loop node; `dispatchLoop` reads the cursor and resumes
  // from the next iteration. The loop node is not in `completedNodeIds`
  // (only added when the loop finishes), so it will not be skipped.
  const midFlightLoopId = host.findMidFlightLoopNodeId(
    loopState,
    completedNodeIds
  );
  if (!checkpoint.suspendedAtNodeId && midFlightLoopId) {
    return host.runFromNode(runCtx(midFlightLoopId));
  }

  // Mid-fork crash (W4): no suspend point, but a fork has surviving branch
  // progress. Re-enter at that fork node; dispatchFork restores completed
  // branches and re-runs only the unfinished ones. The fork node is not in
  // completedNodeIds until the join completes, so it is not skipped.
  const midFlightForkId = host.findMidFlightForkNodeId(forkState);
  if (!checkpoint.suspendedAtNodeId && !midFlightLoopId && midFlightForkId) {
    return host.runFromNode(runCtx(midFlightForkId));
  }

  if (!checkpoint.suspendedAtNodeId) {
    const restartNodeId = host.findRestartNodeId(completedNodeIds, runState);
    const restartPolicy = host.config.definition.resume?.onProcessRestart;
    if (
      restartNodeId &&
      (restartPolicy === "resume_from_checkpoint" ||
        restartPolicy === "redeliver_running")
    ) {
      const budgetResult = enforceReplayBudget(host, {
        startNodeId: restartNodeId,
        runId,
        runState,
        completedNodeIds,
        nodeResults,
        startTime,
      });
      if (budgetResult) return budgetResult;
      return host.runFromNode(runCtx(restartNodeId));
    }
    // No suspension point and no mid-flight loop — nothing to resume
    host.setState("completed");
    host.emitCompleted(runId, 0);
    return {
      pipelineId: host.config.definition.id,
      runId,
      state: "completed",
      nodeResults,
      totalDurationMs: 0,
    };
  }

  // Find the node after the suspend point
  if (!host.hasNode(checkpoint.suspendedAtNodeId)) {
    throw new Error(
      `Suspended node "${checkpoint.suspendedAtNodeId}" not found`
    );
  }

  // Get next node(s) after the suspended node
  const nextNodeIds = host.getNextNodeIds(
    checkpoint.suspendedAtNodeId,
    runState
  );

  if (nextNodeIds.length === 0) {
    // Suspend was terminal
    host.setState("completed");
    const totalMs = Date.now() - startTime;
    host.emitCompleted(runId, totalMs);
    return {
      pipelineId: host.config.definition.id,
      runId,
      state: "completed",
      nodeResults,
      totalDurationMs: totalMs,
    };
  }

  const budgetResult = enforceReplayBudget(host, {
    startNodeId: nextNodeIds[0]!,
    runId,
    runState,
    completedNodeIds,
    nodeResults,
    startTime,
  });
  if (budgetResult) return budgetResult;

  // Continue from the first next node — `runFromNode` translates any
  // executor-thrown error into a failed run result, matching the
  // original outer try/catch semantics.
  return host.runFromNode(runCtx(nextNodeIds[0]!));
}

/** Restart-from-entry at-least-once redelivery from a checkpoint. */
export async function redeliverFromCheckpoint(
  host: ResumeHost,
  checkpoint: PipelineCheckpoint,
  additionalState?: Record<string, unknown>
): Promise<PipelineRunResult> {
  host.assertRuntimeToolReadiness();

  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
  } = restoreRunContextFromCheckpoint(checkpoint, additionalState, {
    hydrateCompleted: false,
  });
  const startNodeId = host.config.definition.entryNodeId;
  const startTime = Date.now();

  const budgetResult = enforceReplayBudget(host, {
    startNodeId,
    runId,
    runState,
    completedNodeIds,
    nodeResults,
    startTime,
  });
  if (budgetResult) return budgetResult;

  host.setState("running");
  host.setRecoveryAttemptsUsed(checkpoint.recoveryAttemptsUsed ?? 0);
  host.emitStarted(runId);

  return host.runFromNode({
    startNodeId,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    eventLog: host.eventLog,
    versionTracker: { version: checkpoint.version },
    startTime,
  });
}

/**
 * Enforce the `resume.maxReplayNodes` budget for a re-entry at `startNodeId`.
 * Returns a failed `PipelineRunResult` when the budget is exceeded, or
 * `undefined` when the resume may proceed (no budget set, or within it).
 */
function enforceReplayBudget(
  host: ResumeHost,
  args: {
    startNodeId: string;
    runId: string;
    runState: Record<string, unknown>;
    completedNodeIds: string[];
    nodeResults: Map<string, NodeResult>;
    startTime: number;
  }
): PipelineRunResult | undefined {
  const maxReplayNodes = host.config.definition.resume?.maxReplayNodes;
  if (maxReplayNodes === undefined) return undefined;

  const replayNodeCount = host.countReplayNodesFrom(
    args.startNodeId,
    args.runState,
    args.completedNodeIds
  );
  if (replayNodeCount > maxReplayNodes) {
    return failReplayBudgetExceeded(host, {
      runId: args.runId,
      nodeResults: args.nodeResults,
      replayNodeCount,
      maxReplayNodes,
      startTime: args.startTime,
    });
  }
  return undefined;
}
