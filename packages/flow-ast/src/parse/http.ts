import type { HttpNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function parseHttp(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): HttpNode | null {
  const urlRaw = obj.url
  if (typeof urlRaw !== 'string' || urlRaw.length === 0) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `http.url must be a non-empty string, received ${describeJsType(urlRaw)}`,
      pointer: joinPointer(pointer, 'url'),
    })
    return null
  }

  const node: HttpNode = {
    type: 'http',
    ...parseCommonNodeFields(obj, pointer, ctx),
    url: urlRaw,
  }

  if ('method' in obj && obj.method !== undefined) {
    if (typeof obj.method === 'string' && ALLOWED_METHODS.has(obj.method)) {
      node.method = obj.method as HttpNode['method']
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `http.method must be GET|POST|PUT|PATCH|DELETE, received ${describeJsType(obj.method)}`,
        pointer: joinPointer(pointer, 'method'),
      })
    }
  }

  if ('headers' in obj && obj.headers !== undefined) {
    if (isPlainObject(obj.headers)) {
      node.headers = obj.headers as Record<string, string>
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `http.headers must be an object when present, received ${describeJsType(obj.headers)}`,
        pointer: joinPointer(pointer, 'headers'),
      })
    }
  }

  if ('body' in obj && obj.body !== undefined) {
    if (isPlainObject(obj.body)) {
      node.body = obj.body
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `http.body must be an object when present, received ${describeJsType(obj.body)}`,
        pointer: joinPointer(pointer, 'body'),
      })
    }
  }

  if (typeof obj.outputVar === 'string') node.outputVar = obj.outputVar
  return node
}
