import type { PipelineEdge, PipelineNode } from "@dzupagent/core/pipeline";

import { getNextNodeIds } from "../pipeline-shared/edge-resolution.js";
import type { RunFrame } from "../executor-internals/run-frame.js";
import type { NodeResult, PipelineRuntimeConfig } from "../pipeline-runtime-types.js";

export function nextScopedNodeId(
  frame: RunFrame,
  nodes: readonly PipelineNode[],
  outgoingEdges: Map<string, PipelineEdge[]>,
  predicates: PipelineRuntimeConfig["predicates"],
  entryNodeId: string
): string | undefined {
  const midFlightForkId = Object.keys(frame.forkState)[0];
  if (midFlightForkId !== undefined) {
    return nodes.find(
      (node) => node.type === "fork" && node.forkId === midFlightForkId
    )?.id;
  }
  const lastCompletedNodeId = frame.completedNodeIds.at(-1);
  if (lastCompletedNodeId === undefined) return entryNodeId;
  return getNextNodeIds(
    lastCompletedNodeId,
    outgoingEdges,
    predicates,
    frame.runState
  )[0];
}

export function bodyResultsFor(
  completedNodeIds: readonly string[],
  nodeResults: ReadonlyMap<string, NodeResult>,
  bodyIds: ReadonlySet<string>,
  priorBodyResults: ReadonlyMap<string, NodeResult>
): Map<string, NodeResult> {
  const results = new Map<string, NodeResult>();
  const completed = new Set(completedNodeIds);
  for (const nodeId of bodyIds) {
    const result = nodeResults.get(nodeId);
    if (
      result !== undefined &&
      (completed.has(nodeId) || result !== priorBodyResults.get(nodeId))
    ) {
      results.set(nodeId, result);
    }
  }
  return results;
}

export function lastCompletedResult(
  completedNodeIds: readonly string[],
  nodeResults: ReadonlyMap<string, NodeResult>
): NodeResult | undefined {
  for (let index = completedNodeIds.length - 1; index >= 0; index -= 1) {
    const nodeId = completedNodeIds[index];
    if (nodeId === undefined) continue;
    const result = nodeResults.get(nodeId);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function checkpointBodyResults(
  results: ReadonlyMap<string, NodeResult>,
  includeProviderSessionRefs: boolean
): Record<string, NodeResult> {
  return Object.fromEntries(
    [...results].map(([nodeId, result]) => [
      nodeId,
      {
        nodeId: result.nodeId,
        output: result.output,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.errorMetadata === undefined
          ? {}
          : { errorMetadata: result.errorMetadata }),
        ...(includeProviderSessionRefs &&
        result.providerSessionRefs !== undefined
          ? { providerSessionRefs: result.providerSessionRefs }
          : {}),
      },
    ])
  );
}
