import type { ForEachNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseForEach(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ForEachNode | null {
  const sourceRaw = obj.source
  const asRaw = obj.as
  const bodyRaw = obj.body
  let failed = false

  if (typeof sourceRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.source must be a string, received ${describeJsType(sourceRaw)}`,
      pointer: joinPointer(pointer, 'source'),
    })
    failed = true
  }
  if (typeof asRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.as must be a string, received ${describeJsType(asRaw)}`,
      pointer: joinPointer(pointer, 'as'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `for_each.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    // Walk body anyway if it's an array, to surface nested errors in document order
    if (Array.isArray(bodyRaw)) {
      ctx.parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    }
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  return {
    type: 'for_each',
    ...parseCommonNodeFields(obj, pointer, ctx),
    source: sourceRaw as string,
    as: asRaw as string,
    body,
  }
}
