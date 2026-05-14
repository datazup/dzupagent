import type { WaitNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseWait(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): WaitNode | null {
  const durationRaw = obj.durationMs
  if (typeof durationRaw !== 'number' || durationRaw < 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `wait.durationMs must be a non-negative number, received ${describeJsType(durationRaw)}`,
      pointer: joinPointer(pointer, 'durationMs'),
    })
    return null
  }
  return {
    type: 'wait',
    ...parseCommonNodeFields(obj, pointer, ctx),
    durationMs: durationRaw,
  }
}
