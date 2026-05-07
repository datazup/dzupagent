import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateClarification(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const question = obj['question']
  if (typeof question !== 'string' || question.length === 0) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'clarification.question is required (non-empty string)',
    })
    return null
  }
  let expected: 'text' | 'choice' | undefined
  if ('expected' in obj && obj['expected'] !== undefined) {
    const e = obj['expected']
    if (e === 'text' || e === 'choice') expected = e
    else {
      issues.push({
        path: joinPath(path, 'expected'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `clarification.expected must be "text" or "choice", received ${describeJsType(e)}`,
      })
    }
  }
  let choices: string[] | undefined
  if ('choices' in obj && obj['choices'] !== undefined) {
    const c = obj['choices']
    if (Array.isArray(c) && c.every((v): v is string => typeof v === 'string')) {
      choices = c
    } else {
      issues.push({
        path: joinPath(path, 'choices'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'clarification.choices must be an array of strings when present',
      })
    }
  }
  if (expected === 'choice' && (choices === undefined || choices.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "clarification.choices is required (non-empty array) when expected='choice'",
    })
  }
  const node: FlowNode = { type: 'clarification', ...common, question }
  if (expected !== undefined) node.expected = expected
  if (choices !== undefined) node.choices = choices
  return node
}
