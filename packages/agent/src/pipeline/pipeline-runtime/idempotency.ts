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
 * The key is materialized with the canonical {@link materializeIdempotencyKey}
 * from `@dzupagent/runtime-contracts` (OQ-2), so the runtime and the
 * flow-compiler evidence layer produce byte-identical keys for the same node
 * execution. See {@link nodeIdempotencyKey} for the placeholders used to keep
 * the existing `(runId, nodeId)` signature stable.
 *
 * @module pipeline/pipeline-runtime/idempotency
 */

import { materializeIdempotencyKey } from "@dzupagent/runtime-contracts";

/**
 * Stable placeholders for the canonical-key fields that are not yet threaded
 * through the runtime's `(runId, nodeId)` key signature.
 *
 * NOTE (N3): the canonical {@link materializeIdempotencyKey} accepts
 * `sourceHash`, `attemptPolicy`, and `input`, but those are not available at
 * this call signature today (the runtime keys a node purely by `runId`/`nodeId`
 * and many tests assert against `nodeIdempotencyKey(runId, nodeId)`). Until they
 * are threaded through, we pin them to deterministic constants so the produced
 * key stays stable and collision-free for a given `(runId, nodeId)`:
 *
 * - `sourceHash` is left empty; `runId` is already globally unique, so the
 *   flow fingerprint is not required for collision-freedom here.
 * - `attemptPolicy` defaults to `at-least-once` (the runtime's current
 *   delivery contract for a node that has not opted into stricter semantics).
 * - `input` is the empty object, so the canonical input digest is a fixed
 *   constant and does not perturb the key.
 */
const SOURCE_HASH_PLACEHOLDER = "";
const ATTEMPT_POLICY_DEFAULT = "at-least-once";

/**
 * Build the stable idempotency key for a node execution within a run.
 *
 * Delegates to the canonical {@link materializeIdempotencyKey} so the runtime
 * and the flow-compiler evidence layer emit identical keys. The output follows
 * the canonical template
 * `dzup:v1:{sourceHash}:{runId}:{nodeId}:{attemptPolicy}:{inputDigest}`.
 *
 * The result is deterministic for a given `(runId, nodeId)` pair: `runId` is
 * globally unique and `nodeId` is unique within a pipeline definition, so the
 * pair is a stable, collision-free key for a given node execution in a run.
 */
export function nodeIdempotencyKey(runId: string, nodeId: string): string {
  return materializeIdempotencyKey({
    sourceHash: SOURCE_HASH_PLACEHOLDER,
    runId,
    nodeId,
    attemptPolicy: ATTEMPT_POLICY_DEFAULT,
    input: {},
  });
}
