/**
 * _shared-composite.ts — Top-level dispatcher `lowerNodeToPipeline`.
 *
 * Routes each FlowNode variant to the appropriate per-variant lowerer in
 * sibling modules:
 *   - leaf nodes (action, for_each, clarification, complete): `_shared-leaf.ts`
 *   - control-flow nodes (sequence, branch, parallel): `_shared-control.ts`
 *   - suspend-style nodes (approval, persona, route): `_shared-suspend.ts`
 *
 * @module lower/_shared-composite
 */

import type { FlowNode } from '@dzupagent/flow-ast'

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from './_shared-types.js'
import {
  lowerAction,
  lowerClarification,
  lowerComplete,
  lowerForEach,
} from './_shared-leaf.js'
import {
  lowerBranch,
  lowerParallel,
  lowerSequence,
} from './_shared-control.js'
import {
  lowerApproval,
  lowerPersona,
  lowerRoute,
} from './_shared-suspend.js'

/**
 * Lower a single FlowNode (and its subtree) into a flat list of
 * PipelineNode + PipelineEdge pairs.
 *
 * @param node  The FlowNode to lower.
 * @param ctx   Lowering context (resolver maps, allowForEach, idGen).
 * @param path  Dot-notation AST path (mirrors semantic stage keys) used for
 *              node naming and resolved-map lookups.
 */
export function lowerNodeToPipeline(
  node: FlowNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  switch (node.type) {
    case 'sequence':
      return lowerSequence(node.nodes, ctx, path, lowerNodeToPipeline)

    case 'action':
      return lowerAction(node, ctx, path, lowerNodeToPipeline)

    case 'for_each':
      return lowerForEach(node, ctx, path, lowerNodeToPipeline)

    case 'branch':
      return lowerBranch(node, ctx, path, lowerNodeToPipeline)

    case 'parallel':
      return lowerParallel(node, ctx, path, lowerNodeToPipeline)

    case 'approval':
      return lowerApproval(node, ctx, path, lowerNodeToPipeline)

    case 'clarification':
      return lowerClarification(node, ctx, path)

    case 'persona':
      return lowerPersona(node, ctx, path, lowerNodeToPipeline)

    case 'route':
      return lowerRoute(node, ctx, path, lowerNodeToPipeline)

    case 'complete':
      return lowerComplete(node, ctx, path)

    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore':
      // These nodes are runtime-executed and not lowered to graph edges.
      return { nodes: [], edges: [], warnings: [] }

    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails here.
      const _exhaustive: never = node
      void _exhaustive
      return { nodes: [], edges: [], warnings: [] }
    }
  }
}
