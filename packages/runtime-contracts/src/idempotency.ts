/**
 * Canonical idempotency-key utilities (OQ-2).
 *
 * Both the flow-compiler (evidence layer) and the pipeline runtime use
 * these functions to produce identical stable keys for a given node
 * execution -- so compiled diagnostics and runtime enforcement agree.
 *
 * Implementation note: the canonical JSON algorithm lives in
 * `@dzupagent/canonical-json` (the `idempotency-v1` preset is this module's
 * historical `sortedJsonV1` scheme, extracted by ARCH27-T-13 and pinned
 * byte-for-byte by that package's golden vectors). This module keeps its
 * public surface (`CANONICAL_JSON_VERSION`, `canonicalJson`,
 * `canonicalInputDigest`) as thin delegations so consumers and persisted
 * digests are unaffected. Environments without `node:crypto` simply must
 * not call the digest functions.
 *
 * @module runtime-contracts/idempotency
 */

import { sha256Hex, sortedJsonV1Stringify } from "@dzupagent/canonical-json";

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Produce a canonical JSON string for `value` with object keys sorted
 * recursively, so key insertion order does not affect the output. Arrays
 * preserve order (order is semantically meaningful for arrays). Primitive
 * values, `null`, and booleans serialize via `JSON.stringify`.
 *
 * Pure function -- no I/O, no side effects.
 */
export const CANONICAL_JSON_VERSION = "dzupagent.sorted-json/v1" as const;

export function canonicalJson(value: unknown): string {
  return sortedJsonV1Stringify(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic SHA-256 hex digest of the canonical JSON
 * representation of `input`. Sorts object keys recursively so key
 * insertion order does not affect the digest.
 *
 * Pure function -- no I/O, no side effects.
 */
export function canonicalInputDigest(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/**
 * Identity of one durable unit of loop work, folded into the key space.
 *
 * A `for_each` body node derives the same `(runId, nodeId)` for every item, so
 * without a scope every item of a loop shares one idempotency key: the first
 * item claims it and the rest replay that item's result. This makes each item
 * its own durable unit.
 *
 * Structurally mirrors `PipelineExecutionScope` in `@dzupagent/core/pipeline`,
 * restated here because `runtime-contracts` sits below core in the dependency
 * order and must stay environment-neutral.
 */
export interface IdempotencyExecutionScope {
  /** Loop node this scope belongs to. */
  loopNodeId: string;
  /** Zero-based index into the resolved `for_each` source. */
  itemIndex: number;
  /** Body node being executed within the item, when scoped to one. */
  bodyNodeId?: string;
  /** Attempt counter, so a retry is distinguishable from the first attempt. */
  attempt?: number;
}

/**
 * Render an execution scope as a key segment.
 *
 * `bodyNodeId` and `attempt` are appended only when present, so adding a scope
 * without them produces the shortest form that still separates items. The
 * segment is prefixed `item:` so it can never be confused with a digest.
 */
function scopeSegment(scope: IdempotencyExecutionScope): string {
  let segment = `item:${scope.loopNodeId}:${scope.itemIndex}`;
  if (scope.bodyNodeId !== undefined) segment += `:${scope.bodyNodeId}`;
  if (scope.attempt !== undefined) segment += `:attempt:${scope.attempt}`;
  return segment;
}

/**
 * Materialize a full idempotency key for a node execution.
 *
 * Template: `dzup:v1:{sourceHash}:{runId}:{nodeId}:{attemptPolicy}:{canonicalInputDigest}`
 *
 * - `sourceHash`    -- SHA-256 of the compiled flow source (flow fingerprint)
 * - `runId`         -- the run's stable ID
 * - `nodeId`        -- the node's stable ID within the flow
 * - `attemptPolicy` -- `'at-least-once' | 'exactly-once-required' | 'idempotent'`
 * - `input`         -- the node's input value (hashed via canonicalInputDigest)
 * - `scope`         -- optional `for_each` execution scope (E2)
 *
 * When `scope` is present the scope segment is appended, giving each loop item
 * its own key. When it is absent the key is byte-identical to the pre-E2 form:
 * this is load-bearing, because a changed key for an unscoped node would
 * invalidate every in-flight run's ledger entries.
 *
 * The returned key is intentionally left human-readable (the whole key is
 * not re-hashed) so it remains useful for debugging and log correlation.
 */
export function materializeIdempotencyKey(params: {
  sourceHash: string;
  runId: string;
  nodeId: string;
  attemptPolicy: string;
  input: unknown;
  scope?: IdempotencyExecutionScope;
}): string {
  const inputDigest = canonicalInputDigest(params.input);
  const base = `dzup:v1:${params.sourceHash}:${params.runId}:${params.nodeId}:${params.attemptPolicy}:${inputDigest}`;
  return params.scope === undefined
    ? base
    : `${base}:${scopeSegment(params.scope)}`;
}
