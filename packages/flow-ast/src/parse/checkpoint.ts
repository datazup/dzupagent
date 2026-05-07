import type { CheckpointNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseCheckpoint(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): CheckpointNode | null {
  const captureOutputOfRaw = obj.captureOutputOf
  if (typeof captureOutputOfRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `checkpoint.captureOutputOf must be a string, received ${describeJsType(captureOutputOfRaw)}`,
      pointer: joinPointer(pointer, 'captureOutputOf'),
    })
    return null
  }

  let label: string | undefined
  if ('label' in obj) {
    const labelRaw = obj.label
    if (labelRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof labelRaw === 'string') {
      label = labelRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `checkpoint.label must be a string when present, received ${describeJsType(labelRaw)}`,
        pointer: joinPointer(pointer, 'label'),
      })
    }
  }

  const node: CheckpointNode = {
    type: 'checkpoint',
    ...parseCommonNodeFields(obj, pointer, ctx),
    captureOutputOf: captureOutputOfRaw,
  }
  if (label !== undefined) node.label = label
  return node
}
