import type { FlowNode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateAction(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const toolRef = obj['toolRef']
  const input = obj['input']
  let ok = true
  if (typeof toolRef !== 'string' || toolRef.length === 0) {
    issues.push({
      path: joinPath(path, 'toolRef'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'action.toolRef is required (non-empty string)',
    })
    ok = false
  }
  if (!isPlainObject(input)) {
    issues.push({
      path: joinPath(path, 'input'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'action.input is required (object, may be empty)',
    })
    ok = false
  }
  let personaRef: string | undefined
  if ('personaRef' in obj) {
    const p = obj['personaRef']
    if (typeof p === 'string') personaRef = p
    else {
      issues.push({
        path: joinPath(path, 'personaRef'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `action.personaRef must be a string when present, received ${describeJsType(p)}`,
      })
    }
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'action',
    ...common,
    toolRef: toolRef as string,
    input: input as Record<string, unknown>,
  }
  if (personaRef !== undefined) node.personaRef = personaRef
  return node
}
