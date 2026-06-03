/**
 * Node idempotency keys (W5).
 *
 * A node's idempotency key is deterministic for a given `(runId, nodeId)` pair,
 * so the same node in the same run always produces the same key — across
 * process restarts and resumes. The key is exposed to node implementations via
 * `NodeExecutionContext.idempotencyKey` and recorded in the checkpoint
 * (`PipelineCheckpoint.nodeIdempotencyKeys`) so downstream stores can dedup a
 * node's external side effects when a crash occurred after the effect ran but
 * before the completion checkpoint persisted.
 *
 * @module pipeline/pipeline-runtime/idempotency
 */

/**
 * Build the stable idempotency key for a node execution within a run.
 *
 * The format (`<runId>:<nodeId>`) is intentionally simple and human-readable;
 * both components are already unique within their scope (`runId` is globally
 * unique, `nodeId` is unique within a pipeline definition), so the pair is a
 * stable, collision-free key for a given node execution in a given run.
 */
export function nodeIdempotencyKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}
