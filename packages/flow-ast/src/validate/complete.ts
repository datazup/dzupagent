import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateComplete(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  let result: string | undefined
  if ('result' in obj && obj['result'] !== undefined) {
    const r = obj['result']
    if (typeof r === 'string') result = r
    else {
      issues.push({
        path: joinPath(path, 'result'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `complete.result must be a string when present, received ${describeJsType(r)}`,
      })
    }
  }
  const node: FlowNode = { type: 'complete', ...common }
  if (result !== undefined) node.result = result
  return node
}
