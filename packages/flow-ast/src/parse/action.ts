import type { ActionNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseAction(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ActionNode | null {
  const toolRefRaw = obj.toolRef
  const inputRaw = obj.input
  let failed = false

  if (typeof toolRefRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `action.toolRef must be a string, received ${describeJsType(toolRefRaw)}`,
      pointer: joinPointer(pointer, 'toolRef'),
    })
    failed = true
  }

  if (!isPlainObject(inputRaw)) {
    ctx.errors.push({
      code: inputRaw === undefined || inputRaw === null
        ? 'WRONG_FIELD_TYPE'
        : 'EXPECTED_OBJECT',
      message: `action.input must be an object, received ${describeJsType(inputRaw)}`,
      pointer: joinPointer(pointer, 'input'),
    })
    failed = true
  }

  let personaRef: string | undefined
  if ('personaRef' in obj) {
    const personaRaw = obj.personaRef
    if (typeof personaRaw === 'string') {
      personaRef = personaRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `action.personaRef must be a string when present, received ${describeJsType(personaRaw)}`,
        pointer: joinPointer(pointer, 'personaRef'),
      })
      // optional → drop the field, keep the node
    }
  }

  if (failed) return null
  // toolRefRaw and inputRaw are validated above — narrow with type assertions through helpers:
  const node: ActionNode = {
    type: 'action',
    ...parseCommonNodeFields(obj, pointer, ctx),
    toolRef: toolRefRaw as string,
    input: inputRaw as Record<string, unknown>,
  }
  if (personaRef !== undefined) node.personaRef = personaRef
  return node
}
