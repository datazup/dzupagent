import type { LoopNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseLoop(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): LoopNode | null {
  const conditionRaw = obj.condition
  const bodyRaw = obj.body
  let failed = false

  if (typeof conditionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `loop.condition must be a string, received ${describeJsType(conditionRaw)}`,
      pointer: joinPointer(pointer, 'condition'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `loop.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) ctx.parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  const node: LoopNode = {
    type: 'loop',
    ...parseCommonNodeFields(obj, pointer, ctx),
    condition: conditionRaw as string,
    body,
  }
  if (typeof obj.maxIterations === 'number') node.maxIterations = obj.maxIterations
  return node
}
