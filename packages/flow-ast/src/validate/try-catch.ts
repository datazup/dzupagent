import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateTryCatch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({ path, code: 'EMPTY_BODY', message: 'try_catch.body must contain at least one node' })
  }
  const catchBody = validateNodeArray(obj['catch'], joinPath(path, 'catch'), issues)
  if (catchBody === null) return null
  const node: FlowNode = { type: 'try_catch', ...common, body, catch: catchBody }
  if (typeof obj['errorVar'] === 'string') node.errorVar = obj['errorVar']
  return node
}
