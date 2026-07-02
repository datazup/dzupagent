/**
 * Node idempotency keys (W5).
 *
 * A node's idempotency key is deterministic for a given node execution within a
 * run, so the same node in the same run always produces the same key — across
 * process restarts and resumes. The key is exposed to node implementations via
 * `NodeExecutionContext.idempotencyKey` and recorded in the checkpoint
 * (`PipelineCheckpoint.nodeIdempotencyKeys`) so downstream stores can dedup a
 * node's external side effects when a crash occurred after the effect ran but
 * before the completion checkpoint persisted.
 *
 * The key is materialized with the canonical {@link materializeIdempotencyKey}
 * from `@dzupagent/runtime-contracts` (OQ-2), so the runtime and the
 * flow-compiler evidence layer produce byte-identical keys for the same node
 * execution. The canonical template is
 * `dzup:v1:{sourceHash}:{runId}:{nodeId}:{attemptPolicy}:{inputDigest}`.
 *
 * N3b threads the real `sourceHash`, `attemptPolicy`, and `input` values
 * through {@link nodeIdempotencyKey} so keys are collision-proof across flow
 * versions and distinct node inputs — not just unique per `(runId, nodeId)`.
 * See {@link nodeIdempotencyKey} for what each field carries and the one
 * placeholder that remains.
 *
 * @module pipeline/pipeline-runtime/idempotency
 */

import {
  canonicalInputDigest,
  materializeIdempotencyKey,
} from "@dzupagent/runtime-contracts";
import type { PipelineNode } from "@dzupagent/core/pipeline";

/**
 * Default attempt policy for a node that has not declared a stricter delivery
 * contract. `at-least-once` is the runtime's standard semantics: a node may run
 * more than once across crashes/resumes, so consumers must dedup on the key.
 */
const ATTEMPT_POLICY_DEFAULT = "at-least-once";

/**
 * Optional context for deriving a fully-qualified canonical idempotency key.
 *
 * Every field is optional so existing `nodeIdempotencyKey(runId, nodeId)`
 * call sites keep compiling and producing stable keys. When a field is omitted
 * it falls back to a deterministic default, so the produced key stays stable
 * and collision-free for a given `(runId, nodeId)` even with no extra context.
 */
export interface NodeIdempotencyKeyContext {
  /**
   * The compiled flow definition (or any stable structural value) whose
   * canonical digest becomes the key's `sourceHash` — the flow fingerprint.
   * Passing the definition makes the key change when the flow structure
   * changes (across flow versions). When omitted, `sourceHash` is empty: the
   * `runId` is already globally unique, so the fingerprint is not required for
   * collision-freedom, only for cross-version disambiguation.
   */
  flowDefinition?: unknown;
  /**
   * The node's delivery / attempt policy
   * (`'idempotent' | 'at-least-once' | 'exactly-once-required'`). Read from the
   * node when available; defaults to `at-least-once`.
   */
  attemptPolicy?: string;
  /**
   * The node's input value, hashed into the key's input digest. Two executions
   * of the same node with different inputs therefore get different keys. When
   * omitted, the digest is the canonical digest of the empty object (a fixed
   * constant that does not perturb the key).
   */
  input?: unknown;
  /**
   * W1: a declared idempotency key lowered from the DSL
   * (`meta.mutation.idempotencyKey`). When a non-empty string it WINS — the
   * returned key is the namespaced declared key (`dzup:v1:declared:{k}`) and the
   * canonical derivation is bypassed entirely. Absent ⇒ derived key, unchanged.
   */
  declaredKey?: string;
}

/**
 * Build the stable idempotency key for a node execution within a run.
 *
 * Delegates to the canonical {@link materializeIdempotencyKey} so the runtime
 * and the flow-compiler evidence layer emit identical keys. The output follows
 * the canonical template
 * `dzup:v1:{sourceHash}:{runId}:{nodeId}:{attemptPolicy}:{inputDigest}`.
 *
 * The result is deterministic for a given `(runId, nodeId, sourceHash,
 * attemptPolicy, input)` tuple. `runId` is globally unique and `nodeId` is
 * unique within a pipeline definition, so even with no extra `context` the
 * `(runId, nodeId)` pair alone yields a stable, collision-free key. Supplying
 * `context` additionally makes the key vary across flow versions
 * (`flowDefinition`), delivery contracts (`attemptPolicy`), and distinct node
 * inputs (`input`).
 *
 * N3b note: of the five canonical fields, only `sourceHash` is best-effort —
 * if `flowDefinition` is not threaded at a given call site it degrades to the
 * empty string, which is harmless because `runId` already guarantees
 * uniqueness. `attemptPolicy` and `input` are now real.
 */
export function nodeIdempotencyKey(
  runId: string,
  nodeId: string,
  context: NodeIdempotencyKeyContext = {},
): string {
  // W1: a declared key from the DSL wins — namespaced so it can never collide
  // with the derived `dzup:v1:{sourceHash}:...` key space. Deterministic across
  // dispatch-time and record-time because it rides in the same context both
  // times. Absent ⇒ fall through to the canonical derivation (unchanged).
  const declared = context.declaredKey;
  if (typeof declared === "string" && declared.length > 0) {
    return `dzup:v1:declared:${declared}`;
  }

  return materializeIdempotencyKey({
    sourceHash:
      context.flowDefinition === undefined
        ? ""
        : canonicalInputDigest(context.flowDefinition),
    runId,
    nodeId,
    attemptPolicy: context.attemptPolicy ?? ATTEMPT_POLICY_DEFAULT,
    input: context.input ?? {},
  });
}

/**
 * Derive the canonical-key `attemptPolicy` and `input` for a runtime node.
 *
 * - `attemptPolicy`: read from the node's typed `idempotency` field (the flow-ast
 *   `NodeIdempotencyMode`: `'idempotent' | 'at-least-once' |
 *   'exactly-once-required'`), lowered onto `PipelineNodeBase` by W1; when absent
 *   it defaults to `at-least-once`.
 * - `declaredKey`: read from the node's `declaredIdempotencyKey` (W1). When a
 *   non-empty string it is threaded through so {@link nodeIdempotencyKey}
 *   short-circuits to the namespaced declared key.
 * - `input`: the node's *static configured input*, not the live mutable run
 *   state. The key is computed at dispatch time and again when the completion
 *   is recorded; using live state would let the two diverge if the node mutates
 *   state mid-execution. The node's own input-bearing fields
 *   (`AgentNode.config`, `ToolNode.arguments`) are stable across both points
 *   and still vary across distinct node inputs.
 *
 * Returns a {@link NodeIdempotencyKeyContext} suitable for spreading the
 * `flowDefinition` onto before passing to {@link nodeIdempotencyKey}.
 */
export function nodeIdempotencyContext(
  node: PipelineNode,
): Pick<NodeIdempotencyKeyContext, "attemptPolicy" | "input" | "declaredKey"> {
  const attemptPolicy =
    typeof node.idempotency === "string"
      ? node.idempotency
      : ATTEMPT_POLICY_DEFAULT;

  // W1: a declared idempotency key from the DSL, when present, short-circuits
  // the derivation in `nodeIdempotencyKey`. Only a non-empty string counts.
  const declaredKey =
    typeof node.declaredIdempotencyKey === "string" &&
    node.declaredIdempotencyKey.length > 0
      ? node.declaredIdempotencyKey
      : undefined;

  // Static, drift-free per-node input. `config`/`arguments` are the only
  // input-bearing fields on the canonical node union; absent fields hash to the
  // empty-object digest (a fixed constant), so a config-less node is unchanged.
  const input: Record<string, unknown> = {};
  if ("config" in node && node.config !== undefined) {
    input.config = node.config;
  }
  if ("arguments" in node && node.arguments !== undefined) {
    input.arguments = node.arguments;
  }

  return declaredKey === undefined
    ? { attemptPolicy, input }
    : { attemptPolicy, input, declaredKey };
}
