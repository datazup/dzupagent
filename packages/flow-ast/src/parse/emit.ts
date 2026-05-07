import type { EmitNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseEmit(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): EmitNode | null {
  const eventRaw = obj.event
  if (typeof eventRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `emit.event must be a string, received ${describeJsType(eventRaw)}`,
      pointer: joinPointer(pointer, 'event'),
    })
    return null
  }

  let payload: Record<string, unknown> | undefined
  if ('payload' in obj) {
    const payloadRaw = obj.payload
    if (payloadRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (isPlainObject(payloadRaw)) {
      payload = payloadRaw
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `emit.payload must be an object when present, received ${describeJsType(payloadRaw)}`,
        pointer: joinPointer(pointer, 'payload'),
      })
    }
  }

  const node: EmitNode = {
    type: 'emit',
    ...parseCommonNodeFields(obj, pointer, ctx),
    event: eventRaw,
  }
  if (payload !== undefined) node.payload = payload
  return node
}
