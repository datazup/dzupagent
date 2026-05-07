import type {
  FlowNode,
  ValidationError,
} from '@dzupagent/flow-ast'

import { validateConditionExpr } from './semantic-condition.js'
import type { WalkContext } from './semantic-context.js'
import { resolvePersonaNode } from './semantic-persona-resolver.js'
import { resolveAction } from './semantic-tool-resolver.js'

const ROOT_PATH = 'root'

/**
 * Recursive AST traversal for Stage 3. Dispatches to the appropriate
 * resolver/validator sub-pass for each node variant; structural recursion
 * itself stays in this module.
 */
export async function visit(node: FlowNode, path: string, ctx: WalkContext): Promise<void> {
  switch (node.type) {
    case 'sequence': {
      for (let idx = 0; idx < node.nodes.length; idx++) {
        const child = node.nodes[idx]
        if (child !== undefined) {
          await visit(child, `${path}.nodes[${idx}]`, ctx)
        }
      }
      return
    }
    case 'action': {
      await resolveAction(node, path, ctx)
      return
    }
    case 'for_each': {
      validateConditionExpr(node.type, node.source, `${path}.source`, 'for_each.source', ctx)
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'branch': {
      validateConditionExpr(node.type, node.condition, `${path}.condition`, 'branch.condition', ctx)
      for (let idx = 0; idx < node.then.length; idx++) {
        const child = node.then[idx]
        if (child !== undefined) {
          await visit(child, `${path}.then[${idx}]`, ctx)
        }
      }
      if (node.else !== undefined) {
        for (let idx = 0; idx < node.else.length; idx++) {
          const child = node.else[idx]
          if (child !== undefined) {
            await visit(child, `${path}.else[${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'parallel': {
      for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
        const branch = node.branches[bIdx]
        if (branch === undefined) continue
        for (let idx = 0; idx < branch.length; idx++) {
          const child = branch[idx]
          if (child !== undefined) {
            await visit(child, `${path}.branches[${bIdx}][${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'approval': {
      for (let idx = 0; idx < node.onApprove.length; idx++) {
        const child = node.onApprove[idx]
        if (child !== undefined) {
          await visit(child, `${path}.onApprove[${idx}]`, ctx)
        }
      }
      if (node.onReject !== undefined) {
        for (let idx = 0; idx < node.onReject.length; idx++) {
          const child = node.onReject[idx]
          if (child !== undefined) {
            await visit(child, `${path}.onReject[${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'clarification': {
      // Leaf — no refs to resolve.
      return
    }
    case 'persona': {
      await resolvePersonaNode(node, path, ctx)
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'route': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'complete': {
      return
    }
    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore': {
      // Leaf nodes — no refs to resolve in semantic stage.
      return
    }
    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails
      // compilation here.
      const _exhaustive: never = node
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint / Restore cross-node validation
// ---------------------------------------------------------------------------

/**
 * Walk the AST in flow order, collecting:
 *   • the set of node ids that appear before each `checkpoint` node, and
 *   • the labels declared by every `checkpoint` node anywhere in the flow.
 *
 * Then emit:
 *   • a non-fatal warning when `checkpoint.captureOutputOf` does not match
 *     any preceding node id (forward references are allowed at runtime but
 *     suspicious enough to surface), and
 *   • a hard error when `restore.checkpointLabel` does not match any
 *     declared checkpoint label in the same flow.
 */
export function validateCheckpointRestore(
  ast: FlowNode,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  // Pass 1 — collect all checkpoint labels declared anywhere in the flow.
  const declaredLabels = new Set<string>()
  collectCheckpointLabels(ast, declaredLabels)

  // Pass 2 — flow-order walk that maintains the rolling set of "earlier"
  // node ids. Each checkpoint validates against this rolling set; restores
  // validate against the labels collected in pass 1.
  const seenIds = new Set<string>()
  walkCheckpointRestore(ast, ROOT_PATH, seenIds, declaredLabels, errors, warnings)
}

function collectCheckpointLabels(node: FlowNode, out: Set<string>): void {
  switch (node.type) {
    case 'checkpoint': {
      const label = node.label ?? node.id
      if (typeof label === 'string' && label.length > 0) {
        out.add(label)
      }
      return
    }
    case 'sequence': {
      for (const child of node.nodes) collectCheckpointLabels(child, out)
      return
    }
    case 'for_each': {
      for (const child of node.body) collectCheckpointLabels(child, out)
      return
    }
    case 'branch': {
      for (const child of node.then) collectCheckpointLabels(child, out)
      if (node.else !== undefined) {
        for (const child of node.else) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'parallel': {
      for (const branch of node.branches) {
        for (const child of branch) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'approval': {
      for (const child of node.onApprove) collectCheckpointLabels(child, out)
      if (node.onReject !== undefined) {
        for (const child of node.onReject) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'persona':
    case 'route': {
      for (const child of node.body) collectCheckpointLabels(child, out)
      return
    }
    default:
      return
  }
}

function walkCheckpointRestore(
  node: FlowNode,
  path: string,
  seenIds: Set<string>,
  declaredLabels: Set<string>,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  // Validate this node first (so its own id is not yet in `seenIds` — a
  // checkpoint cannot capture itself).
  if (node.type === 'checkpoint') {
    if (!seenIds.has(node.captureOutputOf)) {
      warnings.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_REQUIRED_FIELD',
        message:
          `checkpoint.captureOutputOf="${node.captureOutputOf}" does not reference any node ` +
          `appearing earlier in the flow (forward reference).`,
      })
    }
  } else if (node.type === 'restore') {
    if (!declaredLabels.has(node.checkpointLabel)) {
      errors.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_REQUIRED_FIELD',
        message:
          `restore.checkpointLabel="${node.checkpointLabel}" does not match any ` +
          `checkpoint declared in the same flow.`,
      })
    }
  }

  // Then mark this node's id as "seen" before recursing into children — a
  // checkpoint or restore further down may legitimately refer back to the
  // current node.
  if (typeof node.id === 'string' && node.id.length > 0) {
    seenIds.add(node.id)
  }

  switch (node.type) {
    case 'sequence': {
      for (let idx = 0; idx < node.nodes.length; idx++) {
        const child = node.nodes[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.nodes[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    case 'for_each': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.body[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    case 'branch': {
      for (let idx = 0; idx < node.then.length; idx++) {
        const child = node.then[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.then[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      if (node.else !== undefined) {
        for (let idx = 0; idx < node.else.length; idx++) {
          const child = node.else[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.else[${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'parallel': {
      for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
        const branch = node.branches[bIdx]
        if (branch === undefined) continue
        for (let idx = 0; idx < branch.length; idx++) {
          const child = branch[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.branches[${bIdx}][${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'approval': {
      for (let idx = 0; idx < node.onApprove.length; idx++) {
        const child = node.onApprove[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.onApprove[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      if (node.onReject !== undefined) {
        for (let idx = 0; idx < node.onReject.length; idx++) {
          const child = node.onReject[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.onReject[${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'persona':
    case 'route': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.body[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    default:
      return
  }
}
