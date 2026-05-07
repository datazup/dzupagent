import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'
import { validateNodeArray } from './dispatch.js'

export function validateRoute(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const strategy = obj['strategy']
  let ok = true
  if (strategy !== 'capability' && strategy !== 'fixed-provider') {
    issues.push({
      path: joinPath(path, 'strategy'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `route.strategy must be "capability" or "fixed-provider", received ${describeJsType(strategy)}`,
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'route.body must contain at least one node',
    })
  }
  let tags: string[] | undefined
  if ('tags' in obj && obj['tags'] !== undefined) {
    const t = obj['tags']
    if (Array.isArray(t) && t.every((v): v is string => typeof v === 'string')) {
      tags = t
    } else {
      issues.push({
        path: joinPath(path, 'tags'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'route.tags must be an array of strings when present',
      })
    }
  }
  let provider: string | undefined
  if ('provider' in obj && obj['provider'] !== undefined) {
    const p = obj['provider']
    if (typeof p === 'string') provider = p
    else {
      issues.push({
        path: joinPath(path, 'provider'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `route.provider must be a string when present, received ${describeJsType(p)}`,
      })
    }
  }
  if (strategy === 'fixed-provider' && (provider === undefined || provider.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "route.provider is required (non-empty string) when strategy='fixed-provider'",
    })
  }
  if (strategy === 'capability' && (tags === undefined || tags.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "route.tags is required (non-empty array) when strategy='capability'",
    })
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'route',
    ...common,
    strategy: strategy as 'capability' | 'fixed-provider',
    body,
  }
  if (tags !== undefined) node.tags = tags
  if (provider !== undefined) node.provider = provider
  return node
}
