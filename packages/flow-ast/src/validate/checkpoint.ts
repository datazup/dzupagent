import type { CheckpointNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateCheckpoint(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): CheckpointNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const captureOutputOf = obj['captureOutputOf']
  if (typeof captureOutputOf !== 'string' || captureOutputOf.length === 0) {
    issues.push({
      path: joinPath(path, 'captureOutputOf'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'checkpoint.captureOutputOf is required (non-empty string)',
    })
    return null
  }
  let label: string | undefined
  if ('label' in obj && obj['label'] !== undefined) {
    const l = obj['label']
    if (typeof l === 'string') label = l
    else {
      issues.push({
        path: joinPath(path, 'label'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `checkpoint.label must be a string when present, received ${describeJsType(l)}`,
      })
    }
  }
  const node: CheckpointNode = { type: 'checkpoint', ...common, captureOutputOf }
  if (label !== undefined) node.label = label
  return node
}
