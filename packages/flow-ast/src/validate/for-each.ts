import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateForEach(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const source = obj['source']
  const as = obj['as']
  let ok = true
  if (typeof source !== 'string' || source.length === 0) {
    issues.push({
      path: joinPath(path, 'source'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.source is required (non-empty string)',
    })
    ok = false
  }
  if (typeof as !== 'string' || as.length === 0) {
    issues.push({
      path: joinPath(path, 'as'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.as is required (non-empty string)',
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'for_each.body must contain at least one node',
    })
  }
  if (!ok) return null
  return {
    type: 'for_each',
    ...common,
    source: source as string,
    as: as as string,
    body,
  }
}
