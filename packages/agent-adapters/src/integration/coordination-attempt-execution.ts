/**
 * Coordination attempt-execution composer and renderer (B3-CP-03).
 *
 * The composer joins a decoded coordination assignment with a DzupAgent
 * execution binding into one deep-frozen, provider-neutral plan, or returns
 * refusals. The renderer maps that plan to exactly one
 * {@link AgentExecutionRequest} for the existing execution seam.
 *
 * Rules the composer enforces:
 * - Provider, backend, auth, model, profile, capabilities, tariff, session and
 *   reasoning come only from the binding; none has a default and no authority
 *   grant can stand in for one.
 * - Authority is checked against the caller-supplied `now`; no ambient clock.
 * - Reasoning effort must be listed by the provider model catalog; it is never
 *   downgraded.
 * - Cross-provider fallback is refused at every level.
 * - Only assignments returned by the decoder with a verified producer seal are
 *   admitted; the binding and catalog are snapshotted once before validation.
 * - Credentials stay behind opaque references; resolver errors and unknown key
 *   names are never echoed.
 *
 * No production caller in this packet; dispatch wiring belongs to B3-MVP-03.
 */
import { createHash } from 'node:crypto'

import type {
  CoordinationAssignmentDiagnostic,
  CoordinationAttemptExecutionPlan,
  CoordinationAttemptExecutionPlanResult,
  CoordinationContextPackRole,
  CoordinationExecutionBinding,
  CoordinationPlanContextItem,
  CoordinationSha256Digest,
  DecodedCoordinationExecutionAssignment,
} from '@dzupagent/adapter-types'
import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_EFFECTS,
  validateProviderSessionAttemptBinding,
  type ProviderSessionCapability,
} from '@dzupagent/runtime-contracts/provider-session'

import type { ProviderModelCatalog } from '../model-discovery-types.js'
import {
  compareCoordinationTimestamps,
  coordinationCanonicalDigest,
  coordinationUnknownKeySegment,
  isCoordinationTimestamp,
  isDecodedCoordinationExecutionAssignment,
} from './coordination-assignment-decoder.js'
import type { AgentExecutionRequest } from './run-agent-execution.js'

export const COORDINATION_EXECUTION_BINDING_SCHEMA =
  'dzupagent.coordinationExecutionBinding/v1' as const
export const COORDINATION_ATTEMPT_EXECUTION_PLAN_SCHEMA =
  'dzupagent.coordinationAttemptExecutionPlan/v1' as const
export const COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA =
  'dzupagent.coordinationAttemptExecutionAttestation/v1' as const

export interface CoordinationArtifactRequest {
  readonly role: CoordinationContextPackRole
  readonly artifactId: string
  readonly digest: CoordinationSha256Digest
  readonly mediaType: string
}

export interface CoordinationResolvedArtifact {
  /** Raw bytes, or UTF-8 text. Its sha256 must equal the item's content digest. */
  readonly content: string | Uint8Array
}

/** Resolves retained context by digest. Return `undefined` when unavailable. */
export type CoordinationArtifactResolver = (
  request: CoordinationArtifactRequest,
) =>
  | CoordinationResolvedArtifact
  | undefined
  | Promise<CoordinationResolvedArtifact | undefined>

export interface ComposeCoordinationAttemptExecutionInput {
  /** Must come from `decodeCoordinationExecutionAssignment` with a verified seal. */
  readonly decoded: DecodedCoordinationExecutionAssignment
  /** Validated here; typed `unknown` because it crosses a trust boundary. */
  readonly binding: unknown
  /** Caller-observed canonical UTC time. */
  readonly now: string
  /** Discovered catalog for the bound provider; the reasoning-effort source. Snapshotted. */
  readonly modelCatalog: ProviderModelCatalog
  readonly resolveArtifact: CoordinationArtifactResolver
}

export interface CoordinationAttemptExecutionAttestation {
  readonly schema: typeof COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA
  readonly planDigest: CoordinationSha256Digest
  readonly requestDigest: CoordinationSha256Digest
  readonly assignmentDigest: CoordinationSha256Digest
  readonly canonicalSeal: CoordinationSha256Digest
  readonly tariffRef: string
}

export type CoordinationAgentExecutionRenderResult =
  | {
      readonly ok: true
      readonly request: Readonly<AgentExecutionRequest>
      readonly attestation: CoordinationAttemptExecutionAttestation
    }
  | { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] }

type Refusals = CoordinationAssignmentDiagnostic[]

// Only plans produced by the composer are rendered; a recomputed digest is not enough.
const composedPlans = new WeakSet<object>()

const BINDING_FIELDS = [
  'schema',
  'bindingId',
  'providerId',
  'backend',
  'model',
  'profileRef',
  'auth',
  'capabilitySet',
  'tariffRef',
  'sessionRef',
  'reasoning',
] as const
const CAPABILITY_SET_FIELDS = ['providerSession', 'requiredCapabilities', 'effects'] as const
const PROVIDERS = ['codex', 'claude'] as const
const BACKENDS = ['cli', 'sdk'] as const
const AUTH_MODES = ['subscription_cli', 'api_key'] as const
const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const FALLBACK_KEYS = new Set(['approvedFallbackProviders', 'fallbackProviders', 'fallback'])
// eslint-disable-next-line no-control-regex
const OPAQUE_PATTERN = /^[^\u0000-\u001f\u007f\s][^\u0000-\u001f\u007f]{0,255}$/u

function refuse(refusals: Refusals, code: string, path: string, message: string): void {
  refusals.push({ code, path, message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

/** One structured copy: getters run once, later mutation of the input is ignored. */
function snapshot(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (!isPlainRecord(value)) return { ok: false }
  try {
    return { ok: true, value: structuredClone(value) }
  } catch {
    return { ok: false }
  }
}

const SESSION_PATH_SEGMENTS = new Set<string>([
  'schema',
  'bindingId',
  'executionAttemptId',
  'authSourceRef',
  'descriptor',
  'descriptorId',
  'providerId',
  'backend',
  'id',
  'kind',
  'artifactDigest',
  'capabilities',
  'observedAt',
  'evidenceRef',
  'effectAuthorities',
  'boundAt',
  ...PROVIDER_SESSION_CAPABILITIES,
  ...PROVIDER_SESSION_EFFECTS,
])

/** Keep known contract segments; hash anything else (it may be caller-chosen). */
function sessionPath(path: string): string {
  const segments = path
    .split(/[.[\]]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      SESSION_PATH_SEGMENTS.has(segment) || /^\d+$/u.test(segment)
        ? segment
        : coordinationUnknownKeySegment(segment))
  return ['$binding.capabilitySet.providerSession', ...segments].join('.')
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_PATTERN.test(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

function sha256Bytes(content: string | Uint8Array): CoordinationSha256Digest {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** Validate the binding's own shape. Returns the typed binding or `undefined`. */
function validateBinding(
  binding: unknown,
  refusals: Refusals,
): CoordinationExecutionBinding | undefined {
  if (!isRecord(binding)) {
    refuse(refusals, 'COORD_BINDING_INVALID', '$binding', 'Execution binding must be an object.')
    return undefined
  }
  const before = refusals.length
  for (const key of Object.keys(binding)) {
    if (FALLBACK_KEYS.has(key)) {
      refuse(refusals, 'COORD_BINDING_FALLBACK_FORBIDDEN', `$binding.${key}`, 'Provider fallback is never admitted.')
    } else if (!(BINDING_FIELDS as readonly string[]).includes(key)) {
      refuse(refusals, 'COORD_BINDING_FIELD_UNKNOWN', `$binding.${coordinationUnknownKeySegment(key)}`, 'Unknown binding field.')
    }
  }
  for (const key of BINDING_FIELDS) {
    if (binding[key] === undefined) {
      refuse(refusals, 'COORD_BINDING_FACT_MISSING', `$binding.${key}`, 'Binding fact is required and has no default.')
    }
  }
  const enumField = (key: string, values: readonly string[], value: unknown): void => {
    if (value !== undefined && (typeof value !== 'string' || !values.includes(value))) {
      refuse(refusals, 'COORD_BINDING_FACT_INVALID', `$binding.${key}`, 'Binding fact is outside its vocabulary.')
    }
  }
  if (binding['schema'] !== undefined && binding['schema'] !== COORDINATION_EXECUTION_BINDING_SCHEMA) {
    refuse(refusals, 'COORD_BINDING_FACT_INVALID', '$binding.schema', 'Binding schema is unsupported.')
  }
  enumField('providerId', PROVIDERS, binding['providerId'])
  enumField('backend', BACKENDS, binding['backend'])
  enumField('reasoning', REASONING, binding['reasoning'])
  for (const key of ['bindingId', 'model', 'profileRef', 'tariffRef', 'sessionRef'] as const) {
    if (binding[key] !== undefined && !isOpaque(binding[key])) {
      refuse(refusals, 'COORD_BINDING_FACT_INVALID', `$binding.${key}`, 'Binding fact must be an opaque string.')
    }
  }

  const auth = binding['auth']
  if (auth !== undefined) {
    if (!isRecord(auth) || Object.keys(auth).some((key) => key !== 'mode' && key !== 'sourceRef')) {
      refuse(refusals, 'COORD_BINDING_FACT_INVALID', '$binding.auth', 'Auth must carry only mode and sourceRef.')
    } else {
      if (auth['mode'] === undefined) {
        refuse(refusals, 'COORD_BINDING_FACT_MISSING', '$binding.auth.mode', 'Auth mode is required and has no default.')
      }
      enumField('auth.mode', AUTH_MODES, auth['mode'])
      if (!isOpaque(auth['sourceRef'])) {
        refuse(refusals, 'COORD_BINDING_FACT_MISSING', '$binding.auth.sourceRef', 'Auth source reference is required.')
      }
    }
  }

  const capabilitySet = binding['capabilitySet']
  if (capabilitySet !== undefined) {
    if (!isRecord(capabilitySet)) {
      refuse(refusals, 'COORD_BINDING_FACT_INVALID', '$binding.capabilitySet', 'Capability set must be an object.')
    } else {
      for (const key of Object.keys(capabilitySet)) {
        if (FALLBACK_KEYS.has(key)) {
          refuse(refusals, 'COORD_BINDING_FALLBACK_FORBIDDEN', `$binding.capabilitySet.${key}`, 'Provider fallback is never admitted.')
        } else if (!(CAPABILITY_SET_FIELDS as readonly string[]).includes(key)) {
          refuse(refusals, 'COORD_BINDING_FIELD_UNKNOWN', `$binding.capabilitySet.${coordinationUnknownKeySegment(key)}`, 'Unknown capability-set field.')
        }
      }
      const required = capabilitySet['requiredCapabilities']
      const requiredValid =
        Array.isArray(required)
        && required.every((entry) => (PROVIDER_SESSION_CAPABILITIES as readonly unknown[]).includes(entry))
      if (!requiredValid) {
        refuse(refusals, 'COORD_BINDING_FACT_INVALID', '$binding.capabilitySet.requiredCapabilities', 'Required capabilities must be provider-session capabilities.')
      }
      const effects = capabilitySet['effects']
      if (!Array.isArray(effects) || !effects.every(isOpaque)) {
        refuse(refusals, 'COORD_BINDING_FACT_INVALID', '$binding.capabilitySet.effects', 'Effects must be opaque strings.')
      }
      const session = capabilitySet['providerSession']
      if (isRecord(session) && session['schema'] !== PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA) {
        refuse(refusals, 'COORD_BINDING_SESSION_INVALID', '$binding.capabilitySet.providerSession.schema', 'Provider-session binding must use the current schema.')
      }
      const admission = validateProviderSessionAttemptBinding(
        session,
        requiredValid ? (required as ProviderSessionCapability[]) : [],
      )
      for (const diagnostic of admission.diagnostics) {
        refuse(
          refusals,
          diagnostic.code === 'CAPABILITY_REQUIRED_UNSUPPORTED'
            ? 'COORD_BINDING_CAPABILITY_UNSUPPORTED'
            : 'COORD_BINDING_SESSION_INVALID',
          sessionPath(diagnostic.path),
          `Provider-session binding refused (${diagnostic.code}).`,
        )
      }
      if (isRecord(session) && isRecord(session['effectAuthorities'])) {
        for (const [effect, authority] of Object.entries(session['effectAuthorities'])) {
          if (isRecord(authority) && authority['fallback'] !== 'none') {
            refuse(
              refusals,
              'COORD_BINDING_FALLBACK_FORBIDDEN',
              `${sessionPath(`effectAuthorities.${effect}`)}.fallback`,
              'Provider fallback is never admitted.',
            )
          }
        }
      }
    }
  }
  return refusals.length === before ? (binding as unknown as CoordinationExecutionBinding) : undefined
}

function checkBindingAgainstAssignment(
  binding: CoordinationExecutionBinding,
  decoded: DecodedCoordinationExecutionAssignment,
  refusals: Refusals,
): void {
  const { assignment } = decoded
  const session = binding.capabilitySet.providerSession
  if (session.descriptor.providerId !== binding.providerId) {
    refuse(refusals, 'COORD_BINDING_PROVIDER_MISMATCH', '$binding.capabilitySet.providerSession.descriptor.providerId', 'Session descriptor names a different provider.')
  }
  if (session.descriptor.backend.kind !== binding.backend) {
    refuse(refusals, 'COORD_BINDING_BACKEND_MISMATCH', '$binding.capabilitySet.providerSession.descriptor.backend.kind', 'Session descriptor names a different backend.')
  }
  if (session.authSourceRef !== binding.auth.sourceRef) {
    refuse(refusals, 'COORD_BINDING_AUTH_MISMATCH', '$binding.capabilitySet.providerSession.authSourceRef', 'Session binding names a different auth source.')
  }
  if (session.executionAttemptId !== assignment.attemptId) {
    refuse(refusals, 'COORD_BINDING_ATTEMPT_MISMATCH', '$binding.capabilitySet.providerSession.executionAttemptId', 'Binding is for a different attempt.')
  }
  const forbidden = new Set([
    ...assignment.forbiddenEffects,
    ...assignment.sessionEnrollment.forbiddenEffects,
  ])
  const allowed = new Set(assignment.allowedEffects)
  binding.capabilitySet.effects.forEach((effect, index) => {
    const path = `$binding.capabilitySet.effects.${index}`
    if (forbidden.has(effect)) {
      refuse(refusals, 'COORD_BINDING_FORBIDDEN_EFFECT', path, 'Binding capabilities would allow a forbidden effect.')
    } else if (!allowed.has(effect)) {
      refuse(refusals, 'COORD_BINDING_EFFECT_UNAUTHORIZED', path, 'Binding capabilities exceed the assignment effects.')
    }
  })
}

function checkAuthority(
  decoded: DecodedCoordinationExecutionAssignment,
  now: string,
  refusals: Refusals,
): void {
  const { assignment } = decoded
  const session = assignment.sessionEnrollment
  const attemptGeneration = session.generation
  if (compareCoordinationTimestamps(now, assignment.issuedAt) < 0) {
    refuse(refusals, 'COORD_ASSIGNMENT_NOT_YET_VALID', '$.issuedAt', 'Assignment is not yet valid.')
  }
  if (compareCoordinationTimestamps(now, assignment.notAfter) >= 0) {
    refuse(refusals, 'COORD_ASSIGNMENT_EXPIRED', '$.notAfter', 'Assignment has expired.')
  }
  if (session.state !== 'enrolled') {
    refuse(refusals, 'COORD_SESSION_NOT_ENROLLED', '$.sessionEnrollment.state', 'Session enrollment is not active.')
  }
  if (compareCoordinationTimestamps(now, session.expiresAt) >= 0) {
    refuse(refusals, 'COORD_SESSION_EXPIRED', '$.sessionEnrollment.expiresAt', 'Session enrollment has expired.')
  }
  for (const [path, generation] of [
    ['$.generation', assignment.generation],
    ['$.authorityBundle.generation', assignment.authorityBundle.generation],
    ['$.contextPack.generation', assignment.contextPack.generation],
  ] as const) {
    if (generation !== attemptGeneration) {
      refuse(refusals, 'COORD_ASSIGNMENT_GENERATION_MISMATCH', path, 'Generation differs from the enrolled attempt.')
    }
  }
  const covered = new Set<string>()
  assignment.authorityBundle.grants.forEach((grant, index) => {
    const path = `$.authorityBundle.grants.${index}`
    if (grant.generation !== attemptGeneration) {
      refuse(refusals, 'COORD_GRANT_GENERATION_MISMATCH', `${path}.generation`, 'Grant generation differs from the attempt.')
    }
    if (compareCoordinationTimestamps(now, grant.notAfter) >= 0) {
      refuse(refusals, 'COORD_GRANT_EXPIRED', `${path}.notAfter`, 'Grant has expired.')
    }
    for (const requirement of grant.coveredAuthorityRequirements) covered.add(requirement)
  })
  assignment.workIntent.authorityRequirements.forEach((requirement, index) => {
    if (!covered.has(requirement)) {
      refuse(refusals, 'COORD_AUTHORITY_REQUIREMENT_UNCOVERED', `$.workIntent.authorityRequirements.${index}`, 'No grant covers this authority requirement.')
    }
  })
}

function checkReasoning(
  binding: CoordinationExecutionBinding,
  catalog: ProviderModelCatalog,
  refusals: Refusals,
): void {
  if (!isRecord(catalog) || !Array.isArray(catalog['models']) || typeof catalog['fingerprint'] !== 'string') {
    refuse(refusals, 'COORD_CATALOG_INVALID', '$catalog', 'Model catalog is malformed.')
    return
  }
  if (catalog.providerId !== binding.providerId) {
    refuse(refusals, 'COORD_CATALOG_PROVIDER_MISMATCH', '$catalog.providerId', 'Model catalog is not for the bound provider.')
    return
  }
  const entry: unknown = catalog.models.find((model: unknown) => isRecord(model) && model['id'] === binding.model)
  if (!isRecord(entry)) {
    refuse(refusals, 'COORD_MODEL_NOT_IN_CATALOG', '$binding.model', 'Bound model is not in the provider catalog.')
    return
  }
  const efforts = entry['supportedReasoningEfforts']
  const supported = Array.isArray(efforts)
    ? efforts.filter((effort): effort is string => typeof effort === 'string')
    : []
  if (supported.length === 0) {
    refuse(refusals, 'COORD_REASONING_SUPPORT_UNKNOWN', '$binding.reasoning', 'Catalog does not attest reasoning efforts for this model.')
  } else if (!supported.some((effort) => effort.toLowerCase() === binding.reasoning)) {
    refuse(refusals, 'COORD_REASONING_UNSUPPORTED', '$binding.reasoning', 'Bound reasoning effort is not supported; it is never downgraded.')
  }
}

async function resolveContext(
  decoded: DecodedCoordinationExecutionAssignment,
  resolveArtifact: CoordinationArtifactResolver,
  refusals: Refusals,
): Promise<CoordinationPlanContextItem[]> {
  const items: CoordinationPlanContextItem[] = []
  const pack = decoded.assignment.contextPack
  const requiredRoles = new Set<string>(pack.profile.requiredRoles)
  for (const [index, item] of pack.items.entries()) {
    const path = `$.contextPack.items.${index}`
    const unresolvedCode = item.required || requiredRoles.has(item.role)
      ? 'COORD_CONTEXT_REQUIRED_UNRESOLVED'
      : 'COORD_CONTEXT_ITEM_UNRESOLVED'
    let resolved: CoordinationResolvedArtifact | undefined
    try {
      resolved = await resolveArtifact({
        role: item.role,
        artifactId: item.artifact.artifactId,
        digest: item.contentDigest,
        mediaType: item.artifact.mediaType,
      })
    } catch {
      // The resolver's error text is untrusted and may carry secrets.
      refuse(refusals, unresolvedCode, path, 'Context resolver failed.')
      continue
    }
    const content = isRecord(resolved) ? resolved['content'] : undefined
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      refuse(refusals, unresolvedCode, path, 'Context item was not resolved.')
      continue
    }
    if (sha256Bytes(content) !== item.contentDigest) {
      refuse(refusals, 'COORD_CONTEXT_DIGEST_MISMATCH', `${path}.contentDigest`, 'Resolved content does not match its digest.')
      continue
    }
    let text: string
    try {
      text = typeof content === 'string'
        ? content
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
    } catch {
      refuse(refusals, 'COORD_CONTEXT_NOT_TEXT', path, 'Resolved content is not UTF-8 text.')
      continue
    }
    items.push({
      role: item.role,
      artifactId: item.artifact.artifactId,
      contentDigest: item.contentDigest,
      mediaType: item.artifact.mediaType,
      privacyLabel: item.privacyLabel,
      content: text,
    })
  }
  for (const [index, role] of pack.profile.requiredRoles.entries()) {
    if (!pack.items.some((item) => item.role === role)) {
      refuse(refusals, 'COORD_CONTEXT_REQUIRED_UNRESOLVED', `$.contextPack.profile.requiredRoles.${index}`, 'Required context role has no item.')
    }
  }
  return items
}

function nativeCapabilities(binding: CoordinationExecutionBinding): ProviderSessionCapability[] {
  const capabilities = binding.capabilitySet.providerSession.descriptor.capabilities
  return PROVIDER_SESSION_CAPABILITIES.filter((capability) => capabilities[capability]?.status === 'native')
}

/**
 * Compose one deep-frozen attempt-execution plan, or refusals. Never throws
 * for invalid input.
 */
export async function composeCoordinationAttemptExecution(
  input: ComposeCoordinationAttemptExecutionInput,
): Promise<CoordinationAttemptExecutionPlanResult> {
  try {
    return await compose(input)
  } catch {
    return {
      ok: false,
      refusals: Object.freeze([{ code: 'COORD_COMPOSE_FAILED', path: '$', message: 'Composition failed.' }]),
    }
  }
}

async function compose(
  input: ComposeCoordinationAttemptExecutionInput,
): Promise<CoordinationAttemptExecutionPlanResult> {
  const refusals: Refusals = []
  const finish = (): CoordinationAttemptExecutionPlanResult =>
    ({ ok: false, refusals: Object.freeze([...refusals]) })
  if (!isRecord(input)) {
    refuse(refusals, 'COORD_INPUT_INVALID', '$', 'Compose input must be an object.')
    return finish()
  }
  const { decoded, now } = input
  if (!isDecodedCoordinationExecutionAssignment(decoded)) {
    refuse(refusals, 'COORD_ASSIGNMENT_NOT_DECODED', '$', 'Compose requires an assignment returned by the decoder.')
    return finish()
  }
  if (!decoded.sealVerified) {
    refuse(refusals, 'COORD_ASSIGNMENT_UNSEALED', '$', 'Compose requires a verified producer seal.')
    return finish()
  }
  if (!isCoordinationTimestamp(now)) {
    refuse(refusals, 'COORD_NOW_INVALID', '$now', 'Now must be a canonical UTC timestamp.')
    return finish()
  }
  if (typeof input.resolveArtifact !== 'function') {
    refuse(refusals, 'COORD_INPUT_INVALID', '$resolveArtifact', 'An artifact resolver is required.')
    return finish()
  }
  const bindingCopy = snapshot(input.binding)
  const catalogCopy = snapshot(input.modelCatalog)

  const binding = bindingCopy.ok
    ? validateBinding(bindingCopy.value, refusals)
    : (refuse(refusals, 'COORD_BINDING_INVALID', '$binding', 'Execution binding must be plain JSON data.'), undefined)
  checkAuthority(decoded, now, refusals)
  if (binding !== undefined) {
    checkBindingAgainstAssignment(binding, decoded, refusals)
    if (catalogCopy.ok) {
      checkReasoning(binding, catalogCopy.value as ProviderModelCatalog, refusals)
    } else {
      refuse(refusals, 'COORD_CATALOG_INVALID', '$catalog', 'Model catalog must be plain JSON data.')
    }
  }
  const items = await resolveContext(decoded, input.resolveArtifact, refusals)
  if (refusals.length > 0 || binding === undefined || !catalogCopy.ok) return finish()
  const catalog = catalogCopy.value as ProviderModelCatalog

  const { assignment, canonicalSeal } = decoded
  const session = assignment.sessionEnrollment
  const providerSession = binding.capabilitySet.providerSession
  const unsigned: Omit<CoordinationAttemptExecutionPlan, 'planDigest'> = {
    schema: COORDINATION_ATTEMPT_EXECUTION_PLAN_SCHEMA,
    composedAt: now,
    assignment: {
      provenance: {
        issuerRef: assignment.issuerRef,
        generation: assignment.generation,
        validFrom: assignment.issuedAt,
        notAfter: assignment.notAfter,
        scope: assignment.attemptId,
      },
      assignmentId: assignment.assignmentId,
      assignmentDigest: assignment.assignmentDigest,
      canonicalSeal,
      attemptId: assignment.attemptId,
      role: assignment.role,
      taskId: assignment.workIntent.taskId,
      repositoryId: assignment.source.repositoryId,
      commitOid: assignment.source.commitOid,
      treeOid: assignment.source.treeOid,
      sourceBindingDigest: assignment.source.bindingDigest,
      workspaceId: assignment.workspace.workspaceId,
      workspaceDigest: assignment.workspace.workspaceDigest,
      allowedEffects: [...assignment.allowedEffects],
      forbiddenEffects: [...assignment.forbiddenEffects],
    },
    session: {
      provenance: {
        issuerRef: assignment.issuerRef,
        generation: session.generation,
        validFrom: session.enrolledAt,
        notAfter: session.expiresAt,
        scope: session.intentRef,
      },
      sessionId: session.sessionId,
      enrollmentDigest: session.enrollmentDigest,
      state: session.state,
    },
    authority: {
      bundleId: assignment.authorityBundle.bundleId,
      bundleDigest: assignment.authorityBundle.bundleDigest,
      grants: assignment.authorityBundle.grants.map((grant) => ({
        provenance: {
          issuerRef: grant.fenceRef,
          generation: grant.generation,
          validFrom: assignment.authorityBundle.observedAt,
          notAfter: grant.notAfter,
          scope: grant.grantRef,
        },
        factClass: grant.factClass,
        grantRef: grant.grantRef,
        fenceRef: grant.fenceRef,
        coveredAuthorityRequirements: [...grant.coveredAuthorityRequirements],
      })),
    },
    execution: {
      provenance: {
        issuerRef: binding.bindingId,
        generation: null,
        validFrom: providerSession.boundAt,
        notAfter: null,
        scope: providerSession.bindingId,
      },
      providerId: binding.providerId,
      backend: binding.backend,
      model: binding.model,
      profileRef: binding.profileRef,
      authMode: binding.auth.mode,
      authSourceRef: binding.auth.sourceRef,
      capabilityDescriptorId: providerSession.descriptor.descriptorId,
      nativeCapabilities: nativeCapabilities(binding),
      hostEffects: [...binding.capabilitySet.effects],
      tariffRef: binding.tariffRef,
      sessionRef: binding.sessionRef,
      reasoning: binding.reasoning,
      reasoningCatalogFingerprint: catalog.fingerprint,
    },
    context: {
      provenance: {
        issuerRef: assignment.issuerRef,
        generation: assignment.contextPack.generation,
        validFrom: assignment.contextPack.createdAt,
        notAfter: null,
        scope: assignment.contextPack.manifestId,
      },
      manifestId: assignment.contextPack.manifestId,
      manifestDigest: assignment.contextPack.manifestDigest,
      items,
      omittedRoles: assignment.contextPack.omissions.map(({ role, reasonCode }) => ({ role, reasonCode })),
    },
  }
  const plan: CoordinationAttemptExecutionPlan = {
    ...unsigned,
    planDigest: coordinationCanonicalDigest(unsigned),
  }
  const frozen = deepFreeze(plan)
  composedPlans.add(frozen)
  return { ok: true, plan: frozen }
}

function renderPrompt(plan: CoordinationAttemptExecutionPlan): string {
  const header = [
    `Coordination assignment ${plan.assignment.assignmentId}`,
    `attempt ${plan.assignment.attemptId}`,
    `role ${plan.assignment.role}`,
    `task ${plan.assignment.taskId}`,
  ].join('; ')
  const effects = `Forbidden effects: ${plan.assignment.forbiddenEffects.join(', ')}`
  const context = plan.context.items.map((item) =>
    [
      `<context role="${item.role}" artifact="${item.artifactId}" digest="${item.contentDigest}">`,
      item.content,
      '</context>',
    ].join('\n'))
  return [header, effects, ...context].join('\n\n')
}

/**
 * Render a composed plan to exactly one execution request. The tariff stays
 * in the attestation; fallback providers are always empty.
 */
export function renderCoordinationAgentExecutionRequest(
  plan: CoordinationAttemptExecutionPlan,
): CoordinationAgentExecutionRenderResult {
  try {
    return renderRequest(plan)
  } catch {
    return { ok: false, refusals: Object.freeze([{ code: 'COORD_PLAN_INVALID', path: '$plan', message: 'Render requires a composed plan.' }]) }
  }
}

function renderRequest(plan: CoordinationAttemptExecutionPlan): CoordinationAgentExecutionRenderResult {
  if (!isRecord(plan) || !Object.isFrozen(plan) || plan.schema !== COORDINATION_ATTEMPT_EXECUTION_PLAN_SCHEMA) {
    return { ok: false, refusals: Object.freeze([{ code: 'COORD_PLAN_INVALID', path: '$plan', message: 'Render requires a composed plan.' }]) }
  }
  if (!composedPlans.has(plan)) {
    return { ok: false, refusals: Object.freeze([{ code: 'COORD_PLAN_NOT_COMPOSED', path: '$plan', message: 'Render requires a plan returned by the composer.' }]) }
  }
  const { planDigest, ...unsigned } = plan
  if (coordinationCanonicalDigest(unsigned) !== planDigest) {
    return { ok: false, refusals: Object.freeze([{ code: 'COORD_PLAN_DIGEST_MISMATCH', path: '$plan.planDigest', message: 'Plan does not match its digest.' }]) }
  }
  const { execution, assignment } = plan
  const request: AgentExecutionRequest = {
    providerId: execution.providerId,
    backend: execution.backend,
    authMode: execution.authMode,
    profileRef: execution.profileRef,
    ...(execution.authMode === 'api_key' ? { secretRef: execution.authSourceRef } : {}),
    approvedFallbackProviders: [],
    prompt: renderPrompt(plan),
    model: execution.model,
    reasoning: execution.reasoning,
    correlationId: assignment.assignmentId,
    runId: assignment.attemptId,
  }
  const frozen = deepFreeze(request)
  return {
    ok: true,
    request: frozen,
    attestation: deepFreeze({
      schema: COORDINATION_ATTEMPT_EXECUTION_ATTESTATION_SCHEMA,
      planDigest,
      requestDigest: coordinationCanonicalDigest(frozen),
      assignmentDigest: assignment.assignmentDigest,
      canonicalSeal: assignment.canonicalSeal,
      tariffRef: execution.tariffRef,
    }),
  }
}
