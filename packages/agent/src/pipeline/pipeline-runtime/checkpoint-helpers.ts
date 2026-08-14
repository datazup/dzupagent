import type {
  PipelineCheckpoint,
  PipelineCheckpointEventRecord,
  PipelineCheckpointExecutionLog,
  PipelineCheckpointProviderSessionRef,
  PipelineInteractionResumeCursor,
} from "@dzupagent/core/pipeline";
import type {
  PipelineInteractionResumeV1,
  PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";
import { omitUndefined } from "../../utils/exact-optional.js";
import type { LoopState } from "./executor-state-types.js";

export function createPipelineCheckpoint(options: {
  pipelineRunId: string;
  pipelineId: string;
  version: number;
  completedNodeIds: string[];
  state: Record<string, unknown>;
  suspendedAtNodeId?: string;
  /** Canonical cumulative runtime budget snapshot. */
  budgetState?: PipelineCheckpoint["budgetState"];
  recoveryAttemptsUsed?: number;
  /** Stable `nodeId` → idempotency key map for completed nodes (W5). */
  nodeIdempotencyKeys?: Record<string, string>;
  /** Per-loop-node iteration cursor for durable loop resume (W3). */
  loopState?: LoopState;
  /** Per-fork branch progress for durable fork/branch resume (W4). */
  forkState?: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  >;
  events?: PipelineCheckpointEventRecord[] | undefined;
  executionLog?: PipelineCheckpointExecutionLog | undefined;
  providerSessionRefs?: PipelineCheckpointProviderSessionRef[] | undefined;
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts?: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor?: PipelineInteractionResumeCursor;
}): PipelineCheckpoint {
  return omitUndefined({
    pipelineRunId: options.pipelineRunId,
    pipelineId: options.pipelineId,
    version: options.version,
    schemaVersion:
      options.pendingInteraction !== undefined ||
      options.interactionResumeCursor !== undefined ||
      Object.keys(options.interactionReceipts ?? {}).length > 0
        ? "1.1.0"
        : "1.0.0",
    completedNodeIds: [...options.completedNodeIds],
    // Snapshot the map so later mutations don't leak into a saved checkpoint.
    nodeIdempotencyKeys:
      options.nodeIdempotencyKeys &&
      Object.keys(options.nodeIdempotencyKeys).length > 0
        ? { ...options.nodeIdempotencyKeys }
        : undefined,
    loopState:
      options.loopState && Object.keys(options.loopState).length > 0
        ? structuredClone(options.loopState)
        : undefined,
    forkState:
      options.forkState && Object.keys(options.forkState).length > 0
        ? structuredClone(options.forkState)
        : undefined,
    state: structuredClone(options.state),
    suspendedAtNodeId: options.suspendedAtNodeId,
    pendingInteraction: options.pendingInteraction
      ? structuredClone(options.pendingInteraction)
      : undefined,
    interactionReceipts:
      options.interactionReceipts &&
      Object.keys(options.interactionReceipts).length > 0
        ? structuredClone(options.interactionReceipts)
        : undefined,
    interactionResumeCursor: options.interactionResumeCursor
      ? structuredClone(options.interactionResumeCursor)
      : undefined,
    budgetState: options.budgetState
      ? structuredClone(options.budgetState)
      : undefined,
    recoveryAttemptsUsed: options.recoveryAttemptsUsed,
    events:
      options.events && options.events.length > 0
        ? structuredClone(options.events)
        : undefined,
    executionLog: options.executionLog
      ? structuredClone(options.executionLog)
      : undefined,
    providerSessionRefs:
      options.providerSessionRefs && options.providerSessionRefs.length > 0
        ? structuredClone(options.providerSessionRefs)
        : undefined,
    createdAt: new Date().toISOString(),
  });
}
