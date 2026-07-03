/**
 * Compile-time pass that flags two `agent` nodes sharing the same `output.key`
 * within the same sequence-scope. Cross-scope duplicates (try/catch, parallel
 * branches, branch.then/else, etc.) are allowed because they cannot both
 * execute (or, in the case of for_each, they execute in separate iteration
 * scopes that do not overwrite each other within a single iteration).
 *
 * Returned diagnostics are WARNINGS in this milestone; a subsequent milestone
 * promotes them to errors after surveying real-world flows.
 */
import type { AgentNode, FlowNode } from './types.js'

export const OUTPUT_KEY_UNIQUENESS_CODE = 'output_key_collision'
export const OUTPUT_KEY_UNIQUENESS_SEVERITY = 'warning'

export interface OutputKeyDiagnostic {
  code: typeof OUTPUT_KEY_UNIQUENESS_CODE
  severity: typeof OUTPUT_KEY_UNIQUENESS_SEVERITY
  message: string
  /** Both colliding agent node ids, lexicographically sorted. */
  relatedIds: string[]
  /** Sequence-scope path (e.g. "root.try_catch[id=t1].try"). */
  scopePath: string
  /** The colliding key. */
  key: string
}

function isAgent(n: FlowNode): n is AgentNode {
  return (n as { type: string }).type === 'agent'
}

function pushDiagnostic(
  diags: OutputKeyDiagnostic[],
  scopePath: string,
  key: string,
  firstId: string,
  secondId: string,
): void {
  const pair = [firstId, secondId].sort()
  diags.push({
    code: OUTPUT_KEY_UNIQUENESS_CODE,
    severity: OUTPUT_KEY_UNIQUENESS_SEVERITY,
    message:
      `Two agent nodes in the same sequence scope use output.key "${key}" ` +
      `("${pair[0]}" and "${pair[1]}"). The second write will overwrite the first.`,
    relatedIds: pair,
    scopePath,
    key,
  })
}

function walkScope(
  nodes: FlowNode[],
  scopePath: string,
  diags: OutputKeyDiagnostic[],
): void {
  // Within THIS sequence-scope, collect output.key -> node-id map.
  const seen = new Map<string, string>()
  for (const n of nodes) {
    if (isAgent(n)) {
      const key = n.output?.key
      if (typeof key === 'string' && key.length > 0) {
        const myId = n.id ?? '(anon)'
        const existingId = seen.get(key)
        if (existingId) {
          pushDiagnostic(diags, scopePath, key, existingId, myId)
        } else {
          seen.set(key, myId)
        }
      }
    }
    // Always descend; each child scope is fresh.
    descend(n, scopePath, diags)
  }
}

function descend(node: FlowNode, parentPath: string, diags: OutputKeyDiagnostic[]): void {
  const anyNode = node as unknown as Record<string, unknown>
  const kind = (anyNode.type as string | undefined) ?? 'unknown'
  const id = (anyNode.id as string | undefined) ?? '(anon)'
  const base = `${parentPath}.${kind}[id=${id}]`

  // Single-body scopes (for_each.body, persona.body, route.body, loop.body,
  // try_catch.body, branch.then, branch.else, approval.onApprove,
  // approval.onReject).
  for (const field of ['body', 'then', 'else', 'onApprove', 'onReject'] as const) {
    const arr = anyNode[field]
    if (Array.isArray(arr)) walkScope(arr as FlowNode[], `${base}.${field}`, diags)
  }
  // try_catch has try/catch (note: `body` is also handled above for try_catch).
  if (kind === 'try_catch') {
    if (Array.isArray(anyNode.catch)) walkScope(anyNode.catch as FlowNode[], `${base}.catch`, diags)
  }
  // parallel.branches: each branch is its own scope.
  if (kind === 'parallel' && Array.isArray(anyNode.branches)) {
    ;(anyNode.branches as FlowNode[][]).forEach((branch, i) => {
      walkScope(branch, `${base}.branches[${i}]`, diags)
    })
  }
  // sequence.nodes: nested sequence forms a fresh scope.
  if (kind === 'sequence' && Array.isArray(anyNode.nodes)) {
    walkScope(anyNode.nodes as FlowNode[], `${base}.nodes`, diags)
  }
}

/**
 * Run the uniqueness check against a parsed root flow node. The root is
 * expected to be a `sequence` for canonical authored flows, but any node
 * type is accepted (treated as a singleton scope).
 */
export function checkOutputKeyUniqueness(root: FlowNode): OutputKeyDiagnostic[] {
  const diags: OutputKeyDiagnostic[] = []
  const anyRoot = root as unknown as Record<string, unknown>
  if (anyRoot.type === 'sequence' && Array.isArray(anyRoot.nodes)) {
    walkScope(anyRoot.nodes as FlowNode[], 'root', diags)
  } else {
    // Root isn't a sequence — treat the single node as a scope of one.
    walkScope([root], 'root', diags)
  }
  return diags
}
