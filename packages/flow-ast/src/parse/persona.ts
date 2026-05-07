import type { PersonaNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parsePersona(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): PersonaNode | null {
  const personaIdRaw = obj.personaId
  const bodyRaw = obj.body
  let failed = false

  if (typeof personaIdRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `persona.personaId must be a string, received ${describeJsType(personaIdRaw)}`,
      pointer: joinPointer(pointer, 'personaId'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `persona.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) ctx.parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    return null
  }

  const body = ctx.parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  return {
    type: 'persona',
    ...parseCommonNodeFields(obj, pointer, ctx),
    personaId: personaIdRaw as string,
    body,
  }
}
