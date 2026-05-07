import type { FlowNode, ParallelNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseParallel(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ParallelNode | null {
  const branchesRaw = obj.branches
  if (!Array.isArray(branchesRaw)) {
    ctx.errors.push({
      code: branchesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `parallel.branches must be an array, received ${describeJsType(branchesRaw)}`,
      pointer: joinPointer(pointer, 'branches'),
    })
    return null
  }

  const branches: FlowNode[][] = []
  for (let i = 0; i < branchesRaw.length; i++) {
    const branchPointer = joinPointer(joinPointer(pointer, 'branches'), String(i))
    const branchVal = branchesRaw[i]
    if (!Array.isArray(branchVal)) {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `parallel.branches[${i}] must be an array of nodes, received ${describeJsType(branchVal)}`,
        pointer: branchPointer,
      })
      continue
    }
    branches.push(ctx.parseNodeArray(branchVal, branchPointer, ctx))
  }

  return {
    type: 'parallel',
    ...parseCommonNodeFields(obj, pointer, ctx),
    branches,
  }
}
