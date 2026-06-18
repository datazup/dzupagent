/**
 * Canonical idempotency-key utilities (OQ-2).
 *
 * Both the flow-compiler (evidence layer) and the pipeline runtime use
 * these functions to produce identical stable keys for a given node
 * execution -- so compiled diagnostics and runtime enforcement agree.
 *
 * Implementation note on typing: `@dzupagent/runtime-contracts` keeps
 * `types: []` and `lib: ["ES2022"]` (no `@types/node`, no `dom`) so it stays
 * environment-neutral for browser/edge consumers. To use Node's built-in
 * `node:crypto` without pulling the entire `@types/node` surface into the
 * package, we declare the minimal structural shape we depend on below. At
 * runtime the import resolves to the real Node module; environments without
 * `node:crypto` simply must not call these functions.
 *
 * @module runtime-contracts/idempotency
 */

import { createHash } from "node:crypto";

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
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Recursively rebuild `value` so every plain object has its keys in sorted
 * order. Returned values are fed straight into `JSON.stringify`, so any
 * `undefined` / function entries are dropped by `JSON.stringify` exactly as
 * they would be for the original input.
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
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
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
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
}): string {
  const inputDigest = canonicalInputDigest(params.input);
  return `dzup:v1:${params.sourceHash}:${params.runId}:${params.nodeId}:${params.attemptPolicy}:${inputDigest}`;
}
