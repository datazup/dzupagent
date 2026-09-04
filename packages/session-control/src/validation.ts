import {
  CONTINUITY_MODES,
  COORDINATION_MODES,
  EXECUTION_STYLES,
  SESSION_CONTROL_SCHEMAS,
  type ExecutionPlan,
  type ExecutionProfile,
  type JsonValue,
  type OpaqueReference,
  type Sha256Digest,
  type ValidationIssue,
  type ValidationResult,
} from './contracts.js'

const OPAQUE_REFERENCE_PATTERN = /^[a-z][a-z0-9]{1,31}_[A-Za-z0-9][A-Za-z0-9._~-]{6,190}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isOpaqueReference(value: unknown): value is OpaqueReference {
  return typeof value === 'string' && OPAQUE_REFERENCE_PATTERN.test(value)
}

export function asOpaqueReference(value: string): OpaqueReference {
  if (!isOpaqueReference(value)) throw new TypeError('invalid opaque reference')
  return value
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function asSha256Digest(value: string): Sha256Digest {
  if (!isSha256Digest(value)) throw new TypeError('invalid SHA-256 digest')
  return value
}

export function isFiniteIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

export function isJsonValue(value: unknown, ancestors: Set<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false

  ancestors.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = value.every((entry) => isJsonValue(entry, ancestors))
  } else if (isRecord(value)) {
    valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors))
  } else {
    valid = false
  }
  ancestors.delete(value)
  return valid
}

export function areJsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => areJsonValuesEqual(entry, right[index] as JsonValue))
    )
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && areJsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  )
}

export function validateExecutionProfile(input: unknown): ValidationResult<ExecutionProfile> {
  const issues: ValidationIssue[] = []
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '$', code: 'invalid_type', message: 'execution profile must be an object' }],
    }
  }

  const allowedFields = new Set(['schema', 'executionStyle', 'continuity', 'coordination'])
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      issues.push({ path: field, code: 'unexpected_field', message: 'unexpected profile field' })
    }
  }

  if (input.schema !== SESSION_CONTROL_SCHEMAS.executionProfile) {
    issues.push({ path: 'schema', code: 'invalid_schema', message: 'unsupported execution profile schema' })
  }
  if (!EXECUTION_STYLES.includes(input.executionStyle as never)) {
    issues.push({ path: 'executionStyle', code: 'invalid_enum', message: 'invalid execution style' })
  }
  if (!CONTINUITY_MODES.includes(input.continuity as never)) {
    issues.push({ path: 'continuity', code: 'invalid_enum', message: 'invalid continuity mode' })
  }
  if (!COORDINATION_MODES.includes(input.coordination as never)) {
    issues.push({ path: 'coordination', code: 'invalid_enum', message: 'invalid coordination mode' })
  }
  if (
    input.executionStyle === 'inline' &&
    (input.continuity !== 'none' || input.coordination !== 'none')
  ) {
    issues.push({
      path: '$',
      code: 'inline_overhead_forbidden',
      message: 'inline execution requires no continuity and no coordination',
    })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: input as unknown as ExecutionProfile }
}

export function deriveExecutionPlan(profile: ExecutionProfile): ExecutionPlan {
  const inline = profile.executionStyle === 'inline'
  return {
    createDurableSession: !inline,
    requiresSupervisor: profile.coordination === 'supervised',
    requiresReviewer: false,
    requiresSummarization: false,
    automaticFallback: false,
    interactionHandling: inline ? 'return_to_caller' : 'session_event',
  }
}
