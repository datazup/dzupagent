import type {
  PipelineEdge,
  PipelineNode,
  JoinNode,
} from "@dzupagent/core/pipeline";

export function getNextNodeIds(
  nodeId: string,
  outgoingEdges: Map<string, PipelineEdge[]>,
  /**
   * A conditional edge's `branches` is documented as "map of predicate return
   * value -> target node ID" and is a `Record<string, string>`, so a predicate
   * naming a branch (`"left"`/`"right"`) is the designed use — the lookup below
   * stringifies whatever it returns. Declaring the return type `boolean` here
   * admitted only the `"true"`/`"false"` keys and made every named-branch
   * predicate a type error, despite the runtime handling it correctly. Loop
   * continue-predicates keep their stricter `=> boolean` parameter where they
   * are consumed, since a loop genuinely needs a boolean.
   */
  predicates:
    | Record<string, (state: Record<string, unknown>) => boolean | string>
    | undefined,
  runState: Record<string, unknown>
): string[] {
  const edges = outgoingEdges.get(nodeId) ?? [];
  const targets: string[] = [];

  for (const edge of edges) {
    switch (edge.type) {
      case "sequential":
        targets.push(edge.targetNodeId);
        break;
      case "conditional": {
        const predicate = predicates?.[edge.predicateName];
        if (predicate) {
          const result = predicate(runState);
          const branchKey = String(result);
          const target = edge.branches[branchKey];
          if (target) {
            targets.push(target);
          }
        }
        break;
      }
    }
  }

  return targets;
}

export function getErrorTarget(
  nodeId: string,
  errorEdges: Map<string, PipelineEdge[]>,
  errorCode?: string
): string | undefined {
  const edges = errorEdges.get(nodeId) ?? [];
  if (edges.length === 0) return undefined;

  if (errorCode) {
    for (const edge of edges) {
      if (edge.type === "error" && edge.errorCodes?.includes(errorCode)) {
        return edge.targetNodeId;
      }
    }

    for (const edge of edges) {
      if (
        edge.type === "error" &&
        (!edge.errorCodes || edge.errorCodes.length === 0)
      ) {
        return edge.targetNodeId;
      }
    }

    return undefined;
  }

  for (const edge of edges) {
    if (
      edge.type === "error" &&
      (!edge.errorCodes || edge.errorCodes.length === 0)
    ) {
      return edge.targetNodeId;
    }
  }

  for (const edge of edges) {
    if (edge.type === "error") {
      return edge.targetNodeId;
    }
  }
  return undefined;
}

export function findJoinNode(
  forkId: string,
  nodes: PipelineNode[]
): JoinNode | undefined {
  for (const node of nodes) {
    if (node.type === "join" && node.forkId === forkId) {
      return node;
    }
  }
  return undefined;
}

export function getForkBranchStartIds(outgoingEdges: PipelineEdge[]): string[] {
  const branchStartIds: string[] = [];
  for (const edge of outgoingEdges) {
    if (edge.type === "sequential") {
      branchStartIds.push(edge.targetNodeId);
    } else if (edge.type === "conditional") {
      for (const targetId of Object.values(edge.branches)) {
        branchStartIds.push(targetId);
      }
    }
  }
  return branchStartIds;
}
