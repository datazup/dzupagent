import type { SetNode } from '../types.js'
import { isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateSet(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): SetNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const assignRaw = obj['assign']
  if (!isPlainObject(assignRaw)) {
    issues.push({
      path: joinPath(path, 'assign'),
      code: 'MISSING_REQUIRED_FIELD',
      message: '`assign` is required and must be an object',
    })
    return null
  }
  return { type: 'set', ...common, assign: assignRaw }
}
