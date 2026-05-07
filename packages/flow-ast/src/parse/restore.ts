import type { RestoreNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseRestore(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): RestoreNode | null {
  const checkpointLabelRaw = obj.checkpointLabel
  if (typeof checkpointLabelRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `restore.checkpointLabel must be a string, received ${describeJsType(checkpointLabelRaw)}`,
      pointer: joinPointer(pointer, 'checkpointLabel'),
    })
    return null
  }

  let onNotFound: 'fail' | 'skip' | undefined
  if ('onNotFound' in obj) {
    const onNotFoundRaw = obj.onNotFound
    if (onNotFoundRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (onNotFoundRaw === 'fail' || onNotFoundRaw === 'skip') {
      onNotFound = onNotFoundRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `restore.onNotFound must be "fail" or "skip" when present, received ${describeJsType(onNotFoundRaw)}`,
        pointer: joinPointer(pointer, 'onNotFound'),
      })
    }
  }

  const node: RestoreNode = {
    type: 'restore',
    ...parseCommonNodeFields(obj, pointer, ctx),
    checkpointLabel: checkpointLabelRaw,
  }
  if (onNotFound !== undefined) node.onNotFound = onNotFound
  return node
}
