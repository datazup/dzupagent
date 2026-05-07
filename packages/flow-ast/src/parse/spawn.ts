import type { SpawnNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseSpawn(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): SpawnNode | null {
  const templateRefRaw = obj.templateRef
  if (typeof templateRefRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `spawn.templateRef must be a string, received ${describeJsType(templateRefRaw)}`,
      pointer: joinPointer(pointer, 'templateRef'),
    })
    return null
  }

  let input: Record<string, unknown> | undefined
  if ('input' in obj) {
    const inputRaw = obj.input
    if (inputRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (isPlainObject(inputRaw)) {
      input = inputRaw
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `spawn.input must be an object when present, received ${describeJsType(inputRaw)}`,
        pointer: joinPointer(pointer, 'input'),
      })
    }
  }

  let waitForCompletion: boolean | undefined
  if ('waitForCompletion' in obj) {
    const waitRaw = obj.waitForCompletion
    if (waitRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof waitRaw === 'boolean') {
      waitForCompletion = waitRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `spawn.waitForCompletion must be a boolean when present, received ${describeJsType(waitRaw)}`,
        pointer: joinPointer(pointer, 'waitForCompletion'),
      })
    }
  }

  const node: SpawnNode = {
    type: 'spawn',
    ...parseCommonNodeFields(obj, pointer, ctx),
    templateRef: templateRefRaw,
  }
  if (input !== undefined) node.input = input
  if (waitForCompletion !== undefined) node.waitForCompletion = waitForCompletion
  return node
}
