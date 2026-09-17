/**
 * Structural decoder for the sealed coordination execution assignment
 * (`datazup.coordination.execution-assignment/v2`, B3-CP-03).
 *
 * DzupAgent decodes the producer bytes independently: it does not depend on
 * `@datazup/orchestration-contracts` (that package depends on DzupAgent). The
 * decoder accepts only the v2 schema, requires the exact field set at every
 * level, recomputes every embedded self-digest with the producer rule
 * (`sha256` of the canonical JSON of the object without its digest field), and
 * verifies the whole-document canonical seal when the caller supplies one.
 *
 * It never throws and its diagnostics carry paths, never values.
 */
import {
  ADAPTER_DIGEST_V1_OPTIONS,
  canonicalStringify,
  sha256Hex,
} from '@dzupagent/canonical-json'
import type {
  CoordinationAssignmentDecodeResult,
  CoordinationAssignmentDiagnostic,
  CoordinationExecutionAssignmentView,
  CoordinationSha256Digest,
  CoordinationVerifiedDigest,
} from '@dzupagent/adapter-types'

export const COORDINATION_EXECUTION_ASSIGNMENT_V2_SCHEMA =
  'datazup.coordination.execution-assignment/v2' as const

export const COORDINATION_ASSIGNMENT_MAX_BYTES = 262_144

export interface DecodeCoordinationExecutionAssignmentOptions {
  /** Canonical seal published by the producer (`sha256.txt` / manifest). */
  expectedSeal?: string | undefined
}

// ---------------------------------------------------------------------------
// Canonical digests
// ---------------------------------------------------------------------------

/** `sha256:` digest of the producer canonical JSON form of a JSON value. */
export function coordinationCanonicalDigest(value: unknown): CoordinationSha256Digest {
  return `sha256:${sha256Hex(canonicalStringify(value, ADAPTER_DIGEST_V1_OPTIONS))}`
}

/** Producer self-digest rule: the canonical digest of the object without `field`. */
export function coordinationSelfDigest(
  value: Readonly<Record<string, unknown>>,
  field: string,
): CoordinationSha256Digest {
  const unsigned: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key !== field) unsigned[key] = entry
  }
  return coordinationCanonicalDigest(unsigned)
}

// ---------------------------------------------------------------------------
// Exact-structure specification
// ---------------------------------------------------------------------------

type Spec =
  | { readonly kind: 'identity' }
  | { readonly kind: 'reference' }
  | { readonly kind: 'oid' }
  | { readonly kind: 'reasonCode' }
  | { readonly kind: 'mediaType' }
  | { readonly kind: 'string' }
  | { readonly kind: 'digest' }
  | { readonly kind: 'timestamp' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'literal'; readonly value: string | boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'nullable'; readonly of: Spec }
  | { readonly kind: 'array'; readonly of: Spec; readonly min?: number; readonly max: number; readonly unique?: boolean }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Spec>>; readonly optional?: readonly string[] }
  | { readonly kind: 'record' }

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/u
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const identity: Spec = { kind: 'identity' }
const reference: Spec = { kind: 'reference' }
const digest: Spec = { kind: 'digest' }
const timestamp: Spec = { kind: 'timestamp' }
const integer: Spec = { kind: 'integer' }
const references = (min = 0): Spec => ({ kind: 'array', of: reference, min, max: 128, unique: true })
const object = (fields: Record<string, Spec>, optional?: readonly string[]): Spec =>
  optional ? { kind: 'object', fields, optional } : { kind: 'object', fields }
const literal = (value: string | boolean): Spec => ({ kind: 'literal', value })
const oneOf = (...values: string[]): Spec => ({ kind: 'enum', values })
const nullable = (of: Spec): Spec => ({ kind: 'nullable', of })

const CONTEXT_ROLES = [
  'task',
  'acceptance_spec',
  'contract',
  'local_guidance',
  'architecture_intent',
  'architecture_anchor_set',
  'structural_snapshot',
  'impact_slice',
  'governing_decisions',
  'implementation_ledger_slice',
  'predecessor_checkpoint',
  'validation_profile',
  'curated_memory',
  'provider_transcript',
] as const
const SENSITIVITY = ['public', 'internal', 'sensitive', 'restricted'] as const

const providerReferenceSpec = object({
  schema: literal('datazup.orchestration.provider-reference/v1'),
  kind: oneOf(
    'backend',
    'session',
    'thread',
    'turn',
    'review',
    'interaction',
    'capability-descriptor',
    'execution-request',
  ),
  referenceId: identity,
})

const artifactReferenceSpec = object({
  schema: literal('datazup.orchestration.artifact-reference/v1'),
  artifactId: identity,
  digest,
  mediaType: { kind: 'mediaType' },
  sensitivity: oneOf(...SENSITIVITY),
  retained: { kind: 'boolean' },
})

const sourceBindingSpec = object({
  schema: literal('datazup.coordination.source-binding/v1'),
  repositoryId: identity,
  commitOid: { kind: 'oid' },
  treeOid: { kind: 'oid' },
  status: oneOf('clean', 'dirty-overlay'),
  statusDigest: digest,
  overlayArtifact: nullable(artifactReferenceSpec),
  overlayScopeDigest: nullable(digest),
  freshnessGeneration: integer,
  observedAt: timestamp,
  bindingDigest: digest,
})

const assignmentSpec = object({
  schema: literal(COORDINATION_EXECUTION_ASSIGNMENT_V2_SCHEMA),
  assignmentId: identity,
  programmeSpecDigest: digest,
  sessionEnrollment: object({
    schema: literal('datazup.coordination.session-enrollment/v1'),
    sessionId: identity,
    intentRef: reference,
    attemptId: identity,
    providerRef: nullable(providerReferenceSpec),
    interactionMode: oneOf('read_only', 'fast_mutation', 'planned_mutation', 'review', 'integration_request'),
    workspaceObservationRef: reference,
    programmeSpecDigest: nullable(digest),
    workIntentDigest: digest,
    observationCapabilityRef: reference,
    contextPackDigest: nullable(digest),
    renewalPolicyRef: reference,
    decisionDeadlinePolicyRef: reference,
    recoveryEndpointRef: reference,
    allowedEffects: references(),
    forbiddenEffects: references(),
    state: oneOf('enrolled', 'renewal_due', 'terminal', 'recovery_required'),
    generation: integer,
    enrolledAt: timestamp,
    expiresAt: timestamp,
    enrollmentDigest: digest,
  }),
  attemptId: identity,
  generation: integer,
  role: oneOf('implementer', 'reviewer', 'observer', 'integration-requester'),
  workIntent: object(
    {
      schemaVersion: literal('work-intent/v1'),
      programId: identity,
      planId: identity,
      taskId: identity,
      dependencies: { kind: 'array', of: identity, max: 128, unique: true },
      claims: {
        kind: 'array',
        min: 1,
        max: 128,
        of: object(
          {
            schemaVersion: literal('resource-claim/v1'),
            claimId: identity,
            taskId: identity,
            resourceId: identity,
            mode: oneOf('immutable_read', 'candidate_write', 'artifact_write', 'ref_write', 'external_effect', 'capacity'),
            scope: oneOf('exact', 'subtree', 'group', 'repository', 'opaque'),
            baseFingerprint: digest,
            semanticGroups: { kind: 'array', of: identity, max: 64, unique: true },
            confidence: oneOf('explicit', 'derived', 'inferred', 'fallback'),
            enforcement: oneOf('required', 'advisory'),
            metadata: { kind: 'record' },
          },
          ['baseFingerprint', 'semanticGroups', 'metadata'],
        ),
      },
      validationContractRef: reference,
      authorityRequirements: { kind: 'array', of: { kind: 'string' }, max: 64, unique: true },
      alternativeGroupId: identity,
    },
    ['validationContractRef', 'alternativeGroupId'],
  ),
  source: sourceBindingSpec,
  workspace: object({
    schema: literal('datazup.coordination.workspace-instance/v2'),
    workspaceId: identity,
    logicalWorkspaceRef: reference,
    physicalDomainRef: reference,
    isolationStrategy: oneOf('isolated', 'shared-read-only', 'host-managed'),
    source: sourceBindingSpec,
    observationRef: reference,
    authorityBindingRef: reference,
    generation: integer,
    observedAt: timestamp,
    workspaceDigest: digest,
  }),
  authorityBundle: object({
    schema: literal('datazup.coordination.authority-bundle/v2'),
    bundleId: identity,
    grants: {
      kind: 'array',
      min: 1,
      max: 128,
      of: object({
        factClass: oneOf('execution', 'placement', 'resource', 'effect', 'budget', 'integration'),
        grantRef: reference,
        generation: integer,
        fenceRef: reference,
        notAfter: timestamp,
        requiredEffects: references(),
        coveredAuthorityRequirements: { kind: 'array', of: { kind: 'string' }, max: 64, unique: true },
      }),
    },
    generation: integer,
    observedAt: timestamp,
    bundleDigest: digest,
  }),
  providerRef: nullable(providerReferenceSpec),
  contextPack: object({
    schema: literal('datazup.coordination.context-pack-manifest/v2'),
    manifestId: identity,
    attemptId: identity,
    generation: integer,
    sourceBindingDigest: digest,
    profile: object({
      schema: literal('datazup.coordination.context-pack-profile/v2'),
      profileRef: digest,
      requiredRoles: { kind: 'array', of: oneOf(...CONTEXT_ROLES), max: 14, unique: true },
      optionalRoles: { kind: 'array', of: oneOf(...CONTEXT_ROLES), max: 14, unique: true },
      limits: object({
        maxInputTokens: integer,
        reservedOutputTokens: integer,
        reservedToolTokens: integer,
      }),
    }),
    items: {
      kind: 'array',
      min: 1,
      max: 128,
      of: object({
        role: oneOf(...CONTEXT_ROLES),
        required: { kind: 'boolean' },
        artifact: artifactReferenceSpec,
        contentDigest: digest,
        sourceBindingDigest: digest,
        freshness: oneOf('current', 'admitted-stale', 'unknown'),
        privacyLabel: oneOf(...SENSITIVITY),
      }),
    },
    omissions: {
      kind: 'array',
      max: 128,
      of: object({
        role: oneOf(...CONTEXT_ROLES),
        required: literal(false),
        reasonCode: { kind: 'reasonCode' },
        evidenceRef: reference,
      }),
    },
    privacyLabels: { kind: 'array', of: oneOf(...SENSITIVITY), min: 1, max: 4, unique: true },
    createdAt: timestamp,
    manifestDigest: digest,
  }),
  processStrategyLockRef: digest,
  validationProfileRef: digest,
  allowedEffects: references(),
  forbiddenEffects: references(1),
  issuedAt: timestamp,
  notAfter: timestamp,
  issuerRef: reference,
  assignmentDigest: digest,
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Diagnostics = CoordinationAssignmentDiagnostic[]

const MAX_DIAGNOSTICS = 64

function push(diagnostics: Diagnostics, code: string, path: string, message: string): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ code, path, message })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

export function isCoordinationTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const match = TIMESTAMP_PATTERN.exec(value)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ]
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  return day <= days
}

/** Compare two canonical UTC timestamps without precision loss. */
export function compareCoordinationTimestamps(left: string, right: string): -1 | 0 | 1 {
  const normalize = (value: string): string => {
    const match = TIMESTAMP_PATTERN.exec(value)
    if (match === null) throw new TypeError('timestamp comparison requires canonical UTC timestamps')
    return `${value.slice(0, 19)}.${(match[7] ?? '').padEnd(9, '0')}`
  }
  const a = normalize(left)
  const b = normalize(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value)
}

function validate(value: unknown, spec: Spec, path: string, diagnostics: Diagnostics): void {
  const invalid = (message: string): void => push(diagnostics, 'COORD_ASSIGNMENT_FIELD_INVALID', path, message)
  switch (spec.kind) {
    case 'identity':
      if (!matches(value, IDENTITY_PATTERN)) invalid('Expected a portable identity.')
      return
    case 'reference':
      if (!matches(value, REFERENCE_PATTERN)) invalid('Expected a portable reference.')
      return
    case 'oid':
      if (!matches(value, OID_PATTERN)) invalid('Expected a lowercase git object id.')
      return
    case 'reasonCode':
      if (!matches(value, REASON_CODE_PATTERN)) invalid('Expected an upper-case reason code.')
      return
    case 'mediaType':
      if (!matches(value, MEDIA_TYPE_PATTERN)) invalid('Expected a media type.')
      return
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) invalid('Expected a bounded string.')
      return
    case 'digest':
      if (!matches(value, DIGEST_PATTERN)) invalid('Expected a lowercase sha256 digest.')
      return
    case 'timestamp':
      if (!isCoordinationTimestamp(value)) invalid('Expected a canonical UTC timestamp.')
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        invalid('Expected a non-negative safe integer.')
      }
      return
    case 'boolean':
      if (typeof value !== 'boolean') invalid('Expected a boolean.')
      return
    case 'literal':
      if (value !== spec.value) {
        push(
          diagnostics,
          path === '$.schema' ? 'COORD_ASSIGNMENT_SCHEMA_UNSUPPORTED' : 'COORD_ASSIGNMENT_FIELD_INVALID',
          path,
          'Value does not match the required literal.',
        )
      }
      return
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) invalid('Value is not in the admitted vocabulary.')
      return
    case 'nullable':
      if (value !== null) validate(value, spec.of, path, diagnostics)
      return
    case 'record':
      if (!isPlainRecord(value)) invalid('Expected a plain object.')
      return
    case 'array': {
      if (!Array.isArray(value)) {
        invalid('Expected an array.')
        return
      }
      if (value.length < (spec.min ?? 0) || value.length > spec.max) invalid('Array length is out of bounds.')
      const seen = new Set<string>()
      value.forEach((entry, index) => {
        validate(entry, spec.of, `${path}.${index}`, diagnostics)
        if (spec.unique && typeof entry === 'string') {
          if (seen.has(entry)) {
            push(diagnostics, 'COORD_ASSIGNMENT_FIELD_INVALID', `${path}.${index}`, 'Array entries must be unique.')
          }
          seen.add(entry)
        }
      })
      return
    }
    case 'object': {
      if (!isPlainRecord(value)) {
        invalid('Expected a plain object.')
        return
      }
      const optional = new Set(spec.optional ?? [])
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, key)) {
          push(diagnostics, 'COORD_ASSIGNMENT_FIELD_UNKNOWN', `${path}.${key}`, 'Unknown field.')
        }
      }
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, key)) {
          if (!optional.has(key)) {
            push(diagnostics, 'COORD_ASSIGNMENT_FIELD_MISSING', `${path}.${key}`, 'Required field is missing.')
          }
          continue
        }
        validate(value[key], fieldSpec, `${path}.${key}`, diagnostics)
      }
      return
    }
  }
}

function hasDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (Array.isArray(value)) return value.some((entry) => hasDangerousKey(entry, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => DANGEROUS_KEYS.has(key) || hasDangerousKey(entry, depth + 1),
    )
  }
  return false
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

function checkSelfDigest(
  value: Record<string, unknown>,
  field: string,
  path: string,
  label: CoordinationVerifiedDigest,
  verified: CoordinationVerifiedDigest[],
  diagnostics: Diagnostics,
): void {
  if (coordinationSelfDigest(value, field) === value[field]) {
    verified.push(label)
  } else {
    push(
      diagnostics,
      'COORD_ASSIGNMENT_DIGEST_MISMATCH',
      `${path}.${field}`,
      'Embedded digest does not match its canonical unsigned bytes.',
    )
  }
}

function checkConsistency(
  assignment: CoordinationExecutionAssignmentView,
  diagnostics: Diagnostics,
): void {
  const inconsistent = (path: string, message: string): void =>
    push(diagnostics, 'COORD_ASSIGNMENT_INCONSISTENT', path, message)
  const session = assignment.sessionEnrollment
  if (session.attemptId !== assignment.attemptId) {
    inconsistent('$.sessionEnrollment.attemptId', 'Session and assignment attempts must match.')
  }
  if (assignment.contextPack.attemptId !== assignment.attemptId) {
    inconsistent('$.contextPack.attemptId', 'Context and assignment attempts must match.')
  }
  if (session.programmeSpecDigest !== assignment.programmeSpecDigest) {
    inconsistent('$.programmeSpecDigest', 'Programme and session bindings must match.')
  }
  if (session.workspaceObservationRef !== assignment.workspace.observationRef) {
    inconsistent('$.sessionEnrollment.workspaceObservationRef', 'Session must bind the workspace observation.')
  }
  if (canonicalOrNull(session.providerRef) !== canonicalOrNull(assignment.providerRef)) {
    inconsistent('$.providerRef', 'Assignment and session provider references must match.')
  }
  const source = assignment.source.bindingDigest
  if (assignment.workspace.source.bindingDigest !== source) {
    inconsistent('$.workspace.source', 'Workspace must bind the assignment source.')
  }
  if (assignment.contextPack.sourceBindingDigest !== source) {
    inconsistent('$.contextPack.sourceBindingDigest', 'Context must bind the assignment source.')
  }
  assignment.contextPack.items.forEach((item, index) => {
    const path = `$.contextPack.items.${index}`
    if (item.sourceBindingDigest !== source) inconsistent(`${path}.sourceBindingDigest`, 'Item must bind the source.')
    if (item.contentDigest !== item.artifact.digest) {
      inconsistent(`${path}.contentDigest`, 'Content digest must match its artifact reference.')
    }
    if (item.privacyLabel !== item.artifact.sensitivity) {
      inconsistent(`${path}.privacyLabel`, 'Privacy label must match its artifact reference.')
    }
    if (!item.artifact.retained) inconsistent(`${path}.artifact.retained`, 'Present context must be retained.')
  })
  const itemRoles = new Set(assignment.contextPack.items.map(({ role }) => role))
  assignment.contextPack.omissions.forEach((omission, index) => {
    if (!itemRoles.has(omission.role)) return
    push(
      diagnostics,
      omission.role === 'provider_transcript' && omission.reasonCode === 'REVIEWER_INDEPENDENCE'
        ? 'COORD_CONTEXT_TRANSCRIPT_WITHHELD'
        : 'COORD_ASSIGNMENT_INCONSISTENT',
      `$.contextPack.omissions.${index}.role`,
      'A context role cannot be both present and omitted.',
    )
  })
  const repositoryClaim = assignment.workIntent.claims.some(
    (claim) =>
      claim.enforcement === 'required'
      && claim.scope === 'repository'
      && claim.resourceId === assignment.source.repositoryId
      && claim.baseFingerprint === source,
  )
  if (!repositoryClaim) {
    inconsistent('$.workIntent.claims', 'Assignment requires a source-bound, enforced repository claim.')
  }
  for (const [path, value] of [
    ['$.sessionEnrollment.enrolledAt', session.enrolledAt],
    ['$.source.observedAt', assignment.source.observedAt],
    ['$.workspace.observedAt', assignment.workspace.observedAt],
    ['$.authorityBundle.observedAt', assignment.authorityBundle.observedAt],
    ['$.contextPack.createdAt', assignment.contextPack.createdAt],
  ] as const) {
    if (compareCoordinationTimestamps(assignment.issuedAt, value) < 0) {
      inconsistent(path, 'Assignment issuance cannot predate its bound facts.')
    }
  }
  if (compareCoordinationTimestamps(assignment.issuedAt, assignment.notAfter) >= 0) {
    inconsistent('$.notAfter', 'Assignment ceiling must follow issuance.')
  }
}

function canonicalOrNull(value: unknown): string {
  return canonicalStringify(value, ADAPTER_DIGEST_V1_OPTIONS)
}

// ---------------------------------------------------------------------------
// Public decoder
// ---------------------------------------------------------------------------

/**
 * Decode sealed assignment bytes. Returns a deep-frozen view or diagnostics;
 * never throws.
 */
export function decodeCoordinationExecutionAssignment(
  bytes: string | Uint8Array,
  options: DecodeCoordinationExecutionAssignmentOptions = {},
): CoordinationAssignmentDecodeResult {
  const diagnostics: Diagnostics = []
  const fail = (code: string, path: string, message: string): CoordinationAssignmentDecodeResult => {
    push(diagnostics, code, path, message)
    return { ok: false, diagnostics: Object.freeze([...diagnostics]) }
  }
  if (options.expectedSeal !== undefined && !DIGEST_PATTERN.test(options.expectedSeal)) {
    return fail('COORD_ASSIGNMENT_SEAL_INVALID', '$', 'Expected seal must be a lowercase sha256 digest.')
  }

  let text: string
  try {
    text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail('COORD_ASSIGNMENT_NOT_JSON', '$', 'Assignment bytes are not valid UTF-8.')
  }
  if (new TextEncoder().encode(text).byteLength > COORDINATION_ASSIGNMENT_MAX_BYTES) {
    return fail('COORD_ASSIGNMENT_TOO_LARGE', '$', 'Assignment exceeds the byte limit.')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(text) as unknown
  } catch {
    return fail('COORD_ASSIGNMENT_NOT_JSON', '$', 'Assignment bytes are not JSON.')
  }
  if (hasDangerousKey(candidate)) {
    return fail('COORD_ASSIGNMENT_FIELD_INVALID', '$', 'Assignment contains a forbidden or too deeply nested key.')
  }
  if (!isPlainRecord(candidate)) {
    return fail('COORD_ASSIGNMENT_NOT_OBJECT', '$', 'Assignment must be a JSON object.')
  }
  if (candidate['schema'] !== COORDINATION_EXECUTION_ASSIGNMENT_V2_SCHEMA) {
    return fail('COORD_ASSIGNMENT_SCHEMA_UNSUPPORTED', '$.schema', 'Only execution-assignment/v2 is accepted.')
  }

  let canonicalSeal: CoordinationSha256Digest
  try {
    canonicalSeal = coordinationCanonicalDigest(candidate)
  } catch {
    return fail('COORD_ASSIGNMENT_FIELD_INVALID', '$', 'Assignment cannot be canonicalized.')
  }
  const sealVerified = options.expectedSeal !== undefined
  if (sealVerified && canonicalSeal !== options.expectedSeal) {
    push(diagnostics, 'COORD_ASSIGNMENT_SEAL_MISMATCH', '$', 'Canonical seal does not match the expected seal.')
  }

  validate(candidate, assignmentSpec, '$', diagnostics)
  if (diagnostics.some(({ code }) => code !== 'COORD_ASSIGNMENT_SEAL_MISMATCH')) {
    return { ok: false, diagnostics: Object.freeze([...diagnostics]) }
  }

  // Structure is exact from here on.
  const assignment = candidate as unknown as CoordinationExecutionAssignmentView
  const record = candidate as Record<string, Record<string, unknown>>
  const verified: CoordinationVerifiedDigest[] = []
  checkSelfDigest(candidate, 'assignmentDigest', '$', 'assignmentDigest', verified, diagnostics)
  checkSelfDigest(record['sessionEnrollment']!, 'enrollmentDigest', '$.sessionEnrollment', 'sessionEnrollment.enrollmentDigest', verified, diagnostics)
  checkSelfDigest(record['source']!, 'bindingDigest', '$.source', 'source.bindingDigest', verified, diagnostics)
  checkSelfDigest(record['workspace']!['source'] as Record<string, unknown>, 'bindingDigest', '$.workspace.source', 'workspace.source.bindingDigest', verified, diagnostics)
  checkSelfDigest(record['workspace']!, 'workspaceDigest', '$.workspace', 'workspace.workspaceDigest', verified, diagnostics)
  checkSelfDigest(record['authorityBundle']!, 'bundleDigest', '$.authorityBundle', 'authorityBundle.bundleDigest', verified, diagnostics)
  checkSelfDigest(record['contextPack']!, 'manifestDigest', '$.contextPack', 'contextPack.manifestDigest', verified, diagnostics)
  if (assignment.sessionEnrollment.workIntentDigest === coordinationCanonicalDigest(assignment.workIntent)) {
    verified.push('sessionEnrollment.workIntentDigest')
  } else {
    push(diagnostics, 'COORD_ASSIGNMENT_DIGEST_MISMATCH', '$.sessionEnrollment.workIntentDigest', 'Session must bind the exact work intent.')
  }
  if (assignment.sessionEnrollment.contextPackDigest === assignment.contextPack.manifestDigest) {
    verified.push('sessionEnrollment.contextPackDigest')
  } else {
    push(diagnostics, 'COORD_ASSIGNMENT_DIGEST_MISMATCH', '$.sessionEnrollment.contextPackDigest', 'Session must bind the exact context manifest.')
  }
  checkConsistency(assignment, diagnostics)

  if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze([...diagnostics]) }
  return {
    ok: true,
    value: deepFreeze({
      assignment,
      canonicalSeal,
      sealVerified,
      verifiedDigests: verified,
    }),
  }
}
