/**
 * _shared-durability.ts — W1 per-node durability field lowering.
 *
 * FlowNodeBase owns these declarations for every AST node variant. Runtime
 * pipeline nodes also share the additive field shape via PipelineNodeBase, so
 * every lowerer that emits a runtime node from an AST node should spread this.
 *
 * @module lower/_shared-durability
 */

import type { FlowNodeBase } from "@dzupagent/flow-ast";
import type { PipelineNodeBase } from "@dzupagent/core/orchestration";

type RuntimeDurabilityFields = Pick<
  PipelineNodeBase,
  "effectClass" | "idempotency" | "declaredIdempotencyKey"
>;

/**
 * Extract declared per-node durability fields from an AST node into the
 * additive runtime node shape. Returns only declared fields so nodes with no
 * durability declarations remain byte-identical: no present-but-undefined keys.
 */
export function nodeDurabilityFields(
  node: FlowNodeBase
): RuntimeDurabilityFields {
  const fields: RuntimeDurabilityFields = {};

  if (node.effectClass !== undefined) {
    fields.effectClass = node.effectClass;
  }
  if (node.idempotency !== undefined) {
    fields.idempotency = node.idempotency;
  }

  const mutation = node.meta?.mutation;
  if (
    mutation !== undefined &&
    mutation !== null &&
    typeof mutation === "object" &&
    "idempotencyKey" in mutation &&
    typeof (mutation as { idempotencyKey?: unknown }).idempotencyKey ===
      "string"
  ) {
    const key = (mutation as { idempotencyKey: string }).idempotencyKey;
    if (key.length > 0) {
      fields.declaredIdempotencyKey = key;
    }
  }

  return fields;
}
