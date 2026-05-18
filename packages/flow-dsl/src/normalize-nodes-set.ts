import type { SetNode } from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  isPlainObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

const SET_KEYS = new Set<string>([...COMMON_NODE_KEYS, 'assign'])

export function normalizeSet(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): SetNode {
  reportUnsupportedFields(raw, SET_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const assignRaw = raw.assign
  if (assignRaw === undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'set.assign is required',
      path: `${path}.assign`,
    })
    return { type: 'set', ...base, assign: {} }
  }

  if (!isPlainObject(assignRaw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'set.assign must be an object',
      path: `${path}.assign`,
    })
    return { type: 'set', ...base, assign: {} }
  }

  return { type: 'set', ...base, assign: assignRaw as Record<string, unknown> }
}
