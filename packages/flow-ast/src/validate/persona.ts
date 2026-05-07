import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'
import { validateNodeArray } from './dispatch.js'

export function validatePersona(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const personaId = obj['personaId']
  let ok = true
  if (typeof personaId !== 'string' || personaId.length === 0) {
    issues.push({
      path: joinPath(path, 'personaId'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'persona.personaId is required (non-empty string)',
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'persona.body must contain at least one node',
    })
  }
  if (!ok) return null
  return { type: 'persona', ...common, personaId: personaId as string, body }
}
