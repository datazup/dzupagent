import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateParallel(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const branchesRaw = obj['branches']
  if (!Array.isArray(branchesRaw)) {
    issues.push({
      path: joinPath(path, 'branches'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `parallel.branches must be an array, received ${describeJsType(branchesRaw)}`,
    })
    return null
  }
  if (branchesRaw.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'parallel.branches must contain at least one branch',
    })
  }
  const branches: FlowNode[][] = []
  for (let i = 0; i < branchesRaw.length; i++) {
    const branchPath = `${joinPath(path, 'branches')}[${i}]`
    const branchVal = branchesRaw[i]
    const branch = validateNodeArray(branchVal, branchPath, issues)
    if (branch === null) continue
    if (branch.length === 0) {
      issues.push({
        path: branchPath,
        code: 'EMPTY_BODY',
        message: 'parallel.branches[*] must contain at least one node',
      })
    }
    branches.push(branch)
  }
  return { type: 'parallel', ...common, branches }
}
