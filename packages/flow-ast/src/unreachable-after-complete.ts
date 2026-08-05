/**
 * Structural pass that flags siblings written after a `complete` node in the
 * same sequence-scope. Since the lowering tail fix, `complete` is a hard
 * terminal: the compiler emits no continuation edge past it, so any later
 * sibling in the same scope can never execute. Authoring one is a mistake the
 * validator should surface, not something to discover from a lowering warning.
 *
 * Diagnostics are ERRORS: unlike output-key collisions there is no legitimate
 * flow that carries unreachable siblings.
 */
import type { FlowNode } from './types.js'

export const UNREACHABLE_AFTER_COMPLETE_CODE = 'unreachable_after_complete'
export const UNREACHABLE_AFTER_COMPLETE_SEVERITY = 'error'

export interface UnreachableAfterCompleteDiagnostic {
  code: typeof UNREACHABLE_AFTER_COMPLETE_CODE
  severity: typeof UNREACHABLE_AFTER_COMPLETE_SEVERITY
  message: string
  /** Id of the terminal `complete` node. */
  completeId: string
  /** Id of the first unreachable sibling. */
  unreachableId: string
  /** Sequence-scope path (e.g. "root.branch[id=b1].then"). */
  scopePath: string
  /** How many siblings follow the terminal node in this scope. */
  unreachableCount: number
}

function walkScope(
  nodes: FlowNode[],
  scopePath: string,
  diags: UnreachableAfterCompleteDiagnostic[],
): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]!
    if ((n as { type: string }).type === 'complete' && i < nodes.length - 1) {
      const completeId = n.id ?? '(anon)'
      const next = nodes[i + 1]!
      const unreachableId = next.id ?? '(anon)'
      diags.push({
        code: UNREACHABLE_AFTER_COMPLETE_CODE,
        severity: UNREACHABLE_AFTER_COMPLETE_SEVERITY,
        message:
          `Node "${unreachableId}" follows terminal complete node "${completeId}" ` +
          `in scope ${scopePath} and can never execute.`,
        completeId,
        unreachableId,
        scopePath,
        unreachableCount: nodes.length - 1 - i,
      })
      // Report once per scope; everything after the first complete is covered
      // by unreachableCount.
      break
    }
  }
  for (const n of nodes) descend(n, scopePath, diags)
}

function descend(
  node: FlowNode,
  parentPath: string,
  diags: UnreachableAfterCompleteDiagnostic[],
): void {
  const anyNode = node as unknown as Record<string, unknown>
  const kind = (anyNode.type as string | undefined) ?? 'unknown'
  const id = (anyNode.id as string | undefined) ?? '(anon)'
  const base = `${parentPath}.${kind}[id=${id}]`

  for (const field of ['body', 'then', 'else', 'onApprove', 'onReject'] as const) {
    const arr = anyNode[field]
    if (Array.isArray(arr)) walkScope(arr as FlowNode[], `${base}.${field}`, diags)
  }
  if (kind === 'try_catch' && Array.isArray(anyNode.catch)) {
    walkScope(anyNode.catch as FlowNode[], `${base}.catch`, diags)
  }
  if (kind === 'parallel' && Array.isArray(anyNode.branches)) {
    ;(anyNode.branches as FlowNode[][]).forEach((branch, i) => {
      walkScope(branch, `${base}.branches[${i}]`, diags)
    })
  }
  if (kind === 'sequence' && Array.isArray(anyNode.nodes)) {
    walkScope(anyNode.nodes as FlowNode[], `${base}.nodes`, diags)
  }
}

/**
 * Run the reachability check against a parsed root flow node. The root is
 * expected to be a `sequence` for canonical authored flows, but any node type
 * is accepted (treated as a singleton scope).
 */
export function checkUnreachableAfterComplete(
  root: FlowNode,
): UnreachableAfterCompleteDiagnostic[] {
  const diags: UnreachableAfterCompleteDiagnostic[] = []
  const anyRoot = root as unknown as Record<string, unknown>
  if (anyRoot.type === 'sequence' && Array.isArray(anyRoot.nodes)) {
    walkScope(anyRoot.nodes as FlowNode[], 'root', diags)
  } else {
    walkScope([root], 'root', diags)
  }
  return diags
}
