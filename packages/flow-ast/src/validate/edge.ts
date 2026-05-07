/**
 * FlowEdge schema and walker.
 *
 * flow-ast itself does not model edges — edges are implicit in the tree
 * shape (children arrays). However, downstream consumers (flow-compiler
 * lowerers, workflow-builder, skill-chain) need a canonical edge shape to
 * validate state transitions. Expose a minimal edge schema that captures
 * the stable slice shared by every lowerer target.
 */

import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import type { SchemaIssue } from './shared.js'

/**
 * Canonical edge shape shared by every lowered artifact target. This is
 * intentionally minimal — each target may extend it with additional fields
 * (e.g. `condition` for branch edges) but this core subset is always valid.
 */
export interface FlowEdge {
  /** Source node id (pipeline node id or dot-notation AST path). */
  from: string
  /** Target node id. */
  to: string
  /** Optional edge kind, when the lowerer emits more than one. */
  kind?: string
  /** Optional guard expression for conditional edges. */
  condition?: string
}

export function validateFlowEdge(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowEdge | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected edge object, received ${describeJsType(value)}`,
    })
    return null
  }
  const from = value['from']
  const to = value['to']
  let ok = true
  if (typeof from !== 'string' || from.length === 0) {
    issues.push({
      path: joinPath(path, 'from'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'edge.from is required (non-empty string)',
    })
    ok = false
  }
  if (typeof to !== 'string' || to.length === 0) {
    issues.push({
      path: joinPath(path, 'to'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'edge.to is required (non-empty string)',
    })
    ok = false
  }
  let kind: string | undefined
  if ('kind' in value && value['kind'] !== undefined) {
    const k = value['kind']
    if (typeof k === 'string') kind = k
    else {
      issues.push({
        path: joinPath(path, 'kind'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `edge.kind must be a string when present, received ${describeJsType(k)}`,
      })
    }
  }
  let condition: string | undefined
  if ('condition' in value && value['condition'] !== undefined) {
    const c = value['condition']
    if (typeof c === 'string') condition = c
    else {
      issues.push({
        path: joinPath(path, 'condition'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `edge.condition must be a string when present, received ${describeJsType(c)}`,
      })
    }
  }
  if (!ok) return null
  const edge: FlowEdge = { from: from as string, to: to as string }
  if (kind !== undefined) edge.kind = kind
  if (condition !== undefined) edge.condition = condition
  return edge
}
