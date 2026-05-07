import type { ClassifyNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseClassify(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ClassifyNode | null {
  const promptRaw = obj.prompt
  const choicesRaw = obj.choices
  const outputKeyRaw = obj.outputKey
  let failed = false

  if (typeof promptRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `classify.prompt must be a string, received ${describeJsType(promptRaw)}`,
      pointer: joinPointer(pointer, 'prompt'),
    })
    failed = true
  }
  if (!Array.isArray(choicesRaw)) {
    ctx.errors.push({
      code: choicesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `classify.choices must be an array, received ${describeJsType(choicesRaw)}`,
      pointer: joinPointer(pointer, 'choices'),
    })
    failed = true
  } else if (!choicesRaw.every((value) => typeof value === 'string')) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'classify.choices must be an array of strings',
      pointer: joinPointer(pointer, 'choices'),
    })
    failed = true
  }
  if (typeof outputKeyRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `classify.outputKey must be a string, received ${describeJsType(outputKeyRaw)}`,
      pointer: joinPointer(pointer, 'outputKey'),
    })
    failed = true
  }

  let defaultChoice: string | undefined
  if ('defaultChoice' in obj) {
    const defaultChoiceRaw = obj.defaultChoice
    if (defaultChoiceRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof defaultChoiceRaw === 'string') {
      defaultChoice = defaultChoiceRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `classify.defaultChoice must be a string when present, received ${describeJsType(defaultChoiceRaw)}`,
        pointer: joinPointer(pointer, 'defaultChoice'),
      })
    }
  }

  if (failed) return null
  const node: ClassifyNode = {
    type: 'classify',
    ...parseCommonNodeFields(obj, pointer, ctx),
    prompt: promptRaw as string,
    choices: choicesRaw as string[],
    outputKey: outputKeyRaw as string,
  }
  if (defaultChoice !== undefined) node.defaultChoice = defaultChoice
  return node
}
