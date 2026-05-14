import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateWait(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const durationMs = obj['durationMs']
  if (typeof durationMs !== 'number' || durationMs < 0) {
    issues.push({
      path: joinPath(path, 'durationMs'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `wait.durationMs is required (non-negative number), received ${describeJsType(durationMs)}`,
    })
    return null
  }
  return { type: 'wait', ...common, durationMs }
}
