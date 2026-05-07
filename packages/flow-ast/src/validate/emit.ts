import type { EmitNode } from '../types.js'
import { isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateEmit(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): EmitNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const event = obj['event']
  if (typeof event !== 'string' || event.length === 0) {
    issues.push({
      path: joinPath(path, 'event'),
      code: 'MISSING_REQUIRED_FIELD',
      message: '`event` is required and must be a non-empty string',
    })
    return null
  }
  let payload: Record<string, unknown> | undefined
  if ('payload' in obj && obj['payload'] !== undefined) {
    if (isPlainObject(obj['payload'])) {
      payload = obj['payload']
    } else {
      issues.push({
        path: joinPath(path, 'payload'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'emit.payload must be an object when present',
      })
    }
  }
  const node: EmitNode = { type: 'emit', ...common, event }
  if (payload !== undefined) node.payload = payload
  return node
}
