import type {
  PipelineCheckpoint,
  PipelineCheckpointEventRecord,
  PipelineCheckpointExecutionLog,
  PipelineCheckpointProviderSessionRef,
} from "@dzupagent/core/pipeline";
import { omitUndefined } from "../../utils/exact-optional.js";

export function createPipelineCheckpoint(options: {
  pipelineRunId: string;
  pipelineId: string;
  version: number;
  completedNodeIds: string[];
  state: Record<string, unknown>;
  suspendedAtNodeId?: string;
  recoveryAttemptsUsed?: number;
  /** Stable `nodeId` → idempotency key map for completed nodes (W5). */
  nodeIdempotencyKeys?: Record<string, string>;
  /** Per-loop-node iteration cursor for durable loop resume (W3). */
  loopState?: Record<string, { iteration: number }>;
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
}): PipelineCheckpoint {
  return omitUndefined({
    pipelineRunId: options.pipelineRunId,
    pipelineId: options.pipelineId,
    version: options.version,
    schemaVersion: "1.0.0",
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
