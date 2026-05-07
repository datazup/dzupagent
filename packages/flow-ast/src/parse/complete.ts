import type { CompleteNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseComplete(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): CompleteNode | null {
  let result: string | undefined
  if ('result' in obj) {
    const resultRaw = obj.result
    if (typeof resultRaw === 'string') {
      result = resultRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `complete.result must be a string when present, received ${describeJsType(resultRaw)}`,
        pointer: joinPointer(pointer, 'result'),
      })
    }
  }
  const node: CompleteNode = {
    type: 'complete',
    ...parseCommonNodeFields(obj, pointer, ctx),
  }
  if (result !== undefined) node.result = result
  return node
}
