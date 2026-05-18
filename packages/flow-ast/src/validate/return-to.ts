import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateReturnTo(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const targetId = obj['targetId']
  const condition = obj['condition']
  let ok = true

  if (typeof targetId !== 'string' || targetId.length === 0) {
    issues.push({
      path: joinPath(path, 'targetId'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `return_to.targetId is required (non-empty string), received ${describeJsType(targetId)}`,
    })
    ok = false
  }
  if (typeof condition !== 'string' || condition.length === 0) {
    issues.push({
      path: joinPath(path, 'condition'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `return_to.condition is required (non-empty string), received ${describeJsType(condition)}`,
    })
    ok = false
  }

  if (!ok) return null
  const node: FlowNode = {
    type: 'return_to',
    ...common,
    targetId: targetId as string,
    condition: condition as string,
  }
  if (typeof obj['maxIterations'] === 'number') node.maxIterations = obj['maxIterations']
  return node
}
