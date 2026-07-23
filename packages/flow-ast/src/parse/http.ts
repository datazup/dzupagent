import type { HttpNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const ALLOWED_AUTH_SCHEMES = new Set(['bearer', 'basic', 'api-key-header'])
const FORBIDDEN_API_KEY_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'content-length',
  'connection',
])

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

  if ('auth' in obj && obj.auth !== undefined) {
    const auth = parseHttpAuth(obj.auth, pointer, ctx)
    if (auth !== null) node.auth = auth
  }

  if (typeof obj.outputVar === 'string') node.outputVar = obj.outputVar
  if (typeof obj.timeoutMs === 'number' && obj.timeoutMs > 0) node.timeoutMs = obj.timeoutMs
  return node
}

function parseHttpAuth(
  value: unknown,
  pointer: string,
  ctx: ParseContext,
): NonNullable<HttpNode['auth']> | null {
  const path = joinPointer(pointer, 'auth')
  if (!isPlainObject(value)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: `http.auth must be an object when present, received ${describeJsType(value)}`,
      pointer: path,
    })
    return null
  }
  const scheme = value.scheme
  const credential = value.credential
  const provider = value.provider
  const scopes = value.scopes
  let valid = true
  if (typeof scheme !== 'string' || !ALLOWED_AUTH_SCHEMES.has(scheme)) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'http.auth.scheme must be bearer|basic|api-key-header',
      pointer: joinPointer(path, 'scheme'),
    })
    valid = false
  }
  for (const [key, entry] of [['credential', credential], ['provider', provider]] as const) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `http.auth.${key} must be a non-empty string`,
        pointer: joinPointer(path, key),
      })
      valid = false
    }
  }
  if (
    typeof provider === 'string' &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(provider)
  ) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'http.auth.provider must be a literal provider identity',
      pointer: joinPointer(path, 'provider'),
    })
    valid = false
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(scope),
    ) ||
    new Set(scopes).size !== scopes.length
  ) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'http.auth.scopes must be a duplicate-free array of non-empty strings',
      pointer: joinPointer(path, 'scopes'),
    })
    valid = false
  }
  const headerName = value.headerName
  if (scheme === 'api-key-header') {
    if (
      typeof headerName !== 'string' ||
      !/^[A-Za-z0-9-]+$/u.test(headerName) ||
      FORBIDDEN_API_KEY_HEADERS.has(headerName.toLowerCase())
    ) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: 'http.auth.headerName must be a reviewed non-reserved header for api-key-header',
        pointer: joinPointer(path, 'headerName'),
      })
      valid = false
    }
  } else if (headerName !== undefined) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'http.auth.headerName is allowed only for api-key-header',
      pointer: joinPointer(path, 'headerName'),
    })
    valid = false
  }
  if (!valid) return null
  return {
    scheme: scheme as NonNullable<HttpNode['auth']>['scheme'],
    credential: credential as string,
    provider: provider as string,
    scopes: scopes as string[],
    ...(headerName === undefined ? {} : { headerName: headerName as string }),
  }
}
