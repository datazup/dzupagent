import type { SetNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseSet(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): SetNode | null {
  if (!('assign' in obj)) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'set.assign is required',
      pointer: joinPointer(pointer, 'assign'),
    })
    return null
  }

  const assignRaw = obj.assign
  if (!isPlainObject(assignRaw)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: `set.assign must be an object, received ${describeJsType(assignRaw)}`,
      pointer: joinPointer(pointer, 'assign'),
    })
    return null
  }

  return {
    type: 'set',
    ...parseCommonNodeFields(obj, pointer, ctx),
    assign: assignRaw,
  }
}
