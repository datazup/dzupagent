import {
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_SCHEMAS,
  type OpaqueReference,
  type SessionControlCapability,
  type ValidationIssue,
  type ValidationResult,
} from './contracts.js'
import { isFiniteIsoTimestamp, isOpaqueReference } from './validation.js'

export const CAPABILITY_SUPPORT_LEVELS = ['native', 'unsupported'] as const
export type CapabilitySupport = (typeof CAPABILITY_SUPPORT_LEVELS)[number]

export const CAPABILITY_QUALIFICATION_LEVELS = ['qualified', 'unqualified'] as const
export type CapabilityQualification = (typeof CAPABILITY_QUALIFICATION_LEVELS)[number]

export const CAPABILITY_AVAILABILITY_LEVELS = [
  'available',
  'temporarily_unavailable',
] as const
export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITY_LEVELS)[number]

export interface SessionControlCapabilityDeclaration {
  readonly support: CapabilitySupport
  readonly qualification: CapabilityQualification
  readonly availability: CapabilityAvailability
  readonly emulation: 'forbidden'
  readonly reason?: string
  readonly evidenceRefs?: readonly OpaqueReference[]
}

export interface SessionControlCapabilityManifest {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.capabilityManifest
  readonly manifestRef: OpaqueReference
  readonly adapterRef: OpaqueReference
  readonly providerKey: string
  readonly observedAt: string
  readonly capabilities: Readonly<
    Record<SessionControlCapability, SessionControlCapabilityDeclaration>
  >
}

export type CapabilityEffectiveStatus =
  | 'available'
  | 'unsupported'
  | 'unqualified'
  | 'temporarily_unavailable'

export interface CapabilityEvaluation {
  readonly callable: boolean
  readonly status: CapabilityEffectiveStatus
}

const SAFE_REASON_PATTERN = /^[a-z][a-z0-9._-]{2,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasSafeReason(input: Record<string, unknown>): boolean {
  return typeof input.reason === 'string' && SAFE_REASON_PATTERN.test(input.reason)
}

export function validateCapabilityDeclaration(
  input: unknown,
): ValidationResult<SessionControlCapabilityDeclaration> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '$', code: 'invalid_type', message: 'capability declaration must be an object' }],
    }
  }

  const issues: ValidationIssue[] = []
  const allowedFields = new Set([
    'support',
    'qualification',
    'availability',
    'emulation',
    'reason',
    'evidenceRefs',
  ])
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      issues.push({ path: field, code: 'unexpected_field', message: 'unexpected capability field' })
    }
  }
  if (!CAPABILITY_SUPPORT_LEVELS.includes(input.support as never)) {
    issues.push({ path: 'support', code: 'invalid_enum', message: 'invalid capability support' })
  }
  if (!CAPABILITY_QUALIFICATION_LEVELS.includes(input.qualification as never)) {
    issues.push({
      path: 'qualification',
      code: 'invalid_enum',
      message: 'invalid capability qualification',
    })
  }
  if (!CAPABILITY_AVAILABILITY_LEVELS.includes(input.availability as never)) {
    issues.push({
      path: 'availability',
      code: 'invalid_enum',
      message: 'invalid capability availability',
    })
  }
  if (input.emulation !== 'forbidden') {
    issues.push({
      path: 'emulation',
      code: 'emulation_forbidden',
      message: 'session control capabilities may not declare emulation',
    })
  }

  if (input.qualification === 'qualified') {
    if (
      !Array.isArray(input.evidenceRefs) ||
      input.evidenceRefs.length === 0 ||
      !input.evidenceRefs.every(isOpaqueReference)
    ) {
      issues.push({
        path: 'evidenceRefs',
        code: 'qualification_evidence_required',
        message: 'qualified capabilities require one or more opaque evidence references',
      })
    }
  }

  if (
    input.support === 'unsupported' ||
    input.qualification === 'unqualified' ||
    input.availability === 'temporarily_unavailable'
  ) {
    if (!hasSafeReason(input)) {
      issues.push({
        path: 'reason',
        code: 'reason_required',
        message: 'non-callable capability state requires a safe reason code',
      })
    }
  } else if (input.reason !== undefined && !hasSafeReason(input)) {
    issues.push({ path: 'reason', code: 'invalid_reason', message: 'reason must be a safe reason code' })
  }

  if (input.support === 'unsupported' && input.qualification === 'qualified') {
    issues.push({
      path: 'qualification',
      code: 'unsupported_cannot_be_qualified',
      message: 'an unsupported capability cannot be qualified',
    })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: input as unknown as SessionControlCapabilityDeclaration }
}

export function evaluateCapabilityDeclaration(
  declaration: SessionControlCapabilityDeclaration,
): CapabilityEvaluation {
  if (declaration.support === 'unsupported') {
    return { callable: false, status: 'unsupported' }
  }
  if (declaration.qualification === 'unqualified') {
    return { callable: false, status: 'unqualified' }
  }
  if (declaration.availability === 'temporarily_unavailable') {
    return { callable: false, status: 'temporarily_unavailable' }
  }
  return { callable: true, status: 'available' }
}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

export function validateCapabilityManifest(
  input: unknown,
): ValidationResult<SessionControlCapabilityManifest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '$', code: 'invalid_type', message: 'capability manifest must be an object' }],
    }
  }

  const issues: ValidationIssue[] = []
  const allowedFields = new Set([
    'schema',
    'manifestRef',
    'adapterRef',
    'providerKey',
    'observedAt',
    'capabilities',
  ])
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      issues.push({ path: field, code: 'unexpected_field', message: 'unexpected manifest field' })
    }
  }

  if (input.schema !== SESSION_CONTROL_SCHEMAS.capabilityManifest) {
    issues.push({ path: 'schema', code: 'invalid_schema', message: 'unsupported manifest schema' })
  }
  if (!isOpaqueReference(input.manifestRef)) {
    issues.push({ path: 'manifestRef', code: 'invalid_reference', message: 'invalid manifest reference' })
  }
  if (!isOpaqueReference(input.adapterRef)) {
    issues.push({ path: 'adapterRef', code: 'invalid_reference', message: 'invalid adapter reference' })
  }
  if (typeof input.providerKey !== 'string' || !PROVIDER_KEY_PATTERN.test(input.providerKey)) {
    issues.push({ path: 'providerKey', code: 'invalid_provider_key', message: 'invalid provider key' })
  }
  if (!isFiniteIsoTimestamp(input.observedAt)) {
    issues.push({ path: 'observedAt', code: 'invalid_timestamp', message: 'invalid observation time' })
  }

  if (!isRecord(input.capabilities)) {
    issues.push({ path: 'capabilities', code: 'invalid_type', message: 'capabilities must be an object' })
  } else {
    const expected = new Set<string>(SESSION_CONTROL_CAPABILITIES)
    for (const capability of SESSION_CONTROL_CAPABILITIES) {
      if (!Object.hasOwn(input.capabilities, capability)) {
        issues.push({
          path: `capabilities.${capability}`,
          code: 'capability_missing',
          message: 'capability declaration is required',
        })
        continue
      }
      const result = validateCapabilityDeclaration(input.capabilities[capability])
      if (!result.ok) {
        for (const issue of result.issues) {
          issues.push({ ...issue, path: `capabilities.${capability}.${issue.path}` })
        }
      }
    }
    for (const capability of Object.keys(input.capabilities)) {
      if (!expected.has(capability)) {
        issues.push({
          path: `capabilities.${capability}`,
          code: 'unexpected_capability',
          message: 'capability is not part of version 1',
        })
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: input as unknown as SessionControlCapabilityManifest }
}
