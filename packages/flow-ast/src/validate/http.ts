import type { FlowNode } from '../types.js'
import { describeJsType, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

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
