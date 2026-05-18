import type { PromptNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parsePrompt(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): PromptNode | null {
  const userPromptRaw = obj.userPrompt
  let failed = false

  if (typeof userPromptRaw !== 'string' || userPromptRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `prompt.userPrompt must be a non-empty string, received ${describeJsType(userPromptRaw)}`,
      pointer: joinPointer(pointer, 'userPrompt'),
    })
    failed = true
  }

  if (failed) return null

  const node: PromptNode = {
    type: 'prompt',
    ...parseCommonNodeFields(obj, pointer, ctx),
    userPrompt: userPromptRaw as string,
  }

  if (typeof obj.systemPrompt === 'string') node.systemPrompt = obj.systemPrompt
  if (typeof obj.outputKey === 'string') node.outputKey = obj.outputKey
  if (typeof obj.provider === 'string') node.provider = obj.provider
  if (typeof obj.model === 'string') node.model = obj.model
  if (typeof obj.tools === 'boolean') node.tools = obj.tools

  return node
}
