import {
  INTERACTION_CLASSES,
  NORMALIZED_SESSION_EVENT_TYPES,
  SESSION_CONTROL_SCHEMAS,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  type ExecutionProfile,
  type InteractionClass,
  type JsonObject,
  type NormalizedSessionEventType,
  type OpaqueReference,
  type SessionStatus,
  type Sha256Digest,
  type ValidationIssue,
  type ValidationResult,
} from './contracts.js'
import {
  isFiniteIsoTimestamp,
  isJsonValue,
  isOpaqueReference,
  isSha256Digest,
  validateExecutionProfile,
} from './validation.js'

export const SESSION_ORIGINS = ['managed', 'attached', 'discovered_external'] as const
export type SessionOrigin = (typeof SESSION_ORIGINS)[number]

export const SESSION_EVENT_SOURCES = [
  'provider_adapter',
  'control_plane',
  'worker',
  'host',
] as const
export type SessionEventSource = (typeof SESSION_EVENT_SOURCES)[number]

export const SESSION_CONTROL_MODES = ['controllable', 'read_only'] as const
export type SessionControlMode = (typeof SESSION_CONTROL_MODES)[number]

const ACKNOWLEDGED_COMMAND_STATUSES = new Set([
  'accepted',
  'provider_waiting',
  'applied',
  'rejected_stale',
  'rejected_authority',
  'unsupported',
  'failed',
])

export interface SessionControlSessionView {
  readonly sessionRef: OpaqueReference
  readonly origin: SessionOrigin
  readonly generation: number
  readonly status: SessionStatus
  readonly controlMode: SessionControlMode
  readonly pendingInteractionRef?: OpaqueReference
}

export interface ProviderAttemptSnapshot {
  readonly attemptRef: OpaqueReference
  readonly status: SessionStatus
}

export interface PendingInteraction {
  readonly interactionRef: OpaqueReference
  readonly interactionClass: InteractionClass
}

export interface SessionEventReceipt {
  readonly eventId: OpaqueReference
  readonly eventDigest: Sha256Digest
  readonly sequence: number
  readonly occurredAt: string
  readonly recordedAt: string
  readonly source: SessionEventSource
  readonly type: NormalizedSessionEventType
  readonly payload: JsonObject
}

export interface SessionSnapshot {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.sessionSnapshot
  readonly sessionRef: OpaqueReference
  readonly profile: ExecutionProfile
  readonly origin: SessionOrigin
  readonly controlMode: SessionControlMode
  readonly generation: number
  readonly eventSequence: number
  readonly status: SessionStatus
  readonly attempts: readonly ProviderAttemptSnapshot[]
  readonly pendingInteraction?: PendingInteraction
  readonly pendingDependencyRef?: OpaqueReference
  readonly lastHandoffRef?: OpaqueReference
  readonly lastEventReceipt?: SessionEventReceipt
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateSessionSnapshotInput {
  readonly sessionRef: OpaqueReference
  readonly profile: ExecutionProfile
  readonly origin: SessionOrigin
  readonly status: SessionStatus
  readonly controlMode?: SessionControlMode
  readonly recordedAt: string
}

export interface NormalizedSessionEvent {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.sessionEvent
  readonly eventId: OpaqueReference
  readonly eventDigest: Sha256Digest
  readonly sessionRef: OpaqueReference
  readonly sequence: number
  readonly occurredAt: string
  readonly recordedAt: string
  readonly source: SessionEventSource
  readonly type: NormalizedSessionEventType
  readonly payload: JsonObject
}

export type CreateSessionSnapshotResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot }
  | { readonly ok: false; readonly issue: ValidationIssue }

export type SessionReducerResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot; readonly replayed: boolean }
  | { readonly ok: false; readonly issue: ValidationIssue }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
}

function invalid(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message }
}

function hasRefPayload(payload: JsonObject, field: string): boolean {
  return hasExactFields(payload, [field]) && isOpaqueReference(payload[field])
}

function isValidEventPayload(event: NormalizedSessionEvent): boolean {
  const payload = event.payload
  switch (event.type) {
    case 'session.status_changed':
      return (
        hasExactFields(payload, ['status']) &&
        SESSION_STATUSES.includes(payload.status as never) &&
        !TERMINAL_SESSION_STATUSES.includes(payload.status as never)
      )
    case 'provider_attempt.registered':
    case 'provider_attempt.status_changed':
      return (
        hasExactFields(payload, ['attemptRef', 'status']) &&
        isOpaqueReference(payload.attemptRef) &&
        SESSION_STATUSES.includes(payload.status as never)
      )
    case 'turn.started':
    case 'turn.completed':
      return hasRefPayload(payload, 'turnRef')
    case 'turn.progress':
      return hasRefPayload(payload, 'progressRef')
    case 'interaction.requested':
      return (
        hasExactFields(payload, ['interactionRef', 'interactionClass']) &&
        isOpaqueReference(payload.interactionRef) &&
        INTERACTION_CLASSES.includes(payload.interactionClass as never)
      )
    case 'interaction.resolved':
      return hasRefPayload(payload, 'interactionRef')
    case 'dependency.wait_registered':
    case 'dependency.ready':
      return hasRefPayload(payload, 'dependencyRef')
    case 'command.acknowledged':
      return (
        hasExactFields(payload, ['commandId', 'status']) &&
        isOpaqueReference(payload.commandId) &&
        ACKNOWLEDGED_COMMAND_STATUSES.has(String(payload.status))
      )
    case 'handoff.available':
      return hasRefPayload(payload, 'handoffRef')
    case 'ownership.released':
      return hasRefPayload(payload, 'releaseRef')
    case 'session.terminal':
      return (
        hasExactFields(payload, ['status']) &&
        TERMINAL_SESSION_STATUSES.includes(payload.status as never)
      )
  }
}

export function validateNormalizedSessionEvent(
  input: unknown,
): ValidationResult<NormalizedSessionEvent> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [invalid('$', 'invalid_type', 'session event must be an object')],
    }
  }
  const issues: ValidationIssue[] = []
  const fields = [
    'schema',
    'eventId',
    'eventDigest',
    'sessionRef',
    'sequence',
    'occurredAt',
    'recordedAt',
    'source',
    'type',
    'payload',
  ]
  if (!hasExactFields(input, fields)) {
    issues.push(invalid('$', 'invalid_fields', 'event fields must match the schema'))
  }
  if (input.schema !== SESSION_CONTROL_SCHEMAS.sessionEvent) {
    issues.push(invalid('schema', 'invalid_schema', 'unsupported event schema'))
  }
  if (!isOpaqueReference(input.eventId) || !isOpaqueReference(input.sessionRef)) {
    issues.push(invalid('$', 'invalid_reference', 'invalid event or session reference'))
  }
  if (!isSha256Digest(input.eventDigest)) {
    issues.push(invalid('eventDigest', 'invalid_digest', 'invalid event digest'))
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) {
    issues.push(invalid('sequence', 'invalid_sequence', 'sequence must be positive'))
  }
  if (!isFiniteIsoTimestamp(input.occurredAt) || !isFiniteIsoTimestamp(input.recordedAt)) {
    issues.push(invalid('$', 'invalid_timestamp', 'event times must be finite ISO time'))
  }
  if (!SESSION_EVENT_SOURCES.includes(input.source as never)) {
    issues.push(invalid('source', 'invalid_source', 'invalid event source'))
  }
  if (!NORMALIZED_SESSION_EVENT_TYPES.includes(input.type as never)) {
    issues.push(invalid('type', 'invalid_event_type', 'invalid event type'))
  }
  if (!isRecord(input.payload) || !isJsonValue(input.payload)) {
    issues.push(invalid('payload', 'invalid_event_payload', 'payload must be portable JSON'))
  } else if (NORMALIZED_SESSION_EVENT_TYPES.includes(input.type as never)) {
    const candidate = input as unknown as NormalizedSessionEvent
    if (!isValidEventPayload(candidate)) {
      issues.push(invalid('payload', 'invalid_event_payload', 'payload does not match event type'))
    }
  }
  if (
    isFiniteIsoTimestamp(input.occurredAt) &&
    isFiniteIsoTimestamp(input.recordedAt) &&
    Date.parse(input.occurredAt) > Date.parse(input.recordedAt)
  ) {
    issues.push(invalid('occurredAt', 'event_from_future', 'occurrence follows record time'))
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as NormalizedSessionEvent }
}

function interactionStatus(interactionClass: InteractionClass): SessionStatus {
  if (interactionClass === 'dependency_wait') return 'waiting_for_dependency'
  if (interactionClass === 'unsupported_native_control') return 'blocked'
  if (
    interactionClass === 'plan_routing_choice' ||
    interactionClass === 'repository_mutation' ||
    interactionClass === 'permission_or_credential'
  ) {
    return 'waiting_for_approval'
  }
  return 'waiting_for_input'
}

export function validateSessionControlSessionView(
  input: unknown,
): ValidationResult<SessionControlSessionView> {
  if (!isRecord(input)) {
    return { ok: false, issues: [invalid('$', 'invalid_type', 'session view must be an object')] }
  }
  const issues: ValidationIssue[] = []
  if (!hasExactFields(input, ['sessionRef', 'origin', 'generation', 'status', 'controlMode'], ['pendingInteractionRef'])) {
    issues.push(invalid('$', 'invalid_fields', 'session view fields must match the schema'))
  }
  if (!isOpaqueReference(input.sessionRef)) {
    issues.push(invalid('sessionRef', 'invalid_reference', 'invalid session reference'))
  }
  if (!SESSION_ORIGINS.includes(input.origin as never)) {
    issues.push(invalid('origin', 'invalid_origin', 'invalid session origin'))
  }
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0) {
    issues.push(invalid('generation', 'invalid_generation', 'generation must be non-negative'))
  }
  if (!SESSION_STATUSES.includes(input.status as never)) {
    issues.push(invalid('status', 'invalid_status', 'invalid session status'))
  }
  if (!SESSION_CONTROL_MODES.includes(input.controlMode as never)) {
    issues.push(invalid('controlMode', 'invalid_control_mode', 'invalid control mode'))
  }
  if (input.pendingInteractionRef !== undefined && !isOpaqueReference(input.pendingInteractionRef)) {
    issues.push(invalid('pendingInteractionRef', 'invalid_reference', 'invalid interaction reference'))
  }
  if (input.origin === 'discovered_external' && input.controlMode !== 'read_only') {
    issues.push(invalid('controlMode', 'external_control_forbidden', 'discovery is read-only'))
  }
  if (
    TERMINAL_SESSION_STATUSES.includes(input.status as never) &&
    input.pendingInteractionRef !== undefined
  ) {
    issues.push(invalid('pendingInteractionRef', 'terminal_pending_state', 'terminal session cannot wait'))
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as SessionControlSessionView }
}

export function validateSessionSnapshot(input: unknown): ValidationResult<SessionSnapshot> {
  if (!isRecord(input)) {
    return { ok: false, issues: [invalid('$', 'invalid_type', 'session snapshot must be an object')] }
  }
  const issues: ValidationIssue[] = []
  if (
    !hasExactFields(
      input,
      [
        'schema',
        'sessionRef',
        'profile',
        'origin',
        'controlMode',
        'generation',
        'eventSequence',
        'status',
        'attempts',
        'createdAt',
        'updatedAt',
      ],
      ['pendingInteraction', 'pendingDependencyRef', 'lastHandoffRef', 'lastEventReceipt'],
    )
  ) {
    issues.push(invalid('$', 'invalid_fields', 'session snapshot fields must match the schema'))
  }
  if (input.schema !== SESSION_CONTROL_SCHEMAS.sessionSnapshot) {
    issues.push(invalid('schema', 'invalid_schema', 'unsupported session snapshot schema'))
  }
  if (!isOpaqueReference(input.sessionRef)) {
    issues.push(invalid('sessionRef', 'invalid_reference', 'invalid session reference'))
  }
  const profile = validateExecutionProfile(input.profile)
  if (!profile.ok) issues.push(invalid('profile', 'invalid_profile', 'invalid execution profile'))
  if (!SESSION_ORIGINS.includes(input.origin as never)) {
    issues.push(invalid('origin', 'invalid_origin', 'invalid session origin'))
  }
  if (!SESSION_CONTROL_MODES.includes(input.controlMode as never)) {
    issues.push(invalid('controlMode', 'invalid_control_mode', 'invalid control mode'))
  }
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0) {
    issues.push(invalid('generation', 'invalid_generation', 'generation must be non-negative'))
  }
  if (!Number.isSafeInteger(input.eventSequence) || Number(input.eventSequence) < 0) {
    issues.push(invalid('eventSequence', 'invalid_sequence', 'event sequence must be non-negative'))
  }
  if (!SESSION_STATUSES.includes(input.status as never)) {
    issues.push(invalid('status', 'invalid_status', 'invalid session status'))
  }
  if (!Array.isArray(input.attempts)) {
    issues.push(invalid('attempts', 'invalid_attempts', 'attempts must be an array'))
  } else {
    const seen = new Set<string>()
    for (const [index, attempt] of input.attempts.entries()) {
      if (
        !isRecord(attempt) ||
        !hasExactFields(attempt, ['attemptRef', 'status']) ||
        !isOpaqueReference(attempt.attemptRef) ||
        !SESSION_STATUSES.includes(attempt.status as never) ||
        seen.has(String(attempt.attemptRef))
      ) {
        issues.push(invalid(`attempts[${index}]`, 'invalid_attempt', 'invalid provider attempt'))
      } else {
        seen.add(attempt.attemptRef)
      }
    }
  }
  let validPendingInteraction: PendingInteraction | undefined
  if (input.pendingInteraction !== undefined) {
    if (
      !isRecord(input.pendingInteraction) ||
      !hasExactFields(input.pendingInteraction, ['interactionRef', 'interactionClass']) ||
      !isOpaqueReference(input.pendingInteraction.interactionRef) ||
      !INTERACTION_CLASSES.includes(input.pendingInteraction.interactionClass as never)
    ) {
      issues.push(invalid('pendingInteraction', 'invalid_interaction', 'invalid pending interaction'))
    } else {
      validPendingInteraction = input.pendingInteraction as unknown as PendingInteraction
    }
  }
  for (const field of ['pendingDependencyRef', 'lastHandoffRef'] as const) {
    if (input[field] !== undefined && !isOpaqueReference(input[field])) {
      issues.push(invalid(field, 'invalid_reference', `invalid ${field}`))
    }
  }
  if (input.lastEventReceipt !== undefined) {
    const receipt = input.lastEventReceipt
    if (
      !isRecord(receipt) ||
      !hasExactFields(receipt, [
        'eventId',
        'eventDigest',
        'sequence',
        'occurredAt',
        'recordedAt',
        'source',
        'type',
        'payload',
      ]) ||
      !isOpaqueReference(receipt.eventId) ||
      !isSha256Digest(receipt.eventDigest) ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence !== input.eventSequence ||
      !isFiniteIsoTimestamp(receipt.occurredAt) ||
      !isFiniteIsoTimestamp(receipt.recordedAt) ||
      !SESSION_EVENT_SOURCES.includes(receipt.source as never) ||
      !NORMALIZED_SESSION_EVENT_TYPES.includes(receipt.type as never) ||
      !isJsonValue(receipt.payload)
    ) {
      issues.push(invalid('lastEventReceipt', 'invalid_event_receipt', 'invalid last event receipt'))
    }
  } else if (Number(input.eventSequence) !== 0) {
    issues.push(invalid('lastEventReceipt', 'event_receipt_required', 'event sequence requires a receipt'))
  }
  if (!isFiniteIsoTimestamp(input.createdAt) || !isFiniteIsoTimestamp(input.updatedAt)) {
    issues.push(invalid('$', 'invalid_timestamp', 'snapshot times must be finite ISO time'))
  } else if (Date.parse(input.createdAt) > Date.parse(input.updatedAt)) {
    issues.push(invalid('createdAt', 'time_regression', 'creation follows update time'))
  }
  if (input.origin === 'discovered_external' && input.controlMode !== 'read_only') {
    issues.push(invalid('controlMode', 'external_control_forbidden', 'discovery is read-only'))
  }
  if (
    validPendingInteraction !== undefined &&
    input.status !== interactionStatus(validPendingInteraction.interactionClass)
  ) {
    issues.push(
      invalid(
        'pendingInteraction',
        'pending_interaction_status_mismatch',
        'pending interaction must retain its waiting status',
      ),
    )
  }
  if (input.pendingDependencyRef !== undefined && input.status !== 'waiting_for_dependency') {
    issues.push(
      invalid(
        'pendingDependencyRef',
        'pending_dependency_status_mismatch',
        'pending dependency must retain its waiting status',
      ),
    )
  }
  if (validPendingInteraction !== undefined && input.pendingDependencyRef !== undefined) {
    issues.push(invalid('$', 'conflicting_pending_state', 'session cannot retain two pending controls'))
  }
  if (
    TERMINAL_SESSION_STATUSES.includes(input.status as never) &&
    (input.pendingInteraction !== undefined || input.pendingDependencyRef !== undefined)
  ) {
    issues.push(invalid('$', 'terminal_pending_state', 'terminal session cannot retain pending state'))
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as SessionSnapshot }
}
