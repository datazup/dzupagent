import type { SubflowNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseSubflow(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): SubflowNode | null {
  const flowRefRaw = obj.flowRef
  if (typeof flowRefRaw !== 'string' || flowRefRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `subflow.flowRef must be a non-empty string, received ${describeJsType(flowRefRaw)}`,
      pointer: joinPointer(pointer, 'flowRef'),
    })
    return null
  }

  const node: SubflowNode = {
    type: 'subflow',
    ...parseCommonNodeFields(obj, pointer, ctx),
    flowRef: flowRefRaw,
  }

  if ('input' in obj && obj.input !== undefined) {
    if (isPlainObject(obj.input)) {
      node.input = obj.input
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `subflow.input must be an object when present, received ${describeJsType(obj.input)}`,
        pointer: joinPointer(pointer, 'input'),
      })
    }
  }

  if (typeof obj.outputVar === 'string') node.outputVar = obj.outputVar
  return node
}
