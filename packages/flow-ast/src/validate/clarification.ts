import type { FlowNode } from '../types.js'
import { describeJsType, joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

const MAX_INTERACTION_CHOICES = 32
const MAX_INTERACTION_CHOICE_LENGTH = 256
const MAX_INTERACTION_QUESTION_LENGTH = 4096
const MAX_INTERACTION_OUTPUT_KEY_LENGTH = 512

function validateChoices(
  choices: string[],
  path: string,
  issues: SchemaIssue[],
): void {
  if (choices.length > MAX_INTERACTION_CHOICES) {
    issues.push({
      path,
      code: 'INVALID_ENUM_VALUE',
      message: `clarification.choices must contain at most ${MAX_INTERACTION_CHOICES} values`,
    })
  }
  const seen = new Set<string>()
  choices.forEach((choice, index) => {
    if (choice.length === 0) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: 'clarification.choices values must be non-empty strings',
      })
    }
    if (choice.length > MAX_INTERACTION_CHOICE_LENGTH) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: `clarification.choices values must contain at most ${MAX_INTERACTION_CHOICE_LENGTH} characters`,
      })
    }
    if (seen.has(choice)) {
      issues.push({
        path: joinPath(path, String(index)),
        code: 'INVALID_ENUM_VALUE',
        message: `clarification.choices contains duplicate value "${choice}"`,
      })
    }
    seen.add(choice)
  })
}

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
  if (question.length > MAX_INTERACTION_QUESTION_LENGTH) {
    issues.push({
      path: joinPath(path, 'question'),
      code: 'INVALID_ENUM_VALUE',
      message: `clarification.question must contain at most ${MAX_INTERACTION_QUESTION_LENGTH} characters`,
    })
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
      validateChoices(choices, joinPath(path, 'choices'), issues)
    } else {
      issues.push({
        path: joinPath(path, 'choices'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'clarification.choices must be an array of strings when present',
      })
    }
  }
  let outputKey: string | undefined
  if ('outputKey' in obj && obj['outputKey'] !== undefined) {
    const raw = obj['outputKey']
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_INTERACTION_OUTPUT_KEY_LENGTH) {
      outputKey = raw
    }
    else {
      issues.push({
        path: joinPath(path, 'outputKey'),
        code: 'MISSING_REQUIRED_FIELD',
        message: `clarification.outputKey must be a non-empty string of at most ${MAX_INTERACTION_OUTPUT_KEY_LENGTH} characters`,
      })
    }
  } else {
    issues.push({
      path: joinPath(path, 'outputKey'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'clarification.outputKey is required for checkpoint-bound interaction admission',
    })
  }
  if (expected === undefined && choices !== undefined && choices.length > 0) {
    expected = 'choice'
  }
  if (expected === 'choice' && (choices === undefined || choices.length === 0)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: "clarification.choices is required (non-empty array) when expected='choice'",
    })
  }
  if (expected === 'text' && choices !== undefined) {
    issues.push({
      path: joinPath(path, 'choices'),
      code: 'INVALID_ENUM_VALUE',
      message: "clarification.choices is not allowed when expected='text'",
    })
  }
  const node: FlowNode = { type: 'clarification', ...common, question }
  if (outputKey !== undefined) node.outputKey = outputKey
  if (expected !== undefined) node.expected = expected
  if (choices !== undefined) node.choices = choices
  return node
}
