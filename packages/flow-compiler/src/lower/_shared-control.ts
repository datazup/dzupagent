/**
 * _shared-control.ts — Per-variant lowerers for control-flow composite
 * nodes: sequence, branch, parallel, try_catch.
 *
 * These lowerers own multiple child sub-graphs and stitch them with
 * sequential, conditional, or error edges around gate/fork/join nodes.
 *
 * @module lower/_shared-control
 */

import type {
  BranchNode,
  FlowNode,
  ParallelNode,
  TryCatchNode,
} from "@dzupagent/flow-ast";
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
import { nodeDurabilityFields } from "./_shared-durability.js";
import {
  effectiveTails,
  freshId,
  lowerChildren,
  portsOf,
  seqEdge,
} from "./_shared-utils.js";

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
    ...nodeDurabilityFields(node),
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
  // - then-tail(s): exit points of the then body (none when it ends terminal,
  //   e.g. in `complete`).
  // - else-tail(s): exit points of the else body, same terminal rule.
  // - false-path tail: when there is no else body, the gate itself is the
  //   exit point for the false outcome — it must also wire to the continuation.
  const thenLastNode = thenResult.nodes[thenResult.nodes.length - 1];
  const elseLastNode = elseResult.nodes[elseResult.nodes.length - 1];

  const tailNodeIds: string[] = [
    ...(thenResult.tailNodeIds ??
      (thenLastNode !== undefined ? [thenLastNode.id] : [])),
  ];
  if (elseResult.nodes.length > 0) {
    tailNodeIds.push(
      ...(elseResult.tailNodeIds ??
        (elseLastNode !== undefined ? [elseLastNode.id] : []))
    );
  } else {
    // No else branch → the gate's false-path dead-ends without a tail node.
    // The gate itself is the false-path exit and must connect to any continuation.
    tailNodeIds.push(gateId);
  }

  const thenPorts = portsOf(thenResult);
  const elsePorts = portsOf(elseResult);
  return {
    nodes: [gateNode, ...thenResult.nodes, ...elseResult.nodes],
    edges: [conditionalEdge, ...thenResult.edges, ...elseResult.edges],
    warnings,
    tailNodeIds,
    ports: {
      entryNodeIds: [gateId],
      normalExits: tailNodeIds,
      suspendedExits: [
        ...thenPorts.suspendedExits,
        ...elsePorts.suspendedExits,
      ],
      suspensionSites: [
        ...thenPorts.suspensionSites,
        ...elsePorts.suspensionSites,
      ],
      terminalExits: [...thenPorts.terminalExits, ...elsePorts.terminalExits],
      errorExits: [...thenPorts.errorExits, ...elsePorts.errorExits],
    },
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
  const suspendedExits: string[] = [];
  const suspensionSites: string[] = [];
  const terminalExits: string[] = [];
  const errorExits: string[] = [];

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

    // Join from the branch's TRUE exit points, not the flat last-node
    // fallback: a branch whose body ends in a nested composite (approval,
    // branch, …) has several exits, and every non-terminal one must reach
    // the join. An explicit empty tail set means the branch is terminal
    // (e.g. ends in `complete`) — it must NOT be wired into the join, or a
    // resume would advance past the declared completion.
    const branchTailIds =
      branchResult.tailNodeIds ?? (lastNode !== undefined ? [lastNode.id] : []);
    if (branchTailIds.length === 0 && branchResult.nodes.length > 0) {
      warnings.push(
        `lower/parallel: branch [${bIdx}] of '${path}' is terminal (e.g. ends in complete) and does not reach the join`
      );
    }
    for (const tailId of branchTailIds) {
      allEdges.push(seqEdge(tailId, joinId));
    }

    const branchPorts = portsOf(branchResult);
    suspendedExits.push(...branchPorts.suspendedExits);
    suspensionSites.push(...branchPorts.suspensionSites);
    terminalExits.push(...branchPorts.terminalExits);
    errorExits.push(...branchPorts.errorExits);
  }

  allNodes.push(joinNode);

  // The join node is the parallel's single exit point; publish it as the
  // explicit tail instead of relying on the parent's last-node fallback.
  return {
    nodes: allNodes,
    edges: allEdges,
    warnings,
    tailNodeIds: [joinId],
    ports: {
      entryNodeIds: [forkId],
      normalExits: [joinId],
      suspendedExits,
      suspensionSites,
      terminalExits,
      errorExits,
    },
  };
}

/**
 * try_catch → body sub-graph + catch sub-graph joined by catch-all
 * ErrorEdges (F-R2c, the first deliberate ErrorEdge production): every node
 * the body fragment lowered gets an error edge to the catch entry, so the
 * runtime's error routing (`getErrorTarget`) lands in the catch fragment
 * instead of failing the run. No sequential edge enters the catch — it is
 * reachable only via the error path.
 *
 * A handled error RESUMES: the fragment's tails are body tails + catch
 * tails, and the catch tails are also published as `ports.errorExits`. The
 * error set refines WHICH continuations are error-path ones without
 * breaking the `normalExits === effectiveTails` invariant. Suspended and
 * terminal exits from both sub-graphs compose upward unchanged, so a catch
 * that deliberately ends the flow (`complete`) contributes a terminal exit
 * and no error exit.
 */
export function lowerTryCatch(
  node: TryCatchNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne
): LowerPipelineResult {
  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne
  );
  const catchResult = lowerChildren(
    node.catch,
    ctx,
    (idx) => `${path}.catch[${idx}]`,
    lowerOne
  );

  const warnings = [...bodyResult.warnings, ...catchResult.warnings];

  if (node.errorVar !== undefined && catchResult.nodes.length > 0) {
    warnings.push(
      `lower/try_catch: errorVar ${JSON.stringify(node.errorVar)} at '${path}' ` +
        "is not written into run state by the generic pipeline runtime yet; " +
        "the failed node's result carries the error message instead"
    );
  }

  // Nothing in the body can fail at runtime (it lowered to zero pipeline
  // nodes), so the catch branch is unreachable — dropping it is the
  // fail-safe shape, and the warning makes the drop visible.
  if (bodyResult.nodes.length === 0) {
    if (catchResult.nodes.length > 0) {
      warnings.push(
        `lower/try_catch: body at '${path}' lowered to zero pipeline nodes, ` +
          "so its catch branch is unreachable and was not lowered"
      );
    }
    return { ...bodyResult, warnings };
  }

  const catchPorts = portsOf(catchResult);
  const catchEntry = catchPorts.entryNodeIds[0];

  // Catch lowered to zero nodes: keep the error path runtime-only (the
  // pre-F-R2c behaviour) rather than emitting dangling error edges.
  if (catchEntry === undefined) {
    return { ...bodyResult, warnings };
  }

  const errorEdgesToCatch: PipelineEdge[] = bodyResult.nodes.map((n) => ({
    type: "error",
    sourceNodeId: n.id,
    targetNodeId: catchEntry,
  }));

  const bodyPorts = portsOf(bodyResult);
  const bodyTails = effectiveTails(bodyResult);
  const catchTails = effectiveTails(catchResult);
  const tailNodeIds = [...bodyTails, ...catchTails];

  return {
    nodes: [...bodyResult.nodes, ...catchResult.nodes],
    // Child edges first: a nested try_catch's inner error edges must precede
    // the outer ones, so the runtime's first-catch-all lookup picks the
    // inner handler — mirroring language-level nesting.
    edges: [...bodyResult.edges, ...catchResult.edges, ...errorEdgesToCatch],
    warnings,
    tailNodeIds,
    ports: {
      entryNodeIds: bodyPorts.entryNodeIds,
      normalExits: tailNodeIds,
      suspendedExits: [
        ...bodyPorts.suspendedExits,
        ...catchPorts.suspendedExits,
      ],
      suspensionSites: [
        ...bodyPorts.suspensionSites,
        ...catchPorts.suspensionSites,
      ],
      terminalExits: [...bodyPorts.terminalExits, ...catchPorts.terminalExits],
      // Every continuing exit of the catch fragment is an error-path exit of
      // this fragment; body-side error exits (nested try_catch) propagate.
      errorExits: [...bodyPorts.errorExits, ...catchTails],
    },
  };
}
