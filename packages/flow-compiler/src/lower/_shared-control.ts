/**
 * _shared-control.ts — Per-variant lowerers for control-flow composite
 * nodes: sequence, branch, parallel.
 *
 * These lowerers own multiple child sub-graphs and stitch them with
 * sequential or conditional edges around gate/fork/join nodes.
 *
 * @module lower/_shared-control
 */

import type {
  BranchNode,
  FlowNode,
  ParallelNode,
} from '@dzupagent/flow-ast'
import type {
  ForkNode,
  GateNode,
  JoinNode,
  PipelineEdge,
  PipelineNode,
} from '@dzupagent/core/orchestration'

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from './_shared-types.js'
import {
  freshId,
  lowerChildren,
  resultTails,
  seqEdge,
} from './_shared-utils.js'

type LowerOne = (
  child: FlowNode,
  ctx: LowerPipelineContext,
  path: string,
) => LowerPipelineResult

/**
 * sequence → recurse each child, concatenate, add sequential edges between
 * the last node of each child result and the first node of the next.
 */
export function lowerSequence(
  children: FlowNode[],
  ctx: LowerPipelineContext,
  parentPath: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  return lowerChildren(
    children,
    ctx,
    (idx) => `${parentPath}.nodes[${idx}]`,
    lowerOne,
  )
}

/**
 * branch → GateNode (condition) with conditional edge branching to then/else
 * sub-graphs.
 */
export function lowerBranch(
  node: BranchNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  const gateId = freshId(ctx)
  const gateNode: GateNode = {
    id: gateId,
    type: 'gate',
    gateType: 'quality',
    name: `branch:${path}`,
    condition: node.condition,
  }

  const thenResult = lowerChildren(
    node.then,
    ctx,
    (idx) => `${path}.then[${idx}]`,
    lowerOne,
  )
  const elseResult =
    node.else !== undefined
      ? lowerChildren(
          node.else,
          ctx,
          (idx) => `${path}.else[${idx}]`,
          lowerOne,
        )
      : { nodes: [], edges: [], warnings: [] }

  const thenFirst = thenResult.nodes[0]
  const elseFirst = elseResult.nodes[0]

  const warnings: string[] = [...thenResult.warnings, ...elseResult.warnings]

  // Build a ConditionalEdge from the gate to then/else branches
  const branchMap: Record<string, string> = {}
  if (thenFirst !== undefined) {
    branchMap['true'] = thenFirst.id
  }
  if (elseFirst !== undefined) {
    branchMap['false'] = elseFirst.id
  }

  const conditionalEdge: PipelineEdge = {
    type: 'conditional',
    sourceNodeId: gateId,
    predicateName: `branch__${gateId}__predicate`,
    branches: branchMap,
  }

  // Expose one tail per branch path so a following sibling receives a
  // continuation edge from *every* path the gate can take. Previously only the
  // last node emitted (the else-tail, or then-tail when no else existed) was
  // treated as terminal, which silently dropped the then-path continuation and
  // dead-ended `branch → action` flows at runtime.
  //
  // - then-path tail(s): the terminal node(s) of the then sub-graph.
  // - else-path tail(s): the terminal node(s) of the else sub-graph when an
  //   else branch exists; otherwise the gate itself is the false-path tail so
  //   the continuation is wired to the gate's `false` outcome.
  const tails: string[] = []
  tails.push(...branchTails(thenResult, gateId))
  if (node.else !== undefined) {
    tails.push(...branchTails(elseResult, gateId))
  } else {
    // No else branch: the gate's `false` outcome flows straight to whatever
    // follows the branch, so the gate is a terminal tail of the false-path.
    tails.push(gateId)
  }

  return {
    nodes: [gateNode, ...thenResult.nodes, ...elseResult.nodes],
    edges: [conditionalEdge, ...thenResult.edges, ...elseResult.edges],
    warnings,
    tails,
  }
}

/**
 * Resolve the terminal tail IDs of one branch path. An empty path (e.g. a
 * `then: []`) has no nodes of its own, so the gate is its terminal tail — the
 * continuation then attaches directly to the gate's corresponding outcome.
 */
function branchTails(
  pathResult: LowerPipelineResult,
  gateId: string,
): string[] {
  const explicit = pathResult.tails
  if (explicit !== undefined && explicit.length > 0) {
    return explicit
  }
  const lastNode = pathResult.nodes[pathResult.nodes.length - 1]
  return lastNode !== undefined ? [lastNode.id] : [gateId]
}

/**
 * parallel → ForkNode → (one branch per parallel branch) → JoinNode.
 * Each branch is lowered as a sequence; ForkNode and JoinNode share a forkId.
 */
export function lowerParallel(
  node: ParallelNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  const forkId = freshId(ctx)
  const joinId = freshId(ctx)
  const sharedForkKey = forkId // stable key shared between Fork+Join

  const forkNode: ForkNode = {
    id: forkId,
    type: 'fork',
    name: `parallel-fork:${path}`,
    forkId: sharedForkKey,
  }

  const joinNode: JoinNode = {
    id: joinId,
    type: 'join',
    name: `parallel-join:${path}`,
    forkId: sharedForkKey,
    mergeStrategy: 'all',
  }

  const allNodes: PipelineNode[] = [forkNode]
  const allEdges: PipelineEdge[] = []
  const warnings: string[] = []

  for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
    const branch = node.branches[bIdx]
    if (branch === undefined) continue

    const branchResult = lowerChildren(
      branch,
      ctx,
      (idx) => `${path}.branches[${bIdx}][${idx}]`,
      lowerOne,
    )
    allNodes.push(...branchResult.nodes)
    allEdges.push(...branchResult.edges)
    warnings.push(...branchResult.warnings)

    const firstNode = branchResult.nodes[0]

    if (firstNode !== undefined) {
      allEdges.push(seqEdge(forkId, firstNode.id))
    }
    // Wire every terminal tail of the branch into the join. A branch that ends
    // in a fan-out (e.g. a nested `branch`) exposes one tail per path; using
    // `resultTails` ensures all of them converge on the join rather than only
    // the last node emitted.
    for (const tailId of resultTails(branchResult)) {
      allEdges.push(seqEdge(tailId, joinId))
    }
  }

  allNodes.push(joinNode)

  return { nodes: allNodes, edges: allEdges, warnings }
}
