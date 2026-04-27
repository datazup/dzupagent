import type { FlowNode } from '@dzupagent/flow-ast'

import type { CompilationTarget } from './types.js'

/**
 * D2 — Feature bitmask (canonical).
 *
 * Each bit represents a structural feature whose presence affects which
 * compilation target the flow must lower to. The bitmask is computed in a
 * single recursive walk, OR-ing bits as the walker descends. Subtree purity
 * never downgrades the enclosing program: an all-sequential subtree inside a
 * `branch` still escalates the whole flow to the `workflow-builder` target.
 */
export const FEATURE_BITS = {
  SEQUENTIAL_ONLY: 0,
  BRANCH:          1 << 0,   // 1
  PARALLEL:        1 << 1,   // 2
  SUSPEND:         1 << 2,   // 4    (approval | clarification | persona | route)
  FOR_EACH:        1 << 3,   // 8
} as const

export type FeatureBitmask = number

/**
 * Single source of truth used by STAGE 2 (OI-4 enforcement) and STAGE 4
 * (router → lowerer dispatch).
 *
 * Routing rule (matches D2 table exactly):
 *   - any FOR_EACH bit              → 'pipeline'
 *   - any BRANCH | PARALLEL | SUSPEND bit → 'workflow-builder'
 *   - otherwise                     → 'skill-chain'
 */
export function routeTarget(ast: FlowNode): { target: CompilationTarget; bitmask: FeatureBitmask } {
  const bitmask = computeFeatureBitmask(ast)
  if ((bitmask & FEATURE_BITS.FOR_EACH) !== 0) {
    return { target: 'pipeline', bitmask }
  }
  if ((bitmask & (FEATURE_BITS.BRANCH | FEATURE_BITS.PARALLEL | FEATURE_BITS.SUSPEND)) !== 0) {
    return { target: 'workflow-builder', bitmask }
  }
  return { target: 'skill-chain', bitmask }
}

/**
 * Single recursive walk that OR-s feature bits as it descends every body
 * slot of every node type. Pure — no IO, no allocations beyond the bitmask
 * accumulator.
 */
export function computeFeatureBitmask(ast: FlowNode): FeatureBitmask {
  let bits: FeatureBitmask = FEATURE_BITS.SEQUENTIAL_ONLY

  const visit = (node: FlowNode): void => {
    switch (node.type) {
      case 'sequence': {
        for (const child of node.nodes) visit(child)
        return
      }
      case 'action':
      case 'complete': {
        // Leaf nodes contribute no bits.
        return
      }
      case 'branch': {
        bits |= FEATURE_BITS.BRANCH
        for (const child of node.then) visit(child)
        if (node.else) {
          for (const child of node.else) visit(child)
        }
        return
      }
      case 'parallel': {
        bits |= FEATURE_BITS.PARALLEL
        for (const branch of node.branches) {
          for (const child of branch) visit(child)
        }
        return
      }
      case 'for_each': {
        bits |= FEATURE_BITS.FOR_EACH
        for (const child of node.body) visit(child)
        return
      }
      case 'approval': {
        bits |= FEATURE_BITS.SUSPEND
        for (const child of node.onApprove) visit(child)
        if (node.onReject) {
          for (const child of node.onReject) visit(child)
        }
        return
      }
      case 'clarification': {
        bits |= FEATURE_BITS.SUSPEND
        return
      }
      case 'persona': {
        bits |= FEATURE_BITS.SUSPEND
        for (const child of node.body) visit(child)
        return
      }
      case 'route': {
        bits |= FEATURE_BITS.SUSPEND
        for (const child of node.body) visit(child)
        return
      }
      case 'spawn':
      case 'classify':
      case 'emit':
      case 'memory':
      case 'checkpoint':
      case 'restore': {
        // Runtime-executed leaf nodes — contribute no feature bits.
        return
      }
      default: {
        // Exhaustiveness guard — if a new FlowNode variant is added without
        // a corresponding case, TS will fail compilation here.
        const _exhaustive: never = node
        void _exhaustive
        return
      }
    }
  }

  visit(ast)
  return bits
}

/**
 * STAGE 2 (OI-4) and STAGE 4 (defense-in-depth backstop) both need to know
 * whether any node in the AST carries an `on_error` field. The FlowNode
 * union does not yet declare `on_error` as a typed property on any variant
 * (introduced pre-emptively in Wave 10); detection is therefore done via a
 * forward-compatible structural check. When a future wave promotes
 * `on_error` to a typed field, this check stays correct without edits.
 */
export function hasOnError(ast: FlowNode): boolean {
  let found = false

  const visit = (node: FlowNode): void => {
    if (found) return
    if ((node as unknown as Record<string, unknown>).on_error !== undefined) {
      found = true
      return
    }
    switch (node.type) {
      case 'sequence': {
        for (const child of node.nodes) visit(child)
        return
      }
      case 'branch': {
        for (const child of node.then) visit(child)
        if (node.else) {
          for (const child of node.else) visit(child)
        }
        return
      }
      case 'parallel': {
        for (const branch of node.branches) {
          for (const child of branch) visit(child)
        }
        return
      }
      case 'for_each': {
        for (const child of node.body) visit(child)
        return
      }
      case 'approval': {
        for (const child of node.onApprove) visit(child)
        if (node.onReject) {
          for (const child of node.onReject) visit(child)
        }
        return
      }
      case 'persona': {
        for (const child of node.body) visit(child)
        return
      }
      case 'route': {
        for (const child of node.body) visit(child)
        return
      }
      case 'action':
      case 'clarification':
      case 'complete':
      case 'spawn':
      case 'classify':
      case 'emit':
      case 'memory':
      case 'checkpoint':
      case 'restore': {
        return
      }
      default: {
        const _exhaustive: never = node
        void _exhaustive
        return
      }
    }
  }

  visit(ast)
  return found
}
