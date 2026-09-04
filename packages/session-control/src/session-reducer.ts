import {
  SESSION_CONTROL_SCHEMAS,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  type JsonObject,
  type SessionStatus,
  type ValidationIssue,
} from './contracts.js'
import {
  SESSION_ORIGINS,
  type CreateSessionSnapshotInput,
  type CreateSessionSnapshotResult,
  type NormalizedSessionEvent,
  type ProviderAttemptSnapshot,
  type SessionReducerResult,
  type SessionSnapshot,
  validateNormalizedSessionEvent,
  validateSessionSnapshot,
} from './session-types.js'
import {
  isFiniteIsoTimestamp,
  areJsonValuesEqual,
  isOpaqueReference,
  validateExecutionProfile,
} from './validation.js'

export function createSessionSnapshot(
  input: CreateSessionSnapshotInput,
): CreateSessionSnapshotResult {
  if (!isOpaqueReference(input.sessionRef)) {
    return { ok: false, issue: { path: 'sessionRef', code: 'invalid_reference', message: 'invalid session' } }
  }
  if (!validateExecutionProfile(input.profile).ok) {
    return { ok: false, issue: { path: 'profile', code: 'invalid_profile', message: 'invalid profile' } }
  }
  if (!SESSION_ORIGINS.includes(input.origin) || !SESSION_STATUSES.includes(input.status)) {
    return { ok: false, issue: { path: '$', code: 'invalid_session_state', message: 'invalid session state' } }
  }
  if (!isFiniteIsoTimestamp(input.recordedAt)) {
    return { ok: false, issue: { path: 'recordedAt', code: 'invalid_timestamp', message: 'invalid record time' } }
  }
  if (input.origin === 'discovered_external' && input.controlMode === 'controllable') {
    return {
      ok: false,
      issue: { path: 'controlMode', code: 'external_control_forbidden', message: 'discovery is read-only' },
    }
  }

  const snapshot: SessionSnapshot = {
    schema: SESSION_CONTROL_SCHEMAS.sessionSnapshot,
    sessionRef: input.sessionRef,
    profile: input.profile,
    origin: input.origin,
    controlMode:
      input.origin === 'discovered_external' ? 'read_only' : (input.controlMode ?? 'controllable'),
    generation: 0,
    eventSequence: 0,
    status: input.status,
    attempts: [],
    createdAt: input.recordedAt,
    updatedAt: input.recordedAt,
  }
  const validation = validateSessionSnapshot(snapshot)
  return validation.ok
    ? { ok: true, snapshot }
    : { ok: false, issue: validation.issues[0] as ValidationIssue }
}

const STATUS_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  discovered: ['idle', 'running', 'unreachable', 'failed', 'cancelled', 'unknown'],
  idle: ['running', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_dependency', 'blocked', 'paused', 'unreachable', 'completed', 'failed', 'cancelled', 'unknown'],
  running: ['idle', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_dependency', 'blocked', 'paused', 'unreachable', 'completed', 'failed', 'cancelled', 'unknown'],
  waiting_for_input: ['idle', 'running', 'blocked', 'paused', 'unreachable', 'completed', 'failed', 'cancelled', 'unknown'],
  waiting_for_approval: ['idle', 'running', 'blocked', 'paused', 'unreachable', 'completed', 'failed', 'cancelled', 'unknown'],
  waiting_for_dependency: ['idle', 'running', 'blocked', 'paused', 'unreachable', 'completed', 'failed', 'cancelled', 'unknown'],
  blocked: ['idle', 'running', 'paused', 'unreachable', 'failed', 'cancelled', 'unknown'],
  paused: ['idle', 'running', 'unreachable', 'failed', 'cancelled', 'unknown'],
  unreachable: ['idle', 'running', 'failed', 'cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  unknown: ['discovered', 'idle', 'running', 'blocked', 'paused', 'unreachable', 'failed', 'cancelled'],
}

function interactionStatus(interactionClass: string): SessionStatus {
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

function failure(code: string, message: string, path = '$'): SessionReducerResult {
  return { ok: false, issue: { path, code, message } }
}

export function reduceSessionEvent(
  snapshot: SessionSnapshot,
  input: NormalizedSessionEvent,
): SessionReducerResult {
  const snapshotResult = validateSessionSnapshot(snapshot)
  if (!snapshotResult.ok) return failure('invalid_snapshot', 'session snapshot validation failed')
  const eventResult = validateNormalizedSessionEvent(input)
  if (!eventResult.ok) {
    const payloadIssue = eventResult.issues.find((issue) => issue.code === 'invalid_event_payload')
    return failure(payloadIssue?.code ?? 'invalid_event', 'event validation failed')
  }
  const event = eventResult.value
  if (event.sessionRef !== snapshot.sessionRef) return failure('session_mismatch', 'event session differs')
  const last = snapshot.lastEventReceipt
  if (last !== undefined && event.eventId === last.eventId) {
    if (
      event.sequence === last.sequence &&
      event.eventDigest === last.eventDigest &&
      event.occurredAt === last.occurredAt &&
      event.recordedAt === last.recordedAt &&
      event.source === last.source &&
      event.type === last.type &&
      areJsonValuesEqual(event.payload, last.payload)
    ) {
      return { ok: true, snapshot, replayed: true }
    }
    return failure('event_replay_conflict', 'event ID was reused with different content')
  }
  if (event.sequence <= snapshot.eventSequence) {
    return failure('event_replay_conflict', 'event sequence was already consumed')
  }
  if (event.sequence !== snapshot.eventSequence + 1) {
    return failure('event_sequence_gap', 'event sequence must be contiguous')
  }
  if (Date.parse(event.recordedAt) < Date.parse(snapshot.updatedAt)) {
    return failure('record_time_regression', 'event record time moved backwards')
  }
  if (TERMINAL_SESSION_STATUSES.includes(snapshot.status as never)) {
    return failure('terminal_session_immutable', 'terminal session is immutable')
  }

  let status = snapshot.status
  let controlMode = snapshot.controlMode
  let attempts = snapshot.attempts
  let pendingInteraction = snapshot.pendingInteraction
  let pendingDependencyRef = snapshot.pendingDependencyRef
  let lastHandoffRef = snapshot.lastHandoffRef
  let controlChanged = false
  const payload = event.payload

  switch (event.type) {
    case 'session.status_changed':
      status = payload.status as SessionStatus
      break
    case 'provider_attempt.registered': {
      const attemptRef = payload.attemptRef as ProviderAttemptSnapshot['attemptRef']
      if (attempts.some((attempt) => attempt.attemptRef === attemptRef)) {
        return failure('attempt_exists', 'provider attempt already exists')
      }
      attempts = [...attempts, { attemptRef, status: payload.status as SessionStatus }]
      controlChanged = true
      break
    }
    case 'provider_attempt.status_changed': {
      const index = attempts.findIndex((attempt) => attempt.attemptRef === payload.attemptRef)
      if (index < 0) return failure('attempt_not_found', 'provider attempt does not exist')
      const next = [...attempts]
      const current = next[index]
      if (current !== undefined && current.status !== payload.status) {
        next[index] = { ...current, status: payload.status as SessionStatus }
        attempts = next
        controlChanged = true
      }
      break
    }
    case 'turn.started':
      status = 'running'
      break
    case 'turn.progress':
    case 'command.acknowledged':
      break
    case 'interaction.requested':
      pendingInteraction = {
        interactionRef: payload.interactionRef as NonNullable<typeof pendingInteraction>['interactionRef'],
        interactionClass: payload.interactionClass as NonNullable<typeof pendingInteraction>['interactionClass'],
      }
      status = interactionStatus(payload.interactionClass as string)
      controlChanged = true
      break
    case 'interaction.resolved':
      if (pendingInteraction?.interactionRef !== payload.interactionRef) {
        return failure('interaction_mismatch', 'resolved interaction is not pending')
      }
      pendingInteraction = undefined
      status = 'idle'
      controlChanged = true
      break
    case 'dependency.wait_registered':
      pendingDependencyRef = payload.dependencyRef as NonNullable<typeof pendingDependencyRef>
      status = 'waiting_for_dependency'
      controlChanged = true
      break
    case 'dependency.ready':
      if (pendingDependencyRef !== payload.dependencyRef) {
        return failure('dependency_mismatch', 'ready dependency is not pending')
      }
      pendingDependencyRef = undefined
      status = 'idle'
      controlChanged = true
      break
    case 'handoff.available':
      lastHandoffRef = payload.handoffRef as NonNullable<typeof lastHandoffRef>
      break
    case 'ownership.released':
      if (controlMode !== 'read_only') {
        controlMode = 'read_only'
        controlChanged = true
      }
      break
    case 'turn.completed':
      status = 'idle'
      break
    case 'session.terminal':
      status = payload.status as SessionStatus
      pendingInteraction = undefined
      pendingDependencyRef = undefined
      controlChanged = true
      break
  }

  if (status !== snapshot.status) {
    if (!STATUS_TRANSITIONS[snapshot.status].includes(status)) {
      return failure('invalid_status_transition', 'session status transition is not allowed')
    }
    controlChanged = true
  }

  if (pendingInteraction !== undefined && status !== interactionStatus(pendingInteraction.interactionClass)) {
    return failure('pending_interaction_unresolved', 'pending interaction must be resolved explicitly')
  }
  if (pendingDependencyRef !== undefined && status !== 'waiting_for_dependency') {
    return failure('pending_dependency_unresolved', 'pending dependency must become ready explicitly')
  }
  if (pendingInteraction !== undefined && pendingDependencyRef !== undefined) {
    return failure('conflicting_pending_state', 'session cannot retain two pending controls')
  }

  return {
    ok: true,
    replayed: false,
    snapshot: {
      ...snapshot,
      status,
      controlMode,
      attempts,
      generation: snapshot.generation + (controlChanged ? 1 : 0),
      eventSequence: event.sequence,
      updatedAt: event.recordedAt,
      lastEventReceipt: {
        eventId: event.eventId,
        eventDigest: event.eventDigest,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        source: event.source,
        type: event.type,
        payload: JSON.parse(JSON.stringify(event.payload)) as JsonObject,
      },
      ...(pendingInteraction === undefined ? { pendingInteraction: undefined } : { pendingInteraction }),
      ...(pendingDependencyRef === undefined
        ? { pendingDependencyRef: undefined }
        : { pendingDependencyRef }),
      ...(lastHandoffRef === undefined ? {} : { lastHandoffRef }),
    },
  }
}
