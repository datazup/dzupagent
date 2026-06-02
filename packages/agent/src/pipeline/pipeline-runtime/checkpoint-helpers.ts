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
    state: structuredClone(options.state),
    suspendedAtNodeId: options.suspendedAtNodeId,
    recoveryAttemptsUsed: options.recoveryAttemptsUsed,
    createdAt: new Date().toISOString(),
  });
}
