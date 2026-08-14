import type { ApprovalNodeClass, FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

const MAX_INTERACTION_CHOICES = 32
const MAX_INTERACTION_CHOICE_LENGTH = 256
const MAX_INTERACTION_QUESTION_LENGTH = 4096

function validateOptions(options: string[], path: string, issues: SchemaIssue[]): void {
  if (options.length > MAX_INTERACTION_CHOICES) {
    issues.push({
      path,
      code: 'INVALID_ENUM_VALUE',
      message: `approval.options must contain at most ${MAX_INTERACTION_CHOICES} values`,
    })
  }
  const seen = new Set<string>()
  options.forEach((option, index) => {
    if (option.length === 0) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: 'approval.options values must be non-empty strings',
      })
    }
    if (option.length > MAX_INTERACTION_CHOICE_LENGTH) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: `approval.options values must contain at most ${MAX_INTERACTION_CHOICE_LENGTH} characters`,
      })
    }
    if (seen.has(option)) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: `approval.options contains duplicate value "${option}"`,
      })
    }
    seen.add(option)
  })
}

export function validateApproval(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
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
  } else if (question.length > MAX_INTERACTION_QUESTION_LENGTH) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'INVALID_ENUM_VALUE',
      message: `approval.question must contain at most ${MAX_INTERACTION_QUESTION_LENGTH} characters`,
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
      validateOptions(options, joinPath(path, 'options'), issues)
    } else {
      issues.push({
        path: joinPath(path, 'options'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'approval.options must be an array of strings when present',
      })
    }
  }
  let approvalClass: ApprovalNodeClass | undefined
  if ('approvalClass' in obj && obj['approvalClass'] !== undefined) {
    const raw = obj['approvalClass']
    if (isApprovalNodeClass(raw)) {
      approvalClass = raw
    } else {
      issues.push({
        path: joinPath(path, 'approvalClass'),
        code: 'INVALID_ENUM_VALUE',
        message: 'approval.approvalClass must be a recognized approval class',
      })
      ok = false
    }
  }
  let onReject: FlowNode[] | undefined
  if ('onReject' in obj && obj['onReject'] !== undefined) {
    const rej = validateNodeArray(obj['onReject'], joinPath(path, 'onReject'), issues)
    if (rej !== null) {
      onReject = rej
      if (rej.length === 0) {
        issues.push({
          path,
          code: 'EMPTY_BODY',
          message: 'approval.onReject must contain at least one node',
        })
      }
    }
  } else {
    issues.push({
      path: joinPath(path, 'onReject'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'approval.onReject is required for checkpoint-bound interaction admission',
    })
  }
  if (!ok) return null
  const node: FlowNode = {
    type: 'approval',
    ...common,
    question: question as string,
    onApprove,
  }
  if (approvalClass !== undefined) node.approvalClass = approvalClass
  if (options !== undefined) node.options = options
  if (onReject !== undefined) node.onReject = onReject
  return node
}

function isApprovalNodeClass(value: unknown): value is ApprovalNodeClass {
  return value === 'read_only'
    || value === 'local_side_effect'
    || value === 'destructive_shell'
    || value === 'network_egress'
    || value === 'mcp_external_side_effect'
    || value === 'unknown'
}
