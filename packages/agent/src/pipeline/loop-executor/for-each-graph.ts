import type { PipelineForEachItemFrame } from "@dzupagent/core/pipeline";
import type { LoopNode, PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import { validateRetainedLoopBodyGraphCheckpointState } from "../loop-body-graph-checkpoint-validator.js";
import type { LoopBodyGraphCheckpointState } from "./types.js";

/** Preflight every item before concurrent dispatch can reach an economics host. */
export function validateForEachItemGraphs(
  definition: PipelineDefinition,
  loop: LoopNode,
  items: readonly unknown[],
  itemFrames: Readonly<Record<string, PipelineForEachItemFrame>> | undefined
): void {
  for (const item of Object.values(itemFrames ?? {})) {
    const graph = item.graph;
    const fail = (reason: string): never => {
      throw new Error(`Loop "${loop.id}" item ${item.itemIndex}: corrupt retained item graph: ${reason}`);
    };
    if (loop.bodyGraph === undefined) {
      if (graph !== undefined) fail("graph receipt on a flat body");
      continue;
    }
    if (graph === undefined) {
      // An initial reservation can predate the first graph dispatch. Every
      // recorded successful node, however, requires its exact graph receipt.
      if (item.nextBodyNodeIndex !== 0 || Object.keys(item.bodyResults ?? {}).length > 0 || item.outcome === "completed") {
        fail("durable work has no graph receipt");
      }
      continue;
    }
    if (graph.schema !== "dzupagent/for-each-item-graph/v1" ||
        graph.loopNodeId !== loop.id || graph.itemIndex !== item.itemIndex ||
        graph.itemValueDigest !== canonicalInputDigest(items[item.itemIndex])) fail("version or item identity mismatch");
    if (graph.frame.outcome !== undefined && graph.frame.outcome.kind !== "normal") fail("non-normal outcome");
    if (item.nextBodyNodeIndex !== 0 && item.nextBodyNodeIndex !== loop.bodyNodeIds.length) fail("graph cursor interpreted as flat progress");
    if (item.nextBodyNodeIndex === loop.bodyNodeIds.length && !graph.frame.completed) fail("body completion precedes graph completion");
    if (item.outcome === "completed" && item.nextBodyNodeIndex !== loop.bodyNodeIds.length) fail("settled item lacks body completion");
    const frame = graph.frame as LoopBodyGraphCheckpointState;
    validateRetainedLoopBodyGraphCheckpointState(definition, loop.id, frame);
    // The generic frame validator checks the last boundary. This one-branch
    // adapter also requires the full recorded history to be one actual path.
    let previous: string | undefined;
    for (const id of frame.completedNodeIds) {
      const allowed = previous === undefined ? [loop.bodyGraph.entryNodeId] :
        definition.edges.filter((edge) => edge.sourceNodeId === previous).flatMap((edge) =>
          edge.type === "conditional" ? Object.values(edge.branches) : [edge.targetNodeId]);
      if (!allowed.includes(id)) fail("completed history is not an item path");
      previous = id;
    }
    const body = Object.fromEntries(Object.entries(item.bodyResults ?? {}).filter(([id]) => id !== loop.id));
    if (canonicalInputDigest(body) !== canonicalInputDigest(frame.nodeResults)) fail("body and graph results disagree");
  }
}
