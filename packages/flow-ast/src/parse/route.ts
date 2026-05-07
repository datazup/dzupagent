import type { RouteNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseRoute(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): RouteNode | null {
  const strategyRaw = obj.strategy
  const bodyRaw = obj.body
  let failed = false

  if (strategyRaw !== 'capability' && strategyRaw !== 'fixed-provider') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `route.strategy must be "capability" or "fixed-provider", received ${describeJsType(strategyRaw)}`,
      pointer: joinPointer(pointer, 'strategy'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `route.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  let tags: string[] | undefined
  if ('tags' in obj) {
    const tagsRaw = obj.tags
    if (Array.isArray(tagsRaw) && tagsRaw.every((v) => typeof v === 'string')) {
      tags = tagsRaw as string[]
    } else if (Array.isArray(tagsRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `route.tags must be an array of strings`,
        pointer: joinPointer(pointer, 'tags'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `route.tags must be an array when present, received ${describeJsType(tagsRaw)}`,
        pointer: joinPointer(pointer, 'tags'),
      })
    }
  }

  let provider: string | undefined
  if ('provider' in obj) {
    const providerRaw = obj.provider
    if (typeof providerRaw === 'string') {
      provider = providerRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `route.provider must be a string when present, received ${describeJsType(providerRaw)}`,
        pointer: joinPointer(pointer, 'provider'),
      })
    }
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) ctx.parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  const node: RouteNode = {
    type: 'route',
    ...parseCommonNodeFields(obj, pointer, ctx),
    strategy: strategyRaw as 'capability' | 'fixed-provider',
    body,
  }
  if (tags !== undefined) node.tags = tags
  if (provider !== undefined) node.provider = provider
  return node
}
