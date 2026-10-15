/**
 * Exact-port state writes for a node's successful output.
 *
 * The persisted shape is `PipelineNodeBase.stateWrites` in
 * `@dzupagent/runtime-contracts/pipeline-artifact`, read here through the
 * typed `PipelineNode` so contract drift fails the typecheck. The runtime
 * guards stay: a persisted definition is still untrusted JSON.
 *
 * @module pipeline/executor-internals/state-writes
 */

import type { PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";

export const STATE_WRITE_INVALID = "PIPELINE_STATE_WRITE_INVALID";

export type StateWritePlan =
  | { ok: true; writes: Array<[key: string, value: unknown]> }
  | { ok: false; error: string };

/**
 * Validate every binding against `output` before anything is written.
 * Returns `undefined` when the node declares no state writes.
 */
export function planStateWrites(
  node: Pick<PipelineNode, "id" | "stateWrites">,
  output: unknown,
): StateWritePlan | undefined {
  const policy = node.stateWrites;
  if (policy === undefined || !Array.isArray(policy.bindings)) return undefined;
  const invalid = (detail: string): StateWritePlan => ({
    ok: false,
    error: `${STATE_WRITE_INVALID}: node "${node.id}" ${detail}`,
  });
  if (!isPlainRecord(output)) {
    return invalid("output must be a plain object to write bound ports");
  }

  const writes: Array<[string, unknown]> = [];
  for (const binding of policy.bindings) {
    const value = output[binding.port];
    if (value === undefined) {
      if (binding.cardinality === "optional") continue;
      return invalid(`outputs.${binding.port}: required bound port is missing`);
    }
    if (binding.cardinality === "many" && !Array.isArray(value)) {
      return invalid(`outputs.${binding.port}: many cardinality requires an array`);
    }
    writes.push([binding.key, structuredClone(value)]);
  }
  return { ok: true, writes };
}

/** Apply a validated plan to the run state. */
export function applyStateWrites(
  state: Record<string, unknown>,
  plan: StateWritePlan | undefined,
): void {
  if (plan?.ok !== true) return;
  for (const [key, value] of plan.writes) state[key] = value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
