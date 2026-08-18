/** Loop-owned adapter for the reusable scoped graph frame validator. */

import type {
  LoopNode,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";

import type { LoopBodyGraphCheckpointState } from "./loop-executor/types.js";
import type { ScopedGraphBoundary } from "./scoped-graph/contract.js";
import { validateScopedGraphCheckpointFrame } from "./scoped-graph/validate-scoped-graph-frame.js";

export interface LoopBodyGraphCheckpointDefinition {
  loopNode: LoopNode;
  nodes: readonly PipelineNode[];
  outgoingEdges: ReadonlyMap<string, PipelineEdge[]>;
  errorEdges: ReadonlyMap<string, PipelineEdge[]>;
}

/** Validate a retained loop frame directly against its owning definition. */
export function validateRetainedLoopBodyGraphCheckpointState(
  pipeline: PipelineDefinition,
  loopNodeId: string,
  state: LoopBodyGraphCheckpointState
): void {
  const loopNode = pipeline.nodes.find(
    (node): node is LoopNode => node.id === loopNodeId && node.type === "loop"
  );
  if (loopNode?.bodyGraph === undefined) {
    corruptLoop(loopNodeId, "retained graph outcome does not belong to a graph loop");
  }
  const bodyIds = new Set(loopNode.bodyNodeIds);
  const nodes = pipeline.nodes.filter((node) => bodyIds.has(node.id));
  if (nodes.length !== bodyIds.size) {
    corruptLoop(loopNodeId, "bodyNodeIds contains a missing node");
  }
  const outgoingEdges = new Map<string, PipelineEdge[]>();
  const errorEdges = new Map<string, PipelineEdge[]>();
  for (const node of nodes) {
    outgoingEdges.set(node.id, []);
    errorEdges.set(node.id, []);
  }
  for (const edge of pipeline.edges) {
    if (!bodyIds.has(edge.sourceNodeId)) continue;
    const targets =
      edge.type === "conditional"
        ? Object.values(edge.branches)
        : [edge.targetNodeId];
    const escapingTarget = targets.find((targetId) => !bodyIds.has(targetId));
    if (escapingTarget !== undefined) {
      corruptLoop(
        loopNodeId,
        `body edge escapes to node "${escapingTarget}" outside bodyNodeIds`
      );
    }
    const index = edge.type === "error" ? errorEdges : outgoingEdges;
    index.get(edge.sourceNodeId)?.push(edge);
  }
  validateScopedGraphCheckpointFrame(
    {
      boundary: loopBoundary(loopNode, pipeline.id),
      nodes,
      outgoingEdges,
      errorEdges,
    },
    state
  );
}

/** Preserve the direct loop-validator entry point for existing runtime callers. */
export function validateLoopBodyGraphCheckpointState(
  definition: LoopBodyGraphCheckpointDefinition,
  state: LoopBodyGraphCheckpointState
): void {
  const { loopNode, nodes, outgoingEdges, errorEdges } = definition;
  validateScopedGraphCheckpointFrame(
    {
      boundary: loopBoundary(loopNode, loopNode.id),
      nodes,
      outgoingEdges,
      errorEdges,
    },
    state
  );
}

/** Convert the existing loop body metadata without changing retained bytes. */
export function loopBoundary(
  loopNode: LoopNode,
  sourceDefinitionId: string
): ScopedGraphBoundary {
  const graph = loopNode.bodyGraph;
  if (graph === undefined) {
    throw new Error(
      `Loop node "${loopNode.id}": cannot schedule a graph body without bodyGraph metadata`
    );
  }
  return {
    scopeId: loopNode.id,
    displayName: `Loop node "${loopNode.id}"`,
    sourceDefinitionId,
    scopedDefinitionId: `${sourceDefinitionId}::loop-body:${loopNode.id}`,
    nodeInventoryName: "bodyNodeIds",
    entryNodeId: graph.entryNodeId,
    nodeIds: loopNode.bodyNodeIds,
    normalExitNodeIds: graph.normalExitNodeIds,
    suspendedExitNodeIds: graph.suspendedExitNodeIds,
    terminalExitNodeIds: graph.terminalExitNodeIds,
    errorExitNodeIds: graph.errorExitNodeIds,
    ...(graph.suspensionSiteNodeIds === undefined
      ? {}
      : { suspensionSiteNodeIds: graph.suspensionSiteNodeIds }),
  };
}

function corruptLoop(loopNodeId: string, detail: string): never {
  throw new Error(
    `Loop node "${loopNodeId}": corrupt retained graph cursor: ${detail}`
  );
}
