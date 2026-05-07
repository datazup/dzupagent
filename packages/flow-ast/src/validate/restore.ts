import type { RestoreNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateRestore(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): RestoreNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const checkpointLabel = obj['checkpointLabel']
  if (typeof checkpointLabel !== 'string' || checkpointLabel.length === 0) {
    issues.push({
      path: joinPath(path, 'checkpointLabel'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'restore.checkpointLabel is required (non-empty string)',
    })
    return null
  }
  let onNotFound: 'fail' | 'skip' | undefined
  if ('onNotFound' in obj && obj['onNotFound'] !== undefined) {
    const v = obj['onNotFound']
    if (v === 'fail' || v === 'skip') onNotFound = v
    else {
      issues.push({
        path: joinPath(path, 'onNotFound'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `restore.onNotFound must be "fail" or "skip" when present, received ${describeJsType(v) === 'string' ? JSON.stringify(v) : describeJsType(v)}`,
      })
      return null
    }
  }
  const node: RestoreNode = { type: 'restore', ...common, checkpointLabel }
  if (onNotFound !== undefined) node.onNotFound = onNotFound
  return node
}
