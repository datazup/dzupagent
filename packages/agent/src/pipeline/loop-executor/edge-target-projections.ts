import type { PipelineEdge } from "@dzupagent/core/pipeline";

/** All authored targets used only to prove a scoped loop body is closed. */
export function projectLoopBodyContainmentTargets(
  edge: PipelineEdge,
): string[] {
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}

/** All authored targets used for structural validation and reachability. */
export function projectValidationEdgeTargets(edge: PipelineEdge): string[] {
  switch (edge.type) {
    case "sequential":
    case "error":
      return [edge.targetNodeId];
    case "conditional":
      return Object.values(edge.branches);
  }
}
