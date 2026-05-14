import type { FlowNode, LoopNode, TryCatchNode } from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from './normalize-value-helpers.js'
import type { DslDiagnostic } from './types.js'

type NormalizeSteps = (raw: unknown, path: string, diagnostics: DslDiagnostic[]) => FlowNode[]

// ── try_catch ─────────────────────────────────────────────────────────────────

const TRY_CATCH_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'body',
  'catch',
  'errorVar',
  'error_var',
])

export function normalizeTryCatch(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
): TryCatchNode {
  reportUnsupportedFields(raw, TRY_CATCH_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  if (!Array.isArray(raw.body)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'try_catch.body is required (array of steps)',
      path: `${path}.body`,
    })
  }
  if (!Array.isArray(raw.catch)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'try_catch.catch is required (array of steps)',
      path: `${path}.catch`,
    })
  }

  const body = normalizeSteps(raw.body ?? [], `${path}.body`, diagnostics)
  const catchBody = normalizeSteps(raw.catch ?? [], `${path}.catch`, diagnostics)

  const node: TryCatchNode = { type: 'try_catch', ...base, body, catch: catchBody }

  const errorVarRaw = raw.errorVar ?? raw.error_var
  if (typeof errorVarRaw === 'string') node.errorVar = errorVarRaw

  return node
}

// ── loop ──────────────────────────────────────────────────────────────────────

const LOOP_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  'condition',
  'body',
  'maxIterations',
  'max_iterations',
])

export function normalizeLoop(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
  normalizeSteps: NormalizeSteps,
): LoopNode {
  reportUnsupportedFields(raw, LOOP_KEYS, path, diagnostics)
  const base = normalizeCommonNodeFields(raw, path, diagnostics)

  const condition = typeof raw.condition === 'string' ? raw.condition : ''
  if (condition.length === 0) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'loop.condition is required (non-empty string expression)',
      path: `${path}.condition`,
    })
  }

  if (!Array.isArray(raw.body)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'loop.body is required (array of steps)',
      path: `${path}.body`,
    })
  }

  const body = normalizeSteps(raw.body ?? [], `${path}.body`, diagnostics)
  const node: LoopNode = { type: 'loop', ...base, condition, body }

  const maxRaw = raw.maxIterations ?? raw.max_iterations
  if (typeof maxRaw === 'number' && maxRaw > 0) {
    node.maxIterations = maxRaw
  } else if (maxRaw !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'loop.maxIterations must be a positive number',
      path: `${path}.maxIterations`,
    })
  }

  return node
}
