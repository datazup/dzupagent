import type { SequenceNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseSequence(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): SequenceNode | null {
  const nodesRaw = obj.nodes
  if (!Array.isArray(nodesRaw)) {
    ctx.errors.push({
      code: nodesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `sequence.nodes must be an array, received ${describeJsType(nodesRaw)}`,
      pointer: joinPointer(pointer, 'nodes'),
    })
    return null
  }
  const nodes = ctx.parseNodeArray(nodesRaw, joinPointer(pointer, 'nodes'), ctx)
  return {
    type: 'sequence',
    ...parseCommonNodeFields(obj, pointer, ctx),
    nodes,
  }
}
