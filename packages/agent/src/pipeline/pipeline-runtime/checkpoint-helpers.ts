import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
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
    state: structuredClone(options.state),
    suspendedAtNodeId: options.suspendedAtNodeId,
    recoveryAttemptsUsed: options.recoveryAttemptsUsed,
    createdAt: new Date().toISOString(),
  });
}
