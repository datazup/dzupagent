import type { MemoryNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
  parseOptionalMemoryStringField,
} from './shared.js'

export function parseMemory(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): MemoryNode | null {
  const operationRaw = obj.operation
  const tierRaw = obj.tier
  let failed = false

  if (operationRaw !== 'read' && operationRaw !== 'write' && operationRaw !== 'list') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `memory.operation must be "read", "write", or "list", received ${describeJsType(operationRaw)}`,
      pointer: joinPointer(pointer, 'operation'),
    })
    failed = true
  }
  if (tierRaw !== 'session' && tierRaw !== 'project' && tierRaw !== 'workspace') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `memory.tier must be "session", "project", or "workspace", received ${describeJsType(tierRaw)}`,
      pointer: joinPointer(pointer, 'tier'),
    })
    failed = true
  }

  const optionalStrings: Pick<MemoryNode, 'key' | 'valueExpr' | 'outputVar'> = {}
  parseOptionalMemoryStringField(obj, 'key', pointer, ctx, (value) => {
    optionalStrings.key = value
  })
  parseOptionalMemoryStringField(obj, 'valueExpr', pointer, ctx, (value) => {
    optionalStrings.valueExpr = value
  })
  parseOptionalMemoryStringField(obj, 'outputVar', pointer, ctx, (value) => {
    optionalStrings.outputVar = value
  })

  if (failed) return null
  return {
    type: 'memory',
    ...parseCommonNodeFields(obj, pointer, ctx),
    operation: operationRaw as 'read' | 'write' | 'list',
    tier: tierRaw as 'session' | 'project' | 'workspace',
    ...optionalStrings,
  }
}
