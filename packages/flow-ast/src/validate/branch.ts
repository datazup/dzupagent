import {
  FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  isFlowTypedCondition,
} from '../expressions.js'
import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateBranch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const condition = obj['condition']
  const typedCondition = obj['typedCondition']
  let ok = true
  if (typeof condition !== 'string' || condition.length === 0) {
    issues.push({
      path: joinPath(path, 'condition'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'branch.condition is required (non-empty string)',
    })
    ok = false
  }
  if (
    typedCondition !== undefined &&
    !isFlowTypedCondition(typedCondition)
  ) {
    issues.push({
      path: joinPath(path, 'typedCondition'),
      code: 'INVALID_CONDITION',
      message: 'branch.typedCondition must be a canonical FlowTypedCondition',
    })
    ok = false
  }
  if (
    typedCondition !== undefined &&
    condition !== FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW
  ) {
    issues.push({
      path: joinPath(path, 'condition'),
      code: 'INVALID_CONDITION',
      message: `branch.condition must equal "${FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW}" when typedCondition is present`,
    })
    ok = false
  }
  const thenBody = validateNodeArray(obj['then'], joinPath(path, 'then'), issues)
  if (thenBody === null) return null
  if (thenBody.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'branch.then must contain at least one node',
    })
  }
  let elseBody: FlowNode[] | undefined
  if ('else' in obj && obj['else'] !== undefined) {
    const maybeElse = validateNodeArray(obj['else'], joinPath(path, 'else'), issues)
    if (maybeElse !== null) elseBody = maybeElse
  }
  if (!ok) return null
  const canonicalTypedCondition =
    typedCondition === undefined
      ? undefined
      : isFlowTypedCondition(typedCondition)
        ? typedCondition
        : undefined
  const node: Extract<FlowNode, { type: 'branch' }> = {
    type: 'branch',
    ...common,
    condition: condition as string,
    ...(canonicalTypedCondition === undefined
      ? {}
      : { typedCondition: canonicalTypedCondition }),
    then: thenBody,
  }
  if (elseBody !== undefined) node.else = elseBody
  return node
}
