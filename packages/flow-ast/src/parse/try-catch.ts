import type { TryCatchNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseTryCatch(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): TryCatchNode | null {
  const bodyRaw = obj.body
  const catchRaw = obj.catch
  let failed = false

  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `try_catch.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }
  if (!Array.isArray(catchRaw)) {
    ctx.errors.push({
      code: catchRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `try_catch.catch must be an array, received ${describeJsType(catchRaw)}`,
      pointer: joinPointer(pointer, 'catch'),
    })
    failed = true
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) ctx.parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    if (Array.isArray(catchRaw)) ctx.parseNodeArray(catchRaw, joinPointer(pointer, 'catch'), ctx)
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  const catchBody = ctx.parseNodeArray(catchRaw as unknown[], joinPointer(pointer, 'catch'), ctx)
  const node: TryCatchNode = {
    type: 'try_catch',
    ...parseCommonNodeFields(obj, pointer, ctx),
    body,
    catch: catchBody,
  }
  if (typeof obj.errorVar === 'string') node.errorVar = obj.errorVar
  return node
}
