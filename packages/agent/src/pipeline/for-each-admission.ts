import type {
  LoopNode,
  PipelineEdge,
  PipelineNode,
  PipelineValidationError,
} from "@dzupagent/core/pipeline";

/**
 * Defense-in-depth validation for hand-authored or legacy pipeline artifacts.
 * Compiler-lowered for_each bodies are an ordered chain of leaf nodes. The
 * current item worker does not dispatch graph control or persist per-item
 * concurrent/economic frames, so anything outside that exact shape is denied.
 */
export function validateForEachAdmission(
  loop: LoopNode,
  entryNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
  loopNodes: readonly LoopNode[]
): PipelineValidationError[] {
  const errors: PipelineValidationError[] = [];

  if (loop.forEach?.concurrency !== 1) {
    errors.push({
      code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
      message:
        `LoopNode "${loop.id}" for_each concurrency must be 1 until the runtime ` +
        "has a definition-bound durable per-item frame, serialized checkpoint commits, and reservation settlement receipts",
      nodeId: loop.id,
    });
  }

  const unsupported = findUnsupportedBodyShape(
    loop,
    entryNodeId,
    nodeMap,
    edges,
    loopNodes
  );
  if (unsupported !== undefined) {
    errors.push({
      code: unsupported.code,
      message:
        `LoopNode "${loop.id}" does not have an admitted leaf-only for_each body: ` +
        `${unsupported.kind} at "${unsupported.nodeId}"; item-body control requires ` +
        "a definition-bound durable item graph frame and canonical recursive dispatcher",
      nodeId: unsupported.nodeId,
    });
  }

  return errors;
}

type UnsupportedBody = {
  code:
    | "FOR_EACH_INTERACTION_UNSUPPORTED"
    | "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED"
    | "FOR_EACH_SUSPENSION_UNSUPPORTED"
    | "FOR_EACH_TERMINAL_UNSUPPORTED";
  nodeId: string;
  kind: string;
};

function findUnsupportedBodyShape(
  loop: LoopNode,
  entryNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
  loopNodes: readonly LoopNode[]
): UnsupportedBody | undefined {
  if (loop.bodyGraph !== undefined) {
    return recursive(loop.id, "for_each declares a graph-shaped body");
  }
  if (loop.bodyNodeIds.length === 0) {
    return recursive(loop.id, "for_each body is empty");
  }
  if (new Set(loop.bodyNodeIds).size !== loop.bodyNodeIds.length) {
    return recursive(loop.id, "for_each body contains duplicate node IDs");
  }

  const bodyIds = new Set(loop.bodyNodeIds);
  if (bodyIds.has(entryNodeId)) {
    return recursive(entryNodeId, "a body node is also the pipeline entry");
  }

  for (const bodyId of loop.bodyNodeIds) {
    const bodyNode = nodeMap.get(bodyId);
    if (bodyNode === undefined) continue;

    const otherOwners = loopNodes.filter(
      (candidate) =>
        candidate.id !== loop.id && candidate.bodyNodeIds.includes(bodyId)
    );
    if (otherOwners.length > 0) {
      return recursive(bodyId, "a body node is owned by more than one loop");
    }

    switch (bodyNode.type) {
      case "agent":
      case "tool":
      case "transform":
        break;
      case "suspend":
        return bodyNode.interaction === undefined && bodyNode.resumeCondition === undefined
          ? terminal(bodyId, "terminal suspend control")
          : suspension(bodyId, "suspend control");
      case "gate":
        return bodyNode.gateType === "approval" || bodyNode.interaction !== undefined
          ? interaction(bodyId, "approval interaction control")
          : recursive(bodyId, "gate control");
      case "fork":
        return recursive(bodyId, "fork control");
      case "join":
        return recursive(bodyId, "join control");
      case "loop":
        return recursive(bodyId, "nested loop control");
    }
  }

  const expectedPairs = new Set<string>();
  for (let index = 0; index < loop.bodyNodeIds.length - 1; index += 1) {
    expectedPairs.add(pair(loop.bodyNodeIds[index]!, loop.bodyNodeIds[index + 1]!));
  }
  const observedPairs = new Map<string, number>();
  let bodyEdgeCount = 0;

  for (const edge of edges) {
    const targets = edgeTargets(edge);
    const touchesBody = bodyIds.has(edge.sourceNodeId) || targets.some((id) => bodyIds.has(id));
    if (!touchesBody) continue;
    bodyEdgeCount += 1;
    if (edge.type !== "sequential") {
      return recursive(edge.sourceNodeId, `${edge.type} item-body routing`);
    }
    if (!bodyIds.has(edge.sourceNodeId) || !bodyIds.has(edge.targetNodeId)) {
      return recursive(edge.sourceNodeId, "item-body edge crosses the loop boundary");
    }
    const key = pair(edge.sourceNodeId, edge.targetNodeId);
    if (!expectedPairs.has(key)) {
      return recursive(edge.sourceNodeId, "item-body edge does not follow bodyNodeIds order");
    }
    observedPairs.set(key, (observedPairs.get(key) ?? 0) + 1);
  }

  if (bodyEdgeCount === 0) return undefined;
  for (const expected of expectedPairs) {
    if (observedPairs.get(expected) !== 1) {
      return recursive(loop.id, "item-body chain is missing or duplicates a sequential edge");
    }
  }

  return undefined;
}

function edgeTargets(edge: PipelineEdge): string[] {
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}

function pair(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

function recursive(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED", nodeId, kind };
}

function interaction(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_INTERACTION_UNSUPPORTED", nodeId, kind };
}

function suspension(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_SUSPENSION_UNSUPPORTED", nodeId, kind };
}

function terminal(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_TERMINAL_UNSUPPORTED", nodeId, kind };
}
