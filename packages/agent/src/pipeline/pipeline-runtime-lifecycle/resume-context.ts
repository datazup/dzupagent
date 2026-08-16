import type {
  PipelineCheckpoint,
  PipelineCheckpointSourceBinding,
} from "@dzupagent/core/pipeline";
import type {
  PipelineInteractionResumeV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "@dzupagent/runtime-contracts";

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
  /** Per-loop item-source digests recorded on the checkpoint's binding (E3). */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor: PipelineCheckpoint["interactionResumeCursor"];
}

/**
 * Reject a resume whose checkpoint was produced from a different artifact (E3,
 * defect 1).
 *
 * Without this, `{ ...checkpoint.state, ...additionalState }` below overlays
 * caller state with no re-validation, so replacing the pipeline definition —
 * or reordering a `for_each` source — silently admits a resume whose retained
 * ordered prefix no longer refers to the items it was computed from.
 *
 * Absence is deliberately treated as **unprovable, not agreement**: a
 * checkpoint written before E3 carries no binding and must keep resuming, so
 * only a binding that is present *and* disagrees is a rejection. The same rule
 * applies per loop — a loop with no recorded source digest is unbound, not
 * matched.
 *
 * Fail-closed by design. The alternative on a `for_each` mismatch (restart the
 * loop from item 0) re-executes body nodes whose side effects already
 * committed, which is the exact failure this packet exists to close; a
 * stranded run is operator-recoverable, a double-charged item is not.
 */
export function assertCheckpointSourceBinding(
  checkpoint: PipelineCheckpoint,
  expected: PipelineCheckpointSourceBinding | undefined
): void {
  const recorded = checkpoint.sourceBinding;
  if (recorded === undefined || expected === undefined) return;

  if (recorded.definitionDigest !== expected.definitionDigest) {
    throw new PipelineSourceBindingMismatchError(
      `Cannot resume run "${checkpoint.pipelineRunId}": the checkpoint was ` +
        `produced from pipeline definition ${recorded.definitionDigest}, but ` +
        `the definition supplied for resume is ${expected.definitionDigest}. ` +
        "Resuming would replay completed work against a different artifact.",
    );
  }

  const recordedLoops = recorded.loopSourceDigests;
  const expectedLoops = expected.loopSourceDigests;
  if (recordedLoops === undefined || expectedLoops === undefined) return;
  for (const [loopNodeId, digest] of Object.entries(recordedLoops)) {
    const current = expectedLoops[loopNodeId];
    // An absent current digest is unbound (the loop has not re-resolved its
    // source yet), not a mismatch.
    if (current !== undefined && current !== digest) {
      throw new PipelineSourceBindingMismatchError(
        `Cannot resume run "${checkpoint.pipelineRunId}": loop "${loopNodeId}" ` +
          `checkpointed against item source ${digest}, but the source now ` +
          `resolves to ${current}. The retained ordered prefix would refer to ` +
          "different items.",
      );
    }
  }
}

/** A resume was rejected because its checkpoint binds to a different artifact. */
export class PipelineSourceBindingMismatchError extends Error {
  override readonly name = "PipelineSourceBindingMismatchError";
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
      ...(checkpoint.sourceBinding?.loopSourceDigests === undefined
        ? {}
        : {
            loopSourceDigests: {
              ...checkpoint.sourceBinding.loopSourceDigests,
            },
          }),
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
