import type { FlowNode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateSubflow(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const flowRef = obj['flowRef']
  if (typeof flowRef !== 'string' || flowRef.length === 0) {
    issues.push({
      path: joinPath(path, 'flowRef'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `subflow.flowRef is required (non-empty string), received ${describeJsType(flowRef)}`,
    })
    return null
  }
  const node: FlowNode = { type: 'subflow', ...common, flowRef }
  if ('input' in obj && obj['input'] !== undefined) {
    if (isPlainObject(obj['input'])) node.input = obj['input']
    else {
      issues.push({
        path: joinPath(path, 'input'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `subflow.input must be an object when present, received ${describeJsType(obj['input'])}`,
      })
    }
  }
  if (typeof obj['outputVar'] === 'string') node.outputVar = obj['outputVar']
  return node
}
