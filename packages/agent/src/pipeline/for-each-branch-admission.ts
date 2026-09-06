import type { LoopNode, PipelineEdge, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";

/** Admit one closed, acyclic, normal conditional graph, including an empty else. */
export function forEachBranchShapeError(
  loop: LoopNode,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[]
): string | undefined {
  const graph = loop.bodyGraph!;
  const ids = new Set(loop.bodyNodeIds);
  if (!ids.has(graph.entryNodeId)) return "missing graph entry";
  if (graph.suspendedExitNodeIds.length || graph.terminalExitNodeIds.length ||
      graph.errorExitNodeIds.length || graph.suspensionSiteNodeIds?.length) {
    return "only normal graph completion is admitted";
  }
  const gates = loop.bodyNodeIds.filter((id) => nodeMap.get(id)?.type === "gate");
  if (gates.length !== 1) return "exactly one conditional gate is required";
  const gateId = gates[0]!;
  const outgoing = new Map<string, PipelineEdge[]>();
  for (const edge of edges) {
    const targets = edge.type === "conditional" ? Object.values(edge.branches) : [edge.targetNodeId];
    if (!ids.has(edge.sourceNodeId) && !targets.some((id) => ids.has(id))) continue;
    if (!ids.has(edge.sourceNodeId) || targets.some((id) => !ids.has(id))) return "body edge crosses the loop boundary";
    if (edge.type === "error") return "error routing is not admitted";
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge]);
  }
  const exits = new Set<string>();
  for (const id of ids) {
    const node = nodeMap.get(id);
    if (node === undefined) return "missing body node";
    const routes = outgoing.get(id) ?? [];
    if (id === gateId) {
      if (node.type !== "gate" || node.gateType !== "quality" || node.interaction !== undefined) return "only a normal quality gate is admitted";
      const conditional = routes.filter((edge) => edge.type === "conditional");
      const fallback = routes.filter((edge) => edge.type === "sequential");
      const branch = conditional[0];
      if (conditional.length !== 1 || branch?.type !== "conditional" || fallback.length > 1) return "gate requires one conditional route";
      if (!branch.branches["true"] || Object.keys(branch.branches).some((key) => key !== "true" && key !== "false")) return "branch routes must be boolean with a nonempty then arm";
      if (fallback.length && branch.branches["false"]) return "explicit else cannot also have a fallback";
      if (fallback.length && routes[0] !== branch) return "conditional route must precede its fallback";
      if (!fallback.length && !branch.branches["false"]) exits.add(id);
    } else {
      if (node.type !== "agent" && node.type !== "tool" && node.type !== "transform") return "only ordinary branch leaves are admitted";
      if (routes.length > 1 || routes.some((edge) => edge.type !== "sequential")) return "leaf must have at most one sequential successor";
      if (!routes.length) exits.add(id);
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      const targets = edge.type === "conditional" ? Object.values(edge.branches) : [edge.targetNodeId];
      if (targets.some((target) => !visit(target))) return false;
    }
    active.delete(id);
    visited.add(id);
    return true;
  };
  if (!visit(graph.entryNodeId)) return "cyclic item graph";
  if (visited.size !== ids.size) return "unreachable item nodes";
  if (new Set(graph.normalExitNodeIds).size !== graph.normalExitNodeIds.length ||
      exits.size !== graph.normalExitNodeIds.length ||
      graph.normalExitNodeIds.some((id) => !exits.has(id))) return "normal exits do not match graph routes";
  return undefined;
}
