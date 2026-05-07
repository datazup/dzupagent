import type { FlowNode } from '../types.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'
import { validateNodeArray } from './dispatch.js'

export function validateSequence(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const nodes = validateNodeArray(obj['nodes'], `${path}.nodes`, issues)
  if (nodes === null) return null
  if (nodes.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'sequence.nodes must contain at least one node',
    })
  }
  return { type: 'sequence', ...common, nodes }
}
