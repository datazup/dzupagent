import type { ForEachNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseForEach(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ForEachNode | null {
  const sourceRaw = obj.source
  const asRaw = obj.as
  const bodyRaw = obj.body
  let failed = false

  if (typeof sourceRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.source must be a string, received ${describeJsType(sourceRaw)}`,
      pointer: joinPointer(pointer, 'source'),
    })
    failed = true
  }
  if (typeof asRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.as must be a string, received ${describeJsType(asRaw)}`,
      pointer: joinPointer(pointer, 'as'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `for_each.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) {
      ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
    }
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)

  const attachAs = typeof obj.attachAs === 'string' ? obj.attachAs : undefined
  const concurrency = typeof obj.concurrency === 'number' ? Math.min(Math.max(1, Math.floor(obj.concurrency)), 8) : undefined

  let collect: ForEachNode['collect'] | undefined
  if (obj.collect && typeof obj.collect === 'object' && !Array.isArray(obj.collect)) {
    const c = obj.collect as Record<string, unknown>
    if (typeof c.from === 'string' && typeof c.into === 'string') {
      collect = { from: c.from, into: c.into }
    }
  }

  let accumulator: ForEachNode['accumulator'] | undefined
  if (obj.accumulator && typeof obj.accumulator === 'object' && !Array.isArray(obj.accumulator)) {
    const a = obj.accumulator as Record<string, unknown>
    if (typeof a.key === 'string') {
      accumulator = {
        key: a.key,
        ...(typeof a.window === 'number' ? { window: Math.max(1, Math.floor(a.window)) } : {}),
        ...(a.initialValue !== undefined ? { initialValue: a.initialValue } : {}),
      }
    }
  }

  return {
    type: 'for_each',
    ...parseCommonNodeFields(obj, pointer, ctx),
    source: sourceRaw as string,
    as: asRaw as string,
    body,
    ...(attachAs !== undefined ? { attachAs } : {}),
    ...(collect !== undefined ? { collect } : {}),
    ...(accumulator !== undefined ? { accumulator } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  }
}
