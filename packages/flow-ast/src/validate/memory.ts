import type { MemoryNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateMemory(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): MemoryNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const operation = obj['operation']
  if (
    operation !== 'read' &&
    operation !== 'write' &&
    operation !== 'list' &&
    operation !== 'search'
  ) {
    issues.push({
      path: joinPath(path, 'operation'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.operation must be "read", "write", "list", or "search"',
    })
    return null
  }
  const tier = obj['tier']
  if (tier !== 'session' && tier !== 'project' && tier !== 'workspace') {
    issues.push({
      path: joinPath(path, 'tier'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.tier must be "session", "project", or "workspace"',
    })
    return null
  }
  const node: MemoryNode = {
    type: 'memory',
    ...common,
    operation: operation as 'read' | 'write' | 'list' | 'search',
    tier: tier as 'session' | 'project' | 'workspace',
  }
  if ('key' in obj && typeof obj['key'] === 'string') node.key = obj['key']
  if ('valueExpr' in obj && typeof obj['valueExpr'] === 'string') node.valueExpr = obj['valueExpr']
  if ('outputVar' in obj && typeof obj['outputVar'] === 'string') node.outputVar = obj['outputVar']
  if ('query' in obj && typeof obj['query'] === 'string') node.query = obj['query']
  if (
    'limit' in obj &&
    typeof obj['limit'] === 'number' &&
    Number.isInteger(obj['limit']) &&
    (obj['limit'] as number) > 0
  ) {
    node.limit = obj['limit'] as number
  }
  if (operation === 'search' && !node.query) {
    issues.push({
      path: joinPath(path, 'query'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.query is required when operation is "search"',
    })
    return null
  }
  return node
}
