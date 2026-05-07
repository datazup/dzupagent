import type { FlowNode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateSpawn(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const templateRef = obj['templateRef']
  if (typeof templateRef !== 'string' || templateRef.length === 0) {
    issues.push({
      path: joinPath(path, 'templateRef'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'spawn.templateRef is required (non-empty string)',
    })
    return null
  }
  let input: Record<string, unknown> | undefined
  if ('input' in obj && obj['input'] !== undefined) {
    if (isPlainObject(obj['input'])) input = obj['input']
    else {
      issues.push({
        path: joinPath(path, 'input'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `spawn.input must be an object when present, received ${describeJsType(obj['input'])}`,
      })
    }
  }
  let waitForCompletion: boolean | undefined
  if ('waitForCompletion' in obj && obj['waitForCompletion'] !== undefined) {
    if (typeof obj['waitForCompletion'] === 'boolean') waitForCompletion = obj['waitForCompletion']
    else {
      issues.push({
        path: joinPath(path, 'waitForCompletion'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `spawn.waitForCompletion must be a boolean when present, received ${describeJsType(obj['waitForCompletion'])}`,
      })
    }
  }
  const node: FlowNode = { type: 'spawn', ...common, templateRef }
  if (input !== undefined) node.input = input
  if (waitForCompletion !== undefined) node.waitForCompletion = waitForCompletion
  return node
}
