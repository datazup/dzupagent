import type {
  FlowDocumentV1,
  FlowInputSpec,
  FlowNodeBase,
  FlowValue,
} from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import type { DslDiagnostic } from './types.js'

export const GENERIC_METADATA_KEYS = [
  'invocation',
  'requires',
  'produces',
  'updates',
  'artifacts',
  'evidence',
  'provenance',
  'review',
  'approval',
  'resume',
  'idempotency',
  'mutation',
  'conditions',
] as const

export const COMMON_NODE_KEYS = ['id', 'name', 'description', 'meta', 'resumePoint', ...GENERIC_METADATA_KEYS] as const

export function normalizeCommonNodeFields(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): FlowNodeBase {
  const base: FlowNodeBase = {}
  if (typeof raw.id === 'string') base.id = raw.id
  else if ('id' in raw) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'node id must be a string',
      path: `${path}.id`,
    })
  }
  if (typeof raw.name === 'string') base.name = raw.name
  if (typeof raw.description === 'string') base.description = raw.description
  if (typeof raw.resumePoint === 'boolean') base.resumePoint = raw.resumePoint
  else if ('resumePoint' in raw && raw.resumePoint !== undefined) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'node resumePoint must be a boolean',
      path: `${path}.resumePoint`,
    })
  }
  if (raw.meta !== undefined) {
    const meta = normalizeObject(raw.meta, `${path}.meta`, diagnostics)
    if (meta !== undefined) base.meta = meta
  }
  for (const key of GENERIC_METADATA_KEYS) {
    if (!(key in raw) || raw[key] === undefined) continue
    const value = raw[key]
    if (isFlowValue(value)) {
      base.meta = { ...(base.meta ?? {}), [key]: value }
      continue
    }
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `${key} metadata must be JSON-compatible`,
      path: `${path}.${key}`,
    })
  }
  return base
}

const DEFAULT_KEYS = new Set<string>([
  'persona',
  'personaRef',
  'timeout_ms',
  'timeoutMs',
  'retry',
])

const INPUT_SPEC_KEYS = new Set<string>([
  'type',
  'required',
  'description',
  'default',
])

export function normalizeInputs(
  raw: unknown,
  diagnostics: DslDiagnostic[],
): Record<string, FlowInputSpec> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_INPUT_SPEC,
      message: 'inputs must be an object',
      path: 'root.inputs',
    })
    return undefined
  }

  const inputs: Record<string, FlowInputSpec> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (isInputType(value)) {
        inputs[key] = { type: value, required: true }
      } else {
        diagnostics.push({
          phase: 'normalize',
          code: DSL_ERROR.INVALID_INPUT_SPEC,
          message: `Unsupported input type "${value}"`,
          path: `root.inputs.${key}`,
        })
      }
      continue
    }
    if (!isPlainObject(value)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec must be a string shorthand or an object with a valid type',
        path: `root.inputs.${key}`,
      })
      continue
    }
    reportUnsupportedFields(value, INPUT_SPEC_KEYS, `root.inputs.${key}`, diagnostics)
    if (!isInputType(value.type)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec must be a string shorthand or an object with a valid type',
        path: `root.inputs.${key}`,
      })
      continue
    }
    inputs[key] = {
      type: value.type,
      ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(value.default !== undefined && isFlowValue(value.default)
        ? { default: value.default }
        : {}),
    }
    if (value.default !== undefined && !isFlowValue(value.default)) {
      diagnostics.push({
        phase: 'normalize',
        code: DSL_ERROR.INVALID_INPUT_SPEC,
        message: 'input spec.default must be a JSON-like value when present',
        path: `root.inputs.${key}.default`,
      })
    }
  }
  return inputs
}

export function normalizeDefaults(
  raw: unknown,
  diagnostics: DslDiagnostic[],
): FlowDocumentV1['defaults'] | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_TOP_LEVEL_SHAPE,
      message: 'defaults must be an object',
      path: 'root.defaults',
    })
    return undefined
  }

  reportUnsupportedFields(raw, DEFAULT_KEYS, 'root.defaults', diagnostics)

  const defaults: NonNullable<FlowDocumentV1['defaults']> = {}
  if (typeof raw.persona === 'string') defaults.personaRef = raw.persona
  else if (typeof raw.personaRef === 'string') defaults.personaRef = raw.personaRef

  if (typeof raw.timeout_ms === 'number') defaults.timeoutMs = raw.timeout_ms
  else if (typeof raw.timeoutMs === 'number') defaults.timeoutMs = raw.timeoutMs

  if (isPlainObject(raw.retry) && typeof raw.retry.attempts === 'number') {
    defaults.retry = {
      attempts: raw.retry.attempts,
      ...(typeof raw.retry.delayMs === 'number' ? { delayMs: raw.retry.delayMs } : {}),
    }
  }
  return Object.keys(defaults).length > 0 ? defaults : {}
}

export function normalizeObject(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: 'value must be an object',
      path,
    })
    return undefined
  }
  return raw
}

export function normalizeStringArray(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw) && raw.every((v): v is string => typeof v === 'string')) {
    return raw
  }
  diagnostics.push({
    phase: 'normalize',
    code: DSL_ERROR.INVALID_NODE_SHAPE,
    message: 'value must be an array of strings',
    path,
  })
  return undefined
}

export function isInputType(value: unknown): value is FlowInputSpec['type'] {
  return value === 'string'
    || value === 'number'
    || value === 'boolean'
    || value === 'object'
    || value === 'array'
    || value === 'any'
}

export function isFlowValue(value: unknown): value is FlowValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isFlowValue(entry))
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isFlowValue(entry))
  }

  return false
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function reportUnsupportedFields(
  raw: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  diagnostics: DslDiagnostic[],
): void {
  for (const key of Object.keys(raw)) {
    if (allowedKeys.has(key)) continue
    const isOnError = key === 'on_error' || key === 'onError'
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.UNSUPPORTED_FIELD,
      message: isOnError
        ? `"${key}" is not supported in dzupflow/v1 yet`
        : `Unsupported field "${key}"`,
      path: `${path}.${key}`,
      ...(isOnError
        ? { suggestion: 'Model fallback or recovery explicitly with branch, approval, or future language support.' }
        : {}),
    })
  }
}
