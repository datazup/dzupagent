import type { BranchNode, FlowNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseBranch(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): BranchNode | null {
  const conditionRaw = obj.condition
  const thenRaw = obj.then
  let failed = false

  if (typeof conditionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `branch.condition must be a string, received ${describeJsType(conditionRaw)}`,
      pointer: joinPointer(pointer, 'condition'),
    })
    failed = true
  }
  if (!Array.isArray(thenRaw)) {
    ctx.errors.push({
      code: thenRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `branch.then must be an array, received ${describeJsType(thenRaw)}`,
      pointer: joinPointer(pointer, 'then'),
    })
    failed = true
  }

  let elseBranch: FlowNode[] | undefined
  let elseDropped = false
  if ('else' in obj) {
    const elseRaw = obj.else
    if (Array.isArray(elseRaw)) {
      // We'll walk it after we know whether the node will survive.
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `branch.else must be an array when present, received ${describeJsType(elseRaw)}`,
        pointer: joinPointer(pointer, 'else'),
      })
      elseDropped = true
    }
  }

  if (failed) {
    if (Array.isArray(thenRaw)) ctx.parseNodeArray(thenRaw, joinPointer(pointer, 'then'), ctx)
    if ('else' in obj && Array.isArray(obj.else)) ctx.parseNodeArray(obj.else, joinPointer(pointer, 'else'), ctx)
    return null
  }

  const thenNodes = ctx.parseNodeArray(thenRaw as unknown[], joinPointer(pointer, 'then'), ctx)
  if ('else' in obj && Array.isArray(obj.else)) {
    elseBranch = ctx.parseNodeArray(obj.else, joinPointer(pointer, 'else'), ctx)
  }

  const node: BranchNode = {
    type: 'branch',
    ...parseCommonNodeFields(obj, pointer, ctx),
    condition: conditionRaw as string,
    then: thenNodes,
  }
  if (elseBranch !== undefined && !elseDropped) node.else = elseBranch
  return node
}
