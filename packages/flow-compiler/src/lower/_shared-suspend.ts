/**
 * _shared-suspend.ts — Per-variant lowerers for nodes that emit suspend or
 * gate-with-suspend semantics: approval, persona, route.
 *
 * These nodes pause the runtime (or pause until approval) and may carry an
 * inner body sub-graph that resumes on the suspend transition.
 *
 * @module lower/_shared-suspend
 */

import type {
  ApprovalNode,
  FlowNode,
  PersonaNode,
  RouteNode,
} from '@dzupagent/flow-ast'
import type {
  GateNode,
  PipelineEdge,
  SuspendNode,
} from '@dzupagent/core/orchestration'

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from './_shared-types.js'
import { nodeDurabilityFields } from './_shared-durability.js'
import { freshId, lowerChildren, seqEdge } from './_shared-utils.js'

type LowerOne = (
  child: FlowNode,
  ctx: LowerPipelineContext,
  path: string,
) => LowerPipelineResult

/**
 * approval → GateNode(approval) suspend + onApprove/onReject branches.
 */
export function lowerApproval(
  node: ApprovalNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  const gateId = freshId(ctx)
  const gateNode: GateNode = {
    id: gateId,
    type: 'gate',
    gateType: 'approval',
    name: `approval:${path}`,
    condition: node.question,
    ...nodeDurabilityFields(node),
  }

  const approveResult = lowerChildren(
    node.onApprove,
    ctx,
    (idx) => `${path}.onApprove[${idx}]`,
    lowerOne,
  )
  const rejectResult =
    node.onReject !== undefined
      ? lowerChildren(
          node.onReject,
          ctx,
          (idx) => `${path}.onReject[${idx}]`,
          lowerOne,
        )
      : { nodes: [], edges: [], warnings: [] }

  const approveFirst = approveResult.nodes[0]
  const rejectFirst = rejectResult.nodes[0]

  const branchMap: Record<string, string> = {}
  if (approveFirst !== undefined) {
    branchMap['approved'] = approveFirst.id
  }
  if (rejectFirst !== undefined) {
    branchMap['rejected'] = rejectFirst.id
  }

  const conditionalEdge: PipelineEdge = {
    type: 'conditional',
    sourceNodeId: gateId,
    predicateName: `approval__${gateId}__predicate`,
    branches: branchMap,
  }

  // Exit points: BOTH branch tails must wire to the next sibling, otherwise
  // the last-node fallback picks only the reject branch and the approve path
  // dead-ends before the continuation.
  //
  // When onReject is absent the rejected path is deliberately terminal — an
  // approval gate must not fail open into the continuation on rejection.
  const approveLast = approveResult.nodes[approveResult.nodes.length - 1]
  const rejectLast = rejectResult.nodes[rejectResult.nodes.length - 1]
  const tailNodeIds: string[] = [
    ...(approveResult.tailNodeIds ??
      (approveLast !== undefined ? [approveLast.id] : [])),
    ...(rejectResult.tailNodeIds ??
      (rejectLast !== undefined ? [rejectLast.id] : [])),
  ]

  return {
    nodes: [gateNode, ...approveResult.nodes, ...rejectResult.nodes],
    edges: [conditionalEdge, ...approveResult.edges, ...rejectResult.edges],
    warnings: [...approveResult.warnings, ...rejectResult.warnings],
    tailNodeIds,
  }
}

/**
 * persona → SuspendNode carrying persona metadata + lowered body sub-graph.
 * Uses ctx.resolvedPersonas to confirm the persona ref was resolved.
 */
export function lowerPersona(
  node: PersonaNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  const warnings: string[] = []
  const confirmedPersona = ctx.resolvedPersonas.get(path)
  if (confirmedPersona === undefined) {
    warnings.push(
      `lower/persona: persona '${node.personaId}' not confirmed in resolvedPersonas at '${path}'`,
    )
  }

  const suspendId = freshId(ctx)
  const suspendNode: SuspendNode = {
    id: suspendId,
    type: 'suspend',
    name: `persona:${node.personaId}`,
    description: confirmedPersona ?? node.personaId,
    resumeCondition: `persona__${node.personaId}__activated`,
    ...nodeDurabilityFields(node),
  }

  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne,
  )
  warnings.push(...bodyResult.warnings)

  const firstBodyNode = bodyResult.nodes[0]
  const edges: PipelineEdge[] = [...bodyResult.edges]
  if (firstBodyNode !== undefined) {
    edges.push(seqEdge(suspendId, firstBodyNode.id))
  }

  const lastBodyNode = bodyResult.nodes[bodyResult.nodes.length - 1]
  return {
    nodes: [suspendNode, ...bodyResult.nodes],
    edges,
    warnings,
    // Continuation exits from the body tails; an empty body exits from the
    // suspend node itself. A body ending in `complete` yields no tails.
    tailNodeIds:
      firstBodyNode === undefined
        ? [suspendId]
        : (bodyResult.tailNodeIds ??
          (lastBodyNode !== undefined ? [lastBodyNode.id] : [])),
  }
}

/**
 * route → SuspendNode with route metadata + lowered body sub-graph.
 * Strategy and provider/tags are carried in the node name/description.
 */
export function lowerRoute(
  node: RouteNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: LowerOne,
): LowerPipelineResult {
  const suspendId = freshId(ctx)
  const routeMeta = node.provider ?? node.tags?.join(',') ?? node.strategy
  const suspendNode: SuspendNode = {
    id: suspendId,
    type: 'suspend',
    name: `route:${node.strategy}`,
    description: routeMeta,
    resumeCondition: `route__${node.strategy}__resolved`,
    ...nodeDurabilityFields(node),
  }

  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne,
  )
  const firstBodyNode = bodyResult.nodes[0]
  const edges: PipelineEdge[] = [...bodyResult.edges]
  if (firstBodyNode !== undefined) {
    edges.push(seqEdge(suspendId, firstBodyNode.id))
  }

  const lastBodyNode = bodyResult.nodes[bodyResult.nodes.length - 1]
  return {
    nodes: [suspendNode, ...bodyResult.nodes],
    edges,
    warnings: bodyResult.warnings,
    // Same tail contract as lowerPersona: body tails, or the suspend node
    // when the body is empty; a body ending in `complete` yields no tails.
    tailNodeIds:
      firstBodyNode === undefined
        ? [suspendId]
        : (bodyResult.tailNodeIds ??
          (lastBodyNode !== undefined ? [lastBodyNode.id] : [])),
  }
}
