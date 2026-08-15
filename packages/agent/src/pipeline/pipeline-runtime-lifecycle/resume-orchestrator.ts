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
  NodeResult,
  PipelineRunContext,
  PipelineRunResult,
} from "../pipeline-runtime-types.js";
import {
  restoreRunContextFromCheckpoint,
  type ResumeHost,
} from "./resume-context.js";
import { enforceReplayBudget } from "./replay-budget.js";

export { restoreRunContextFromCheckpoint } from "./resume-context.js";
export type { ResumeHost } from "./resume-context.js";
export { failReplayBudgetExceeded } from "./replay-budget.js";
import {
  validateRetainedLoopBodyGraphCheckpointState,
} from "../loop-body-graph-checkpoint-validator.js";
import { validatePendingInteractionForDefinition } from "../pipeline-interaction-runtime.js";

function failRetainedLoopControl(
  host: ResumeHost,
  runId: string,
  nodeResults: Map<string, NodeResult>,
  startTime: number,
  detail: string
): PipelineRunResult {
  const message = `Corrupt retained nested loop control: ${detail}`;
  host.setState("failed");
  host.emitFailed(runId, message);
  return {
    pipelineId: host.config.definition.id,
    runId,
    state: "failed",
    nodeResults,
    totalDurationMs: Date.now() - startTime,
  };
}

/** Resume execution from a checkpoint (the full re-entry cascade). */
export async function resumeFromCheckpoint(
  host: ResumeHost,
  checkpoint: PipelineCheckpoint,
  additionalState?: Record<string, unknown>
): Promise<PipelineRunResult> {
  if (checkpoint.pendingInteraction !== undefined) {
    const { pending } = validatePendingInteractionForDefinition(
      host.config.definition,
      checkpoint,
    );
    host.setState("suspended");
    const nodeResults = new Map<string, NodeResult>();
    for (const nodeId of checkpoint.completedNodeIds) {
      nodeResults.set(nodeId, { nodeId, output: null, durationMs: 0 });
    }
    return {
      pipelineId: host.config.definition.id,
      runId: checkpoint.pipelineRunId,
      state: "suspended",
      nodeResults,
      totalDurationMs: 0,
      pendingInteraction: pending,
    };
  }
  if (checkpoint.interactionResumeCursor !== undefined) {
    host.assertInteractionResumeCursorValid(checkpoint);
  }
  host.assertRuntimeToolReadiness();

  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    pendingInteraction,
    interactionReceipts,
    interactionResumeCursor,
  } = restoreRunContextFromCheckpoint(checkpoint, additionalState, {
    hydrateCompleted: true,
  });

  host.setState("running");
  // Restore recovery budget so limits are enforced across process restarts
  host.setRecoveryAttemptsUsed(checkpoint.recoveryAttemptsUsed ?? 0);
  host.setBudgetCostCents(checkpoint.budgetState?.costCents ?? 0);
  host.emitStarted(runId);

  const startTime = Date.now();
  const versionTracker = { version: checkpoint.version };

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
    versionTracker,
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    interactionReceipts,
    ...(interactionResumeCursor === undefined
      ? {}
      : { interactionResumeCursor }),
    startTime,
  });

  if (interactionResumeCursor !== undefined) {
    const startNodeId = interactionResumeCursor.nextNodeId;
    if (startNodeId === undefined) {
      host.setState("completed");
      host.emitCompleted(runId, 0);
      await host.finalizeInteractionResume(
        runCtx(interactionResumeCursor.nodeId),
      );
      return {
        pipelineId: host.config.definition.id,
        runId,
        state: "completed",
        nodeResults,
        totalDurationMs: 0,
      };
    }
    if (!host.hasNode(startNodeId)) {
      throw new Error(`Interaction resume node "${startNodeId}" not found`);
    }
    const ctx = runCtx(startNodeId);
    const result = await host.runFromNode(ctx);
    if (result.state === "completed") {
      await host.finalizeInteractionResume(ctx);
    }
    return result;
  }

  const retainedOutcomes = Object.entries(loopState).filter(
    ([, cursor]) => cursor.bodyGraphState?.outcome !== undefined
  );
  if (retainedOutcomes.length > 1) {
    return failRetainedLoopControl(
      host,
      runId,
      nodeResults,
      startTime,
      "multiple nested loop outcomes are retained"
    );
  }
  const retainedOutcome = retainedOutcomes[0];
  if (retainedOutcome !== undefined) {
    const [loopNodeId, cursor] = retainedOutcome;
    const graphState = cursor.bodyGraphState!;
    try {
      validateRetainedLoopBodyGraphCheckpointState(
        host.config.definition,
        loopNodeId,
        graphState
      );
    } catch (error) {
      return failRetainedLoopControl(
        host,
        runId,
        nodeResults,
        startTime,
        error instanceof Error ? error.message : String(error)
      );
    }
    const outcome = graphState.outcome!;
    if (outcome.kind === "normal") {
      if (
        checkpoint.suspendedAtNodeId !== undefined ||
        completedNodeIds.includes(loopNodeId)
      ) {
        return failRetainedLoopControl(
          host,
          runId,
          nodeResults,
          startTime,
          `nested normal outcome for loop "${loopNodeId}" has an invalid outer checkpoint marker`
        );
      }
      // The scoped executor saved its normal exit immediately before the loop
      // iteration boundary. The ordinary mid-flight-loop path below re-enters
      // the loop and consumes this already-completed body without redispatch.
    } else if (outcome.kind === "suspended") {
      if (
        checkpoint.suspendedAtNodeId !== loopNodeId ||
        completedNodeIds.includes(loopNodeId)
      ) {
        return failRetainedLoopControl(
          host,
          runId,
          nodeResults,
          startTime,
          `nested suspended outcome for loop "${loopNodeId}" has an invalid outer checkpoint marker`
        );
      }
      const budgetResult = enforceReplayBudget(host, {
        startNodeId: loopNodeId,
        runId,
        runState,
        completedNodeIds,
        nodeResults,
        startTime,
      });
      if (budgetResult) return budgetResult;
      return host.runFromNode(runCtx(loopNodeId));
    } else if (
      checkpoint.suspendedAtNodeId !== outcome.exitNodeId ||
      !completedNodeIds.includes(loopNodeId)
    ) {
      return failRetainedLoopControl(
        host,
        runId,
        nodeResults,
        startTime,
        `nested terminal outcome for loop "${loopNodeId}" has an invalid outer checkpoint marker`
      );
    } else {
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
  }

  if (
    checkpoint.suspendedAtNodeId !== undefined &&
    loopState[checkpoint.suspendedAtNodeId]?.bodyGraphState !== undefined
  ) {
    return failRetainedLoopControl(
      host,
      runId,
      nodeResults,
      startTime,
      `loop "${checkpoint.suspendedAtNodeId}" is marked suspended without a suspended outcome`
    );
  }

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
  if (
    checkpoint.pendingInteraction !== undefined ||
    checkpoint.interactionResumeCursor !== undefined
  ) {
    return resumeFromCheckpoint(host, checkpoint);
  }
  host.assertRuntimeToolReadiness();

  const {
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    interactionReceipts,
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
  host.setBudgetCostCents(checkpoint.budgetState?.costCents ?? 0);
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
    interactionReceipts,
    startTime,
  });
}
