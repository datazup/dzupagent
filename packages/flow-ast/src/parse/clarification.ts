import type { ClarificationNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseClarification(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ClarificationNode | null {
  const questionRaw = obj.question
  if (typeof questionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `clarification.question must be a string, received ${describeJsType(questionRaw)}`,
      pointer: joinPointer(pointer, 'question'),
    })
    return null
  }

  let expected: 'text' | 'choice' | undefined
  if ('expected' in obj) {
    const expectedRaw = obj.expected
    if (expectedRaw === 'text' || expectedRaw === 'choice') {
      expected = expectedRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `clarification.expected must be "text" or "choice" when present, received ${describeJsType(expectedRaw)}`,
        pointer: joinPointer(pointer, 'expected'),
      })
    }
  }

  let choices: string[] | undefined
  if ('choices' in obj) {
    const choicesRaw = obj.choices
    if (Array.isArray(choicesRaw) && choicesRaw.every((v) => typeof v === 'string')) {
      choices = choicesRaw as string[]
    } else if (Array.isArray(choicesRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `clarification.choices must be an array of strings`,
        pointer: joinPointer(pointer, 'choices'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `clarification.choices must be an array when present, received ${describeJsType(choicesRaw)}`,
        pointer: joinPointer(pointer, 'choices'),
      })
    }
  }

  const node: ClarificationNode = {
    type: 'clarification',
    ...parseCommonNodeFields(obj, pointer, ctx),
    question: questionRaw,
  }
  if (expected !== undefined) node.expected = expected
  if (choices !== undefined) node.choices = choices
  return node
}
