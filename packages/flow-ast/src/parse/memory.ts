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

  if (
    operationRaw !== 'read' &&
    operationRaw !== 'write' &&
    operationRaw !== 'list' &&
    operationRaw !== 'search'
  ) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `memory.operation must be "read", "write", "list", or "search", received ${describeJsType(operationRaw)}`,
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

  let query: string | undefined
  let limit: number | undefined
  parseOptionalMemoryStringField(obj, 'query', pointer, ctx, (value) => {
    query = value
  })
  if ('limit' in obj && obj.limit !== undefined) {
    const limitRaw = obj.limit
    if (typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0) {
      limit = limitRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `memory.limit must be a positive integer, received ${describeJsType(limitRaw)}`,
        pointer: joinPointer(pointer, 'limit'),
      })
      failed = true
    }
  }

  if (operationRaw === 'search' && (query === undefined || query.length === 0)) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'memory.query is required when operation is "search"',
      pointer: joinPointer(pointer, 'query'),
    })
    failed = true
  }

  if (failed) return null
  return {
    type: 'memory',
    ...parseCommonNodeFields(obj, pointer, ctx),
    operation: operationRaw as 'read' | 'write' | 'list' | 'search',
    tier: tierRaw as 'session' | 'project' | 'workspace',
    ...optionalStrings,
    ...(query !== undefined ? { query } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}
