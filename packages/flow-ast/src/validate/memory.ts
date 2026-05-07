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
  if (operation !== 'read' && operation !== 'write' && operation !== 'list') {
    issues.push({
      path: joinPath(path, 'operation'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'memory.operation must be "read", "write", or "list"',
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
    operation: operation as 'read' | 'write' | 'list',
    tier: tier as 'session' | 'project' | 'workspace',
  }
  if ('key' in obj && typeof obj['key'] === 'string') node.key = obj['key']
  if ('valueExpr' in obj && typeof obj['valueExpr'] === 'string') node.valueExpr = obj['valueExpr']
  if ('outputVar' in obj && typeof obj['outputVar'] === 'string') node.outputVar = obj['outputVar']
  return node
}
