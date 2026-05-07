import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'
import { validateNodeArray } from './dispatch.js'

export function validateApproval(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const question = obj['question']
  let ok = true
  if (typeof question !== 'string' || question.length === 0) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'approval.question is required (non-empty string)',
    })
    ok = false
  }
  const onApprove = validateNodeArray(obj['onApprove'], joinPath(path, 'onApprove'), issues)
  if (onApprove === null) return null
  if (onApprove.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'approval.onApprove must contain at least one node',
    })
  }
  let options: string[] | undefined
  if ('options' in obj && obj['options'] !== undefined) {
    const raw = obj['options']
    if (Array.isArray(raw) && raw.every((v): v is string => typeof v === 'string')) {
      options = raw
    } else {
      issues.push({
        path: joinPath(path, 'options'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'approval.options must be an array of strings when present',
      })
    }
  }
  let onReject: FlowNode[] | undefined
  if ('onReject' in obj && obj['onReject'] !== undefined) {
    const rej = validateNodeArray(obj['onReject'], joinPath(path, 'onReject'), issues)
    if (rej !== null) onReject = rej
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'approval',
    ...common,
    question: question as string,
    onApprove,
  }
  if (options !== undefined) node.options = options
  if (onReject !== undefined) node.onReject = onReject
  return node
}
