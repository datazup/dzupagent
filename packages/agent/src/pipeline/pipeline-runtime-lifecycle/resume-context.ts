import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
import type { PipelineInteractionResumeV1, PipelinePendingInteractionV1 } from "@dzupagent/runtime-contracts";

import type {
  ForkRuntimeState,
  NodeResult,
  PipelineRunContext,
  PipelineRunResult,
  PipelineRuntimeConfig,
} from "../pipeline-runtime-types.js";
import type { LoopState } from "../pipeline-runtime/executor-state-types.js";

/** Narrow runtime facade shared by resume orchestration leaf modules. */
export interface ResumeHost {
  readonly config: PipelineRuntimeConfig;
  readonly eventLog: PipelineRunContext["eventLog"];

  assertRuntimeToolReadiness(): void;
  setState(next: "running" | "suspended" | "completed" | "failed"): void;
  setRecoveryAttemptsUsed(count: number): void;
  setBudgetCostCents(costCents: number): void;

  emitStarted(runId: string): void;
  emitCompleted(runId: string, durationMs: number): void;
  emitFailed(runId: string, message: string): void;

  runFromNode(ctx: PipelineRunContext): Promise<PipelineRunResult>;
  finalizeInteractionResume(ctx: PipelineRunContext): Promise<void>;
  assertInteractionResumeCursorValid(checkpoint: PipelineCheckpoint): void;

  hasNode(nodeId: string): boolean;
  getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[];

  findMidFlightLoopNodeId(
    loopState: LoopState,
    completedNodeIds: string[],
  ): string | undefined;
  findMidFlightForkNodeId(
    forkState: Record<string, { branches: Record<string, unknown> }>,
  ): string | undefined;
  findRestartNodeId(
    completedNodeIds: string[],
    runState: Record<string, unknown>,
  ): string | undefined;
  countReplayNodesFrom(
    startNodeId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[],
  ): number;
}

export interface RestoredContext {
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: LoopState;
  forkState: ForkRuntimeState;
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor: PipelineCheckpoint["interactionResumeCursor"];
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
    const loopState = structuredClone(checkpoint.loopState ?? {}) as LoopState;
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
      ...(checkpoint.pendingInteraction === undefined
        ? {}
        : { pendingInteraction: checkpoint.pendingInteraction }),
      interactionReceipts: structuredClone(checkpoint.interactionReceipts ?? {}),
      interactionResumeCursor: checkpoint.interactionResumeCursor === undefined
        ? undefined
        : structuredClone(checkpoint.interactionResumeCursor),
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
    ...(checkpoint.pendingInteraction === undefined
      ? {}
      : { pendingInteraction: checkpoint.pendingInteraction }),
    interactionReceipts: structuredClone(checkpoint.interactionReceipts ?? {}),
    interactionResumeCursor: checkpoint.interactionResumeCursor === undefined
      ? undefined
      : structuredClone(checkpoint.interactionResumeCursor),
  };
}
