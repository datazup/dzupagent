/**
 * Exact-port state writes for a node's successful output.
 *
 * The persisted shape is `PipelineNodeBase.stateWrites` in
 * `@dzupagent/runtime-contracts/pipeline-artifact`. It is mirrored
 * structurally here, as `terminal-catch.ts` mirrors `terminalCatch`, so the
 * runtime does not depend on a contract build that already carries the field.
 *
 * @module pipeline/executor-internals/state-writes
 */

export const STATE_WRITE_INVALID = "PIPELINE_STATE_WRITE_INVALID";

export type StateWritePlan =
  | { ok: true; writes: Array<[key: string, value: unknown]> }
  | { ok: false; error: string };

interface StateWriteBindingLike {
  port: string;
  key: string;
  cardinality: string;
}

/**
 * Validate every binding against `output` before anything is written.
 * Returns `undefined` when the node declares no state writes.
 */
export function planStateWrites(
  node: { id: string },
  output: unknown,
): StateWritePlan | undefined {
  const policy = (node as { stateWrites?: { bindings?: unknown } }).stateWrites;
  if (policy === undefined || !Array.isArray(policy.bindings)) return undefined;
  const invalid = (detail: string): StateWritePlan => ({
    ok: false,
    error: `${STATE_WRITE_INVALID}: node "${node.id}" ${detail}`,
  });
  if (!isPlainRecord(output)) {
    return invalid("output must be a plain object to write bound ports");
  }

  const writes: Array<[string, unknown]> = [];
  for (const binding of policy.bindings as StateWriteBindingLike[]) {
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
