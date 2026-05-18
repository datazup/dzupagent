import type { ReturnToNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseReturnTo(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ReturnToNode | null {
  const targetIdRaw = obj.targetId
  const conditionRaw = obj.condition
  let failed = false

  if (typeof targetIdRaw !== 'string' || targetIdRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `return_to.targetId must be a non-empty string, received ${describeJsType(targetIdRaw)}`,
      pointer: joinPointer(pointer, 'targetId'),
    })
    failed = true
  }

  if (typeof conditionRaw !== 'string' || conditionRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `return_to.condition must be a non-empty string, received ${describeJsType(conditionRaw)}`,
      pointer: joinPointer(pointer, 'condition'),
    })
    failed = true
  }

  if (failed) return null

  const node: ReturnToNode = {
    type: 'return_to',
    ...parseCommonNodeFields(obj, pointer, ctx),
    targetId: targetIdRaw as string,
    condition: conditionRaw as string,
  }

  if (typeof obj.maxIterations === 'number') node.maxIterations = obj.maxIterations

  return node
}
