/**
 * Structural decoder for the sealed coordination execution assignment
 * (`datazup.coordination.execution-assignment/v2`, B3-CP-03).
 *
 * DzupAgent decodes the producer bytes independently: it does not depend on
 * `@datazup/orchestration-contracts` (that package depends on DzupAgent). The
 * decoder accepts only the v2 schema, requires the exact field set at every
 * level, applies the producer's value domains and cross-field rules,
 * recomputes every embedded self-digest with the producer rule (`sha256` of
 * the canonical JSON of the object without its digest field), and verifies the
 * whole-document canonical seal when the caller supplies one. Embedded digests
 * only detect accidental change; the supplied seal is what binds the bytes to
 * the producer, so the composer requires it.
 *
 * It never throws, and its diagnostics carry paths, never values. Unknown key
 * names are replaced by a short hash in paths.
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
  CoordinationSourceBindingView,
  CoordinationVerifiedDigest,
  DecodedCoordinationExecutionAssignment,
} from '@dzupagent/adapter-types'

export const COORDINATION_EXECUTION_ASSIGNMENT_V2_SCHEMA =
  'datazup.coordination.execution-assignment/v2' as const

export const COORDINATION_ASSIGNMENT_MAX_BYTES = 262_144

export interface DecodeCoordinationExecutionAssignmentOptions {
  /** Canonical seal published by the producer (`sha256.txt` / manifest). */
  expectedSeal?: string | undefined
}

// Only values produced by this decoder are admitted by the composer.
const decodedAssignments = new WeakSet<object>()

/** True only for a value returned by {@link decodeCoordinationExecutionAssignment}. */
export function isDecodedCoordinationExecutionAssignment(
  value: unknown,
): value is DecodedCoordinationExecutionAssignment {
  return value !== null && typeof value === 'object' && decodedAssignments.has(value)
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
// JSON bounds (producer canonical-json limits)
// ---------------------------------------------------------------------------

interface JsonLimits {
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxObjectEntries: number
  readonly maxArrayItems: number
  readonly maxStringLength: number
  readonly maxBytes: number
}

const DOCUMENT_LIMITS: JsonLimits = {
  maxDepth: 16,
  maxNodes: 4_096,
  maxObjectEntries: 256,
  maxArrayItems: 1_024,
  maxStringLength: 16_384,
  maxBytes: COORDINATION_ASSIGNMENT_MAX_BYTES,
}

const METADATA_LIMITS: JsonLimits = {
  maxDepth: 8,
  maxNodes: 256,
  maxObjectEntries: 32,
  maxArrayItems: 64,
  maxStringLength: 1_024,
  maxBytes: 16_384,
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// JavaScript orders array-index-like keys first, so the producer and the
// DzupAgent canonicalizers disagree on them; they are refused, not guessed.
const INDEX_LIKE_KEY = /^(?:0|[1-9]\d{0,9})$/u

/** Returns true when `value` stays inside the producer's canonical JSON bounds. */
function withinJsonLimits(value: unknown, limits: JsonLimits): boolean {
  let nodes = 0
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1
    if (depth > limits.maxDepth || nodes > limits.maxNodes) return false
    if (entry === null || typeof entry === 'boolean') return true
    if (typeof entry === 'string') return entry.length <= limits.maxStringLength
    if (typeof entry === 'number') return Number.isFinite(entry)
    if (Array.isArray(entry)) {
      return entry.length <= limits.maxArrayItems && entry.every((item) => visit(item, depth + 1))
    }
    if (typeof entry !== 'object') return false
    const entries = Object.entries(entry)
    return entries.length <= limits.maxObjectEntries && entries.every(
      ([key, item]) => !DANGEROUS_KEYS.has(key) && !INDEX_LIKE_KEY.test(key) && visit(item, depth + 1),
    )
  }
  if (!visit(value, 0)) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= limits.maxBytes
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Exact-structure specification
// ---------------------------------------------------------------------------

type Spec =
  | { readonly kind: 'pattern'; readonly pattern: RegExp; readonly message: string }
  | { readonly kind: 'portable' }
  | { readonly kind: 'timestamp' }
  | { readonly kind: 'integer'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'literal'; readonly value: string | boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'nullable'; readonly of: Spec }
  | { readonly kind: 'array'; readonly of: Spec; readonly min?: number; readonly max: number; readonly unique?: boolean }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Spec>>; readonly optional?: readonly string[] }
  | { readonly kind: 'metadata' }

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

const identity: Spec = { kind: 'pattern', pattern: IDENTITY_PATTERN, message: 'Expected a portable identity.' }
const reference: Spec = { kind: 'pattern', pattern: REFERENCE_PATTERN, message: 'Expected a portable reference.' }
const oid: Spec = { kind: 'pattern', pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, message: 'Expected a lowercase git object id.' }
const reasonCode: Spec = { kind: 'pattern', pattern: /^[A-Z][A-Z0-9_]{0,63}$/u, message: 'Expected an upper-case reason code.' }
const mediaType: Spec = { kind: 'pattern', pattern: /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/u, message: 'Expected a media type.' }
const digest: Spec = { kind: 'pattern', pattern: DIGEST_PATTERN, message: 'Expected a lowercase sha256 digest.' }
const timestamp: Spec = { kind: 'timestamp' }
const integer: Spec = { kind: 'integer' }
const tokenLimit: Spec = { kind: 'integer', min: 1, max: 1_000_000 }
const references = (min = 0): Spec => ({ kind: 'array', of: reference, min, max: 128, unique: true })
const identities = (max: number, min = 0): Spec => ({ kind: 'array', of: identity, min, max, unique: true })
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
const MUTATING_REPOSITORY_MODES = new Set(['candidate_write', 'artifact_write', 'ref_write'])
const REQUIRED_FACT_CLASSES = ['execution', 'placement', 'resource', 'budget'] as const
const SINGLETON_FACT_CLASSES = new Set(['execution', 'placement', 'budget', 'integration'])

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
  mediaType,
  sensitivity: oneOf(...SENSITIVITY),
  retained: { kind: 'boolean' },
})

const sourceBindingSpec = object({
  schema: literal('datazup.coordination.source-binding/v1'),
  repositoryId: identity,
  commitOid: oid,
  treeOid: oid,
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
      dependencies: identities(128),
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
            baseFingerprint: reference,
            semanticGroups: identities(32),
            confidence: oneOf('explicit', 'derived', 'inferred', 'fallback'),
            enforcement: oneOf('required', 'advisory'),
            metadata: { kind: 'metadata' },
          },
          ['baseFingerprint', 'semanticGroups', 'metadata'],
        ),
      },
      validationContractRef: reference,
      authorityRequirements: identities(64),
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
        coveredAuthorityRequirements: { kind: 'array', of: { kind: 'portable' }, max: 64, unique: true },
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
      requiredRoles: { kind: 'array', of: oneOf(...CONTEXT_ROLES), min: 1, max: 14, unique: true },
      optionalRoles: { kind: 'array', of: oneOf(...CONTEXT_ROLES), max: 14, unique: true },
      limits: object({
        maxInputTokens: tokenLimit,
        reservedOutputTokens: tokenLimit,
        reservedToolTokens: tokenLimit,
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
        reasonCode,
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

/** Path segment for a key the contract does not know; never echoes the key itself. */
export function coordinationUnknownKeySegment(key: string): string {
  return `<unknown:${sha256Hex(key).slice(0, 12)}>`
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

/**
 * Compare two canonical UTC timestamps without precision loss. Callers must
 * pass values accepted by {@link isCoordinationTimestamp}; invalid input
 * compares as later than any valid timestamp so that it can only refuse.
 */
export function compareCoordinationTimestamps(left: string, right: string): -1 | 0 | 1 {
  const normalize = (value: string): string => {
    const match = isCoordinationTimestamp(value) ? TIMESTAMP_PATTERN.exec(value) : null
    return match === null ? '\uffff' : `${value.slice(0, 19)}.${(match[7] ?? '').padEnd(9, '0')}`
  }
  const a = normalize(left)
  const b = normalize(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function validate(value: unknown, spec: Spec, path: string, diagnostics: Diagnostics): void {
  const invalid = (message: string): void => push(diagnostics, 'COORD_ASSIGNMENT_FIELD_INVALID', path, message)
  switch (spec.kind) {
    case 'pattern':
      if (typeof value !== 'string' || !spec.pattern.test(value)) invalid(spec.message)
      return
    case 'portable':
      if (typeof value !== 'string' || value.length === 0 || value.length > 128 || CONTROL_CHARACTER.test(value)) {
        invalid('Expected a bounded portable string.')
      }
      return
    case 'timestamp':
      if (!isCoordinationTimestamp(value)) invalid('Expected a canonical UTC timestamp.')
      return
    case 'integer':
      if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < (spec.min ?? 0)
        || (spec.max !== undefined && value > spec.max)
      ) {
        invalid('Expected a bounded safe integer.')
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
    case 'metadata':
      if (!isPlainRecord(value) || !withinJsonLimits(value, METADATA_LIMITS)) {
        invalid('Metadata must be finite, bounded JSON data.')
      }
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
          push(diagnostics, 'COORD_ASSIGNMENT_FIELD_UNKNOWN', `${path}.${coordinationUnknownKeySegment(key)}`, 'Unknown field.')
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((entry) => b.has(entry))
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

function checkSource(
  source: CoordinationSourceBindingView,
  path: string,
  inconsistent: (path: string, message: string) => void,
): void {
  if (source.commitOid.length !== source.treeOid.length) {
    inconsistent(`${path}.treeOid`, 'Commit and tree identifiers must use the same digest width.')
  }
  if (source.status === 'clean' && (source.overlayArtifact !== null || source.overlayScopeDigest !== null)) {
    inconsistent(`${path}.overlayArtifact`, 'Clean source cannot carry overlay evidence.')
  }
  if (
    source.status === 'dirty-overlay'
    && (source.overlayArtifact === null || source.overlayScopeDigest === null || !source.overlayArtifact.retained)
  ) {
    inconsistent(`${path}.overlayArtifact`, 'Dirty source requires retained overlay evidence and its scope digest.')
  }
}

function checkConsistency(
  assignment: CoordinationExecutionAssignmentView,
  diagnostics: Diagnostics,
): void {
  const inconsistent = (path: string, message: string): void =>
    push(diagnostics, 'COORD_ASSIGNMENT_INCONSISTENT', path, message)
  const before = (left: string, right: string): boolean => compareCoordinationTimestamps(left, right) < 0
  const session = assignment.sessionEnrollment
  const bundle = assignment.authorityBundle
  const pack = assignment.contextPack
  const intent = assignment.workIntent

  // Session enrollment and its binding to the assignment.
  if (!before(session.enrolledAt, session.expiresAt)) {
    inconsistent('$.sessionEnrollment.expiresAt', 'Enrollment expiry must follow enrollment time.')
  }
  if (session.attemptId !== assignment.attemptId) {
    inconsistent('$.sessionEnrollment.attemptId', 'Session and assignment attempts must match.')
  }
  if (pack.attemptId !== assignment.attemptId) {
    inconsistent('$.contextPack.attemptId', 'Context and assignment attempts must match.')
  }
  if (session.programmeSpecDigest !== assignment.programmeSpecDigest) {
    inconsistent('$.programmeSpecDigest', 'Programme and session bindings must match.')
  }
  if (session.workspaceObservationRef !== assignment.workspace.observationRef) {
    inconsistent('$.sessionEnrollment.workspaceObservationRef', 'Session must bind the workspace observation.')
  }
  if (canonicalStringify(session.providerRef, ADAPTER_DIGEST_V1_OPTIONS)
    !== canonicalStringify(assignment.providerRef, ADAPTER_DIGEST_V1_OPTIONS)) {
    inconsistent('$.providerRef', 'Assignment and session provider references must match.')
  }
  if (!sameSet(assignment.allowedEffects, session.allowedEffects)) {
    inconsistent('$.allowedEffects', 'Assignment and session allowed effects must match.')
  }
  if (!sameSet(assignment.forbiddenEffects, session.forbiddenEffects)) {
    inconsistent('$.forbiddenEffects', 'Assignment and session forbidden effects must match.')
  }
  const allowed = new Set(assignment.allowedEffects)
  if (assignment.forbiddenEffects.some((effect) => allowed.has(effect))) {
    inconsistent('$.forbiddenEffects', 'Allowed and forbidden effects must be disjoint.')
  }
  if (before(session.expiresAt, assignment.notAfter)) {
    inconsistent('$.notAfter', 'Assignment cannot outlive session enrollment.')
  }

  // Work intent.
  if (intent.dependencies.includes(intent.taskId)) {
    inconsistent('$.workIntent.dependencies', 'A task cannot depend on itself.')
  }
  const claimIds = new Set<string>()
  intent.claims.forEach((claim, index) => {
    const path = `$.workIntent.claims.${index}`
    if (claimIds.has(claim.claimId)) inconsistent(`${path}.claimId`, 'Claim identifiers must be unique.')
    claimIds.add(claim.claimId)
    if (claim.taskId !== intent.taskId) inconsistent(`${path}.taskId`, 'Every claim must bind to its task.')
    if (claim.scope === 'group' && (claim.semanticGroups?.length ?? 0) === 0) {
      inconsistent(`${path}.semanticGroups`, 'Group scope requires at least one semantic group.')
    }
  })

  // Source and workspace.
  const source = assignment.source.bindingDigest
  checkSource(assignment.source, '$.source', inconsistent)
  checkSource(assignment.workspace.source, '$.workspace.source', inconsistent)
  if (assignment.workspace.source.bindingDigest !== source) {
    inconsistent('$.workspace.source', 'Workspace must bind the assignment source.')
  }
  if (assignment.workspace.generation !== assignment.workspace.source.freshnessGeneration) {
    inconsistent('$.workspace.generation', 'Workspace and source freshness generations must match.')
  }
  if (before(assignment.workspace.observedAt, assignment.workspace.source.observedAt)) {
    inconsistent('$.workspace.observedAt', 'Workspace observation cannot predate its source observation.')
  }
  const repositoryClaim = intent.claims.some(
    (claim) =>
      claim.enforcement === 'required'
      && claim.scope === 'repository'
      && MUTATING_REPOSITORY_MODES.has(claim.mode)
      && claim.resourceId === assignment.source.repositoryId
      && claim.baseFingerprint === source,
  )
  if (!repositoryClaim) {
    inconsistent('$.workIntent.claims', 'Assignment requires a source-bound, enforced repository mutation claim.')
  }

  // Authority bundle.
  const grantRefs = new Set<string>()
  const singletons = new Set<string>()
  const effectCoverage = new Set<string>()
  bundle.grants.forEach((grant, index) => {
    const path = `$.authorityBundle.grants.${index}`
    if (grantRefs.has(grant.grantRef)) inconsistent(`${path}.grantRef`, 'Grant references must be unique.')
    grantRefs.add(grant.grantRef)
    if (SINGLETON_FACT_CLASSES.has(grant.factClass)) {
      if (singletons.has(grant.factClass)) inconsistent(`${path}.factClass`, 'This fact class permits one grant.')
      singletons.add(grant.factClass)
    }
    if (grant.factClass === 'integration') {
      inconsistent(`${path}.factClass`, 'Execution assignments cannot delegate integration authority.')
    }
    if (grant.factClass === 'effect') grant.requiredEffects.forEach((effect) => effectCoverage.add(effect))
    if (grant.generation !== bundle.generation) {
      inconsistent(`${path}.generation`, 'Every grant must bind the bundle generation.')
    }
    if (!before(bundle.observedAt, grant.notAfter)) {
      inconsistent(`${path}.notAfter`, 'A grant must remain current after the bundle observation.')
    }
    if (before(grant.notAfter, assignment.notAfter)) {
      inconsistent(`${path}.notAfter`, 'Assignment cannot outlive a referenced grant.')
    }
  })
  for (const factClass of REQUIRED_FACT_CLASSES) {
    if (!bundle.grants.some((grant) => grant.factClass === factClass)) {
      inconsistent('$.authorityBundle.grants', 'Authority bundle is missing a required fact class.')
    }
  }
  assignment.allowedEffects.forEach((effect, index) => {
    if (!effectCoverage.has(effect)) {
      inconsistent(`$.allowedEffects.${index}`, 'Every allowed effect requires an effect grant.')
    }
  })
  const bindsPlacement = bundle.grants.some(
    (grant) =>
      (grant.factClass === 'placement' || grant.factClass === 'resource')
      && grant.grantRef === assignment.workspace.authorityBindingRef,
  )
  if (!bindsPlacement) {
    inconsistent('$.workspace.authorityBindingRef', 'Workspace must reference a placement or resource grant.')
  }

  // Context pack.
  const { profile } = pack
  const requiredRoles = new Set<string>(profile.requiredRoles)
  const optionalRoles = new Set<string>(profile.optionalRoles)
  if (profile.optionalRoles.some((role) => requiredRoles.has(role))) {
    inconsistent('$.contextPack.profile.optionalRoles', 'Required and optional roles must be disjoint.')
  }
  if (!sameSet([...profile.requiredRoles, ...profile.optionalRoles], CONTEXT_ROLES)) {
    inconsistent('$.contextPack.profile', 'Profile roles must classify the complete role registry.')
  }
  const { limits } = profile
  if (limits.reservedOutputTokens + limits.reservedToolTokens > limits.maxInputTokens) {
    inconsistent('$.contextPack.profile.limits', 'Reserved tokens cannot exceed the input-token ceiling.')
  }
  if (pack.sourceBindingDigest !== source) {
    inconsistent('$.contextPack.sourceBindingDigest', 'Context must bind the assignment source.')
  }
  const itemRoles = new Set<string>()
  const contentDigests = new Set<string>()
  const itemPrivacy = new Set<string>()
  pack.items.forEach((item, index) => {
    const path = `$.contextPack.items.${index}`
    itemRoles.add(item.role)
    itemPrivacy.add(item.privacyLabel)
    if (contentDigests.has(item.contentDigest)) inconsistent(`${path}.contentDigest`, 'Content digests must be unique.')
    contentDigests.add(item.contentDigest)
    if ((requiredRoles.has(item.role) || optionalRoles.has(item.role)) && item.required !== requiredRoles.has(item.role)) {
      inconsistent(`${path}.required`, 'Item requiredness must match the profile.')
    }
    if (item.sourceBindingDigest !== source) inconsistent(`${path}.sourceBindingDigest`, 'Item must bind the source.')
    if (item.contentDigest !== item.artifact.digest) {
      inconsistent(`${path}.contentDigest`, 'Content digest must match its artifact reference.')
    }
    if (item.privacyLabel !== item.artifact.sensitivity) {
      inconsistent(`${path}.privacyLabel`, 'Privacy label must match its artifact reference.')
    }
    if (!item.artifact.retained) inconsistent(`${path}.artifact.retained`, 'Present context must be retained.')
  })
  const omissionRoles = new Set<string>()
  pack.omissions.forEach((omission, index) => {
    const path = `$.contextPack.omissions.${index}.role`
    if (omissionRoles.has(omission.role)) inconsistent(path, 'Omission roles must be unique.')
    omissionRoles.add(omission.role)
    if (!optionalRoles.has(omission.role)) inconsistent(path, 'Only profile-optional roles may be omitted.')
    if (itemRoles.has(omission.role)) {
      push(
        diagnostics,
        omission.role === 'provider_transcript' && omission.reasonCode === 'REVIEWER_INDEPENDENCE'
          ? 'COORD_CONTEXT_TRANSCRIPT_WITHHELD'
          : 'COORD_ASSIGNMENT_INCONSISTENT',
        path,
        'A context role cannot be both present and omitted.',
      )
    }
  })
  profile.requiredRoles.forEach((role, index) => {
    if (!itemRoles.has(role)) {
      inconsistent(`$.contextPack.profile.requiredRoles.${index}`, 'Every required role needs a retained item.')
    }
  })
  profile.optionalRoles.forEach((role, index) => {
    if (!itemRoles.has(role) && !omissionRoles.has(role)) {
      inconsistent(`$.contextPack.profile.optionalRoles.${index}`, 'Every absent optional role needs an omission receipt.')
    }
  })
  if (!sameSet(pack.privacyLabels, [...itemPrivacy])) {
    inconsistent('$.contextPack.privacyLabels', 'Privacy labels must exactly cover the context items.')
  }

  // Issuance ordering.
  for (const [path, value] of [
    ['$.sessionEnrollment.enrolledAt', session.enrolledAt],
    ['$.source.observedAt', assignment.source.observedAt],
    ['$.workspace.observedAt', assignment.workspace.observedAt],
    ['$.authorityBundle.observedAt', bundle.observedAt],
    ['$.contextPack.createdAt', pack.createdAt],
  ] as const) {
    if (before(assignment.issuedAt, value)) {
      inconsistent(path, 'Assignment issuance cannot predate its bound facts.')
    }
  }
  if (!before(assignment.issuedAt, assignment.notAfter)) {
    inconsistent('$.notAfter', 'Assignment ceiling must follow issuance.')
  }
}

// ---------------------------------------------------------------------------
// Public decoder
// ---------------------------------------------------------------------------

function decode(
  bytes: string | Uint8Array,
  options: DecodeCoordinationExecutionAssignmentOptions,
): CoordinationAssignmentDecodeResult {
  const diagnostics: Diagnostics = []
  const fail = (code: string, path: string, message: string): CoordinationAssignmentDecodeResult => {
    push(diagnostics, code, path, message)
    return { ok: false, diagnostics: Object.freeze([...diagnostics]) }
  }
  const expectedSeal = options.expectedSeal
  if (expectedSeal !== undefined && (typeof expectedSeal !== 'string' || !DIGEST_PATTERN.test(expectedSeal))) {
    return fail('COORD_ASSIGNMENT_SEAL_INVALID', '$', 'Expected seal must be a lowercase sha256 digest.')
  }

  let text: string
  if (typeof bytes === 'string') {
    text = bytes
  } else if (bytes instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return fail('COORD_ASSIGNMENT_NOT_JSON', '$', 'Assignment bytes are not valid UTF-8.')
    }
  } else {
    return fail('COORD_ASSIGNMENT_NOT_JSON', '$', 'Assignment must be text or bytes.')
  }
  if (text.length > COORDINATION_ASSIGNMENT_MAX_BYTES
    || new TextEncoder().encode(text).byteLength > COORDINATION_ASSIGNMENT_MAX_BYTES) {
    return fail('COORD_ASSIGNMENT_TOO_LARGE', '$', 'Assignment exceeds the byte limit.')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(text) as unknown
  } catch {
    return fail('COORD_ASSIGNMENT_NOT_JSON', '$', 'Assignment bytes are not JSON.')
  }
  if (!isPlainRecord(candidate)) {
    return fail('COORD_ASSIGNMENT_NOT_OBJECT', '$', 'Assignment must be a JSON object.')
  }
  if (candidate['schema'] !== COORDINATION_EXECUTION_ASSIGNMENT_V2_SCHEMA) {
    return fail('COORD_ASSIGNMENT_SCHEMA_UNSUPPORTED', '$.schema', 'Only execution-assignment/v2 is accepted.')
  }
  if (!withinJsonLimits(candidate, DOCUMENT_LIMITS)) {
    return fail('COORD_ASSIGNMENT_FIELD_INVALID', '$', 'Assignment exceeds the canonical JSON bounds or uses a forbidden key.')
  }

  const canonicalSeal = coordinationCanonicalDigest(candidate)
  const sealVerified = expectedSeal !== undefined && canonicalSeal === expectedSeal
  if (expectedSeal !== undefined && !sealVerified) {
    push(diagnostics, 'COORD_ASSIGNMENT_SEAL_MISMATCH', '$', 'Canonical seal does not match the expected seal.')
  }

  validate(candidate, assignmentSpec, '$', diagnostics)
  if (diagnostics.some(({ code }) => code !== 'COORD_ASSIGNMENT_SEAL_MISMATCH')) {
    return { ok: false, diagnostics: Object.freeze([...diagnostics]) }
  }

  // Structure is exact from here on.
  const assignment = candidate as unknown as CoordinationExecutionAssignmentView
  const record = candidate as Record<string, Record<string, unknown>>
  const contextPack = record['contextPack']!
  const profile = contextPack['profile'] as Record<string, unknown>
  const verified: CoordinationVerifiedDigest[] = []
  checkSelfDigest(candidate, 'assignmentDigest', '$', 'assignmentDigest', verified, diagnostics)
  checkSelfDigest(record['sessionEnrollment']!, 'enrollmentDigest', '$.sessionEnrollment', 'sessionEnrollment.enrollmentDigest', verified, diagnostics)
  checkSelfDigest(record['source']!, 'bindingDigest', '$.source', 'source.bindingDigest', verified, diagnostics)
  checkSelfDigest(record['workspace']!['source'] as Record<string, unknown>, 'bindingDigest', '$.workspace.source', 'workspace.source.bindingDigest', verified, diagnostics)
  checkSelfDigest(record['workspace']!, 'workspaceDigest', '$.workspace', 'workspace.workspaceDigest', verified, diagnostics)
  checkSelfDigest(record['authorityBundle']!, 'bundleDigest', '$.authorityBundle', 'authorityBundle.bundleDigest', verified, diagnostics)
  checkSelfDigest(contextPack, 'manifestDigest', '$.contextPack', 'contextPack.manifestDigest', verified, diagnostics)
  // Producer rule: the profile reference binds the role policy and limits.
  checkSelfDigest(profile, 'profileRef', '$.contextPack.profile', 'contextPack.profile.profileRef', verified, diagnostics)
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
  const value: DecodedCoordinationExecutionAssignment = deepFreeze({
    assignment,
    canonicalSeal,
    sealVerified,
    verifiedDigests: verified,
  })
  decodedAssignments.add(value)
  return { ok: true, value }
}

/**
 * Decode sealed assignment bytes. Returns a deep-frozen view or diagnostics;
 * never throws.
 */
export function decodeCoordinationExecutionAssignment(
  bytes: string | Uint8Array,
  options: DecodeCoordinationExecutionAssignmentOptions = {},
): CoordinationAssignmentDecodeResult {
  try {
    return decode(bytes, isPlainRecord(options) ? options : {})
  } catch {
    return {
      ok: false,
      diagnostics: Object.freeze([
        { code: 'COORD_ASSIGNMENT_FIELD_INVALID', path: '$', message: 'Assignment could not be decoded.' },
      ]),
    }
  }
}
