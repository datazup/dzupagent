import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validatePrompt(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const userPrompt = obj['userPrompt']
  if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
    issues.push({
      path: joinPath(path, 'userPrompt'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `prompt.userPrompt is required (non-empty string), received ${describeJsType(userPrompt)}`,
    })
    return null
  }
  const node: FlowNode = { type: 'prompt', ...common, userPrompt }
  if (typeof obj['systemPrompt'] === 'string') node.systemPrompt = obj['systemPrompt']
  if (typeof obj['outputKey'] === 'string') node.outputKey = obj['outputKey']
  if (typeof obj['provider'] === 'string') node.provider = obj['provider']
  if (typeof obj['model'] === 'string') node.model = obj['model']
  if (typeof obj['tools'] === 'boolean') node.tools = obj['tools']
  return node
}
