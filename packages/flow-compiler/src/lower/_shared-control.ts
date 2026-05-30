/**
 * _shared-control.ts — Per-variant lowerers for control-flow composite
 * nodes: sequence, branch, parallel.
 *
 * These lowerers own multiple child sub-graphs and stitch them with
 * sequential or conditional edges around gate/fork/join nodes.
 *
 * @module lower/_shared-control
 */

import type { BranchNode, FlowNode, ParallelNode } from "@dzupagent/flow-ast";
import type {
  ForkNode,
  GateNode,
  JoinNode,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/orchestration";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "./_shared-types.js";
import { freshId, lowerChildren, seqEdge } from "./_shared-utils.js";

type LowerOne = (
  child: FlowNode,
  ctx: LowerPipelineContext,
  path: string
) => LowerPipelineResult;

/**
 * sequence → recurse each child, concatenate, add sequential edges between
 * the last node of each child result and the first node of the next.
 */
export function lowerSequence(
  children: FlowNode[],
  ctx: LowerPipelineContext,
  parentPath: string,
  lowerOne: LowerOne
): LowerPipelineResult {
  return lowerChildren(
    children,
    ctx,
    (idx) => `${parentPath}.nodes[${idx}]`,
    lowerOne
  );
}

/**
 * branch → GateNode (condition) with conditional edge branching to then/else
 * sub-graphs.
 */
export function lowerBranch(
  node: BranchNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne
): LowerPipelineResult {
  const gateId = freshId(ctx);
  const gateNode: GateNode = {
    id: gateId,
    type: "gate",
    gateType: "quality",
    name: `branch:${path}`,
    condition: node.condition,
  };

  const thenResult = lowerChildren(
    node.then,
    ctx,
    (idx) => `${path}.then[${idx}]`,
    lowerOne
  );
  const elseResult =
    node.else !== undefined
      ? lowerChildren(node.else, ctx, (idx) => `${path}.else[${idx}]`, lowerOne)
      : { nodes: [], edges: [], warnings: [] };

  const thenFirst = thenResult.nodes[0];
  const elseFirst = elseResult.nodes[0];

  const warnings: string[] = [...thenResult.warnings, ...elseResult.warnings];

  // Build a ConditionalEdge from the gate to then/else branches
  const branchMap: Record<string, string> = {};
  if (thenFirst !== undefined) {
    branchMap["true"] = thenFirst.id;
  }
  if (elseFirst !== undefined) {
    branchMap["false"] = elseFirst.id;
  }

  const conditionalEdge: PipelineEdge = {
    type: "conditional",
    sourceNodeId: gateId,
    predicateName: `branch__${gateId}__predicate`,
    branches: branchMap,
  };

  // Determine the exit points (tails) of the branch sub-graph so that the
  // parent sequence can wire ALL of them to the next sibling node.
  //
  // - then-tail: last node produced by the then body (if any).
  // - else-tail: last node produced by the else body (if any).
  // - false-path tail: when there is no else body, the gate itself is the
  //   exit point for the false outcome — it must also wire to the continuation.
  const thenLastNode = thenResult.nodes[thenResult.nodes.length - 1];
  const elseLastNode = elseResult.nodes[elseResult.nodes.length - 1];

  const tailNodeIds: string[] = [];
  if (thenLastNode !== undefined) {
    tailNodeIds.push(thenLastNode.id);
  }
  if (elseLastNode !== undefined) {
    tailNodeIds.push(elseLastNode.id);
  } else {
    // No else branch → the gate's false-path dead-ends without a tail node.
    // The gate itself is the false-path exit and must connect to any continuation.
    tailNodeIds.push(gateId);
  }

  return {
    nodes: [gateNode, ...thenResult.nodes, ...elseResult.nodes],
    edges: [conditionalEdge, ...thenResult.edges, ...elseResult.edges],
    warnings,
    tailNodeIds,
  };
}

/**
 * parallel → ForkNode → (one branch per parallel branch) → JoinNode.
 * Each branch is lowered as a sequence; ForkNode and JoinNode share a forkId.
 */
export function lowerParallel(
  node: ParallelNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne
): LowerPipelineResult {
  const forkId = freshId(ctx);
  const joinId = freshId(ctx);
  const sharedForkKey = forkId; // stable key shared between Fork+Join

  const forkNode: ForkNode = {
    id: forkId,
    type: "fork",
    name: `parallel-fork:${path}`,
    forkId: sharedForkKey,
  };

  const joinNode: JoinNode = {
    id: joinId,
    type: "join",
    name: `parallel-join:${path}`,
    forkId: sharedForkKey,
    mergeStrategy: "all",
  };

  const allNodes: PipelineNode[] = [forkNode];
  const allEdges: PipelineEdge[] = [];
  const warnings: string[] = [];

  for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
    const branch = node.branches[bIdx];
    if (branch === undefined) continue;

    const branchResult = lowerChildren(
      branch,
      ctx,
      (idx) => `${path}.branches[${bIdx}][${idx}]`,
      lowerOne
    );
    allNodes.push(...branchResult.nodes);
    allEdges.push(...branchResult.edges);
    warnings.push(...branchResult.warnings);

    const firstNode = branchResult.nodes[0];
    const lastNode = branchResult.nodes[branchResult.nodes.length - 1];

    if (firstNode !== undefined) {
      allEdges.push(seqEdge(forkId, firstNode.id));
    }
    if (lastNode !== undefined) {
      allEdges.push(seqEdge(lastNode.id, joinId));
    }
  }

  allNodes.push(joinNode);

  return { nodes: allNodes, edges: allEdges, warnings };
}
