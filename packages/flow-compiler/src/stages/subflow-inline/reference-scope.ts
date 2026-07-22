import type { FlowNode } from "@dzupagent/flow-ast";

import { CHILD_NODE_FIELDS } from "./constants.js";

// ---------------------------------------------------------------------------
// Cross-node reference scope collection
// ---------------------------------------------------------------------------
// Walks an inlined subflow's node tree to gather the node ids and checkpoint
// labels that are local to that subflow. The rewrite pass uses this scope to
// decide which reference-valued fields (`return_to.targetId`, `checkpoint`
// labels, `restore.checkpointLabel`, …) must be namespaced.

export interface ReferenceScope {
  nodeIds: ReadonlySet<string>;
  checkpointLabels: ReadonlySet<string>;
}

export function collectReferenceScope(
  nodes: readonly FlowNode[]
): ReferenceScope {
  const nodeIds = new Set<string>();
  const checkpointLabels = new Set<string>();

  function visit(value: unknown, nodeScopeEligible: boolean): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, nodeScopeEligible);
      return;
    }
    if (!value || typeof value !== "object") return;

    const objectValue = value as Record<string, unknown>;
    const isNode = nodeScopeEligible && typeof objectValue.type === "string";
    if (isNode) {
      if (typeof objectValue.id === "string") nodeIds.add(objectValue.id);
      if (
        objectValue.type === "checkpoint" &&
        typeof objectValue.label === "string" &&
        !objectValue.label.includes("{{")
      ) {
        checkpointLabels.add(objectValue.label);
      }
    }

    for (const [key, child] of Object.entries(objectValue)) {
      visit(child, CHILD_NODE_FIELDS.has(key));
    }
  }

  for (const node of nodes) visit(node, true);
  return { nodeIds, checkpointLabels };
}
