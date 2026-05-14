import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { describeJsType } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateLoop(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const condition = obj['condition']
  if (typeof condition !== 'string' || condition.length === 0) {
    issues.push({
      path: joinPath(path, 'condition'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `loop.condition is required (non-empty string), received ${describeJsType(condition)}`,
    })
    return null
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({ path, code: 'EMPTY_BODY', message: 'loop.body must contain at least one node' })
  }
  const node: FlowNode = { type: 'loop', ...common, condition, body }
  if (typeof obj['maxIterations'] === 'number') node.maxIterations = obj['maxIterations']
  return node
}
