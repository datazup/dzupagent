import type { FlowNode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

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

export function validateHttp(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const url = obj['url']
  if (typeof url !== 'string' || url.length === 0) {
    issues.push({
      path: joinPath(path, 'url'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `http.url is required (non-empty string), received ${describeJsType(url)}`,
    })
    return null
  }
  const node: FlowNode = { type: 'http', ...common, url }

  if ('method' in obj && obj['method'] !== undefined) {
    const m = obj['method']
    if (typeof m === 'string' && ALLOWED_METHODS.has(m)) {
      node.method = m as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    } else {
      issues.push({
        path: joinPath(path, 'method'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `http.method must be GET|POST|PUT|PATCH|DELETE, received ${describeJsType(m)}`,
      })
    }
  }

  if ('headers' in obj && obj['headers'] !== undefined && !isPlainObject(obj['headers'])) {
    issues.push({
      path: joinPath(path, 'headers'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `http.headers must be an object when present, received ${describeJsType(obj['headers'])}`,
    })
  } else if ('headers' in obj && isPlainObject(obj['headers'])) {
    node.headers = obj['headers'] as Record<string, string>
  }

  if ('body' in obj && obj['body'] !== undefined && !isPlainObject(obj['body'])) {
    issues.push({
      path: joinPath(path, 'body'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `http.body must be an object when present, received ${describeJsType(obj['body'])}`,
    })
  } else if ('body' in obj && isPlainObject(obj['body'])) {
    node.body = obj['body']
  }

  if ('auth' in obj && obj['auth'] !== undefined) {
    const auth = validateHttpAuth(obj['auth'], path, issues)
    if (auth !== null && node.type === 'http') node.auth = auth
  }

  if (typeof obj['outputVar'] === 'string') node.outputVar = obj['outputVar']

  if ('timeoutMs' in obj && obj['timeoutMs'] !== undefined) {
    const t = obj['timeoutMs']
    if (typeof t === 'number' && Number.isInteger(t) && t > 0) {
      node.timeoutMs = t
    } else {
      issues.push({
        path: joinPath(path, 'timeoutMs'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `http.timeoutMs must be a positive integer when present, received ${describeJsType(t)}`,
      })
    }
  }

  return node
}

function validateHttpAuth(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): NonNullable<Extract<FlowNode, { type: 'http' }>['auth']> | null {
  const authPath = joinPath(path, 'auth')
  if (!isPlainObject(value)) {
    issues.push({
      path: authPath,
      code: 'MISSING_REQUIRED_FIELD',
      message: `http.auth must be an object when present, received ${describeJsType(value)}`,
    })
    return null
  }
  const scheme = value['scheme']
  const credential = value['credential']
  const provider = value['provider']
  const scopes = value['scopes']
  let valid = true
  if (typeof scheme !== 'string' || !ALLOWED_AUTH_SCHEMES.has(scheme)) {
    issues.push({
      path: joinPath(authPath, 'scheme'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'http.auth.scheme must be bearer|basic|api-key-header',
    })
    valid = false
  }
  for (const [key, entry] of [['credential', credential], ['provider', provider]] as const) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push({
        path: joinPath(authPath, key),
        code: 'MISSING_REQUIRED_FIELD',
        message: `http.auth.${key} must be a non-empty string`,
      })
      valid = false
    }
  }
  if (
    typeof provider === 'string' &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(provider)
  ) {
    issues.push({
      path: joinPath(authPath, 'provider'),
      code: 'INVALID_ENUM_VALUE',
      message: 'http.auth.provider must be a literal provider identity',
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
    issues.push({
      path: joinPath(authPath, 'scopes'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'http.auth.scopes must be a duplicate-free array of non-empty strings',
    })
    valid = false
  }
  const headerName = value['headerName']
  if (scheme === 'api-key-header') {
    if (
      typeof headerName !== 'string' ||
      !/^[A-Za-z0-9-]+$/u.test(headerName) ||
      FORBIDDEN_API_KEY_HEADERS.has(headerName.toLowerCase())
    ) {
      issues.push({
        path: joinPath(authPath, 'headerName'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'http.auth.headerName must be a reviewed non-reserved header for api-key-header',
      })
      valid = false
    }
  } else if (headerName !== undefined) {
    issues.push({
      path: joinPath(authPath, 'headerName'),
      code: 'INVALID_ENUM_VALUE',
      message: 'http.auth.headerName is allowed only for api-key-header',
    })
    valid = false
  }
  if (!valid) return null
  return {
    scheme: scheme as NonNullable<Extract<FlowNode, { type: 'http' }>['auth']>['scheme'],
    credential: credential as string,
    provider: provider as string,
    scopes: scopes as string[],
    ...(headerName === undefined ? {} : { headerName: headerName as string }),
  }
}
