import type { OpaqueReference } from './contracts.js'
import { reduceSessionEvent } from './session-reducer.js'
import {
  validateNormalizedSessionEvent,
  validateSessionSnapshot,
  type NormalizedSessionEvent,
  type SessionSnapshot,
} from './session-types.js'
import { areJsonValuesEqual } from './validation.js'

interface StoredSession {
  snapshot: SessionSnapshot
  readonly eventsById: Map<OpaqueReference, NormalizedSessionEvent>
  readonly eventsBySequence: Map<number, NormalizedSessionEvent>
}

export type SessionRegistrationResult =
  | { readonly status: 'created'; readonly snapshot: SessionSnapshot }
  | { readonly status: 'conflict'; readonly reason: string }

export type SessionAppendResult =
  | { readonly status: 'applied' | 'replayed'; readonly snapshot: SessionSnapshot }
  | { readonly status: 'conflict'; readonly reason: string }

function eventsMatch(left: NormalizedSessionEvent, right: NormalizedSessionEvent): boolean {
  return (
    left.schema === right.schema &&
    left.eventId === right.eventId &&
    left.eventDigest === right.eventDigest &&
    left.sessionRef === right.sessionRef &&
    left.sequence === right.sequence &&
    left.occurredAt === right.occurredAt &&
    left.recordedAt === right.recordedAt &&
    left.source === right.source &&
    left.type === right.type &&
    areJsonValuesEqual(left.payload, right.payload)
  )
}

function cloneEvent(event: NormalizedSessionEvent): NormalizedSessionEvent {
  return {
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload)) as NormalizedSessionEvent['payload'],
  }
}

export class InMemorySessionStore {
  readonly #sessions = new Map<OpaqueReference, StoredSession>()

  add(snapshot: SessionSnapshot): SessionRegistrationResult {
    if (!validateSessionSnapshot(snapshot).ok) {
      return { status: 'conflict', reason: 'invalid_snapshot' }
    }
    if (this.#sessions.has(snapshot.sessionRef)) {
      return { status: 'conflict', reason: 'session_exists' }
    }
    this.#sessions.set(snapshot.sessionRef, {
      snapshot,
      eventsById: new Map(),
      eventsBySequence: new Map(),
    })
    return { status: 'created', snapshot }
  }

  append(event: NormalizedSessionEvent, expectedGeneration: number): SessionAppendResult {
    const validation = validateNormalizedSessionEvent(event)
    if (!validation.ok) {
      return { status: 'conflict', reason: validation.issues[0]?.code ?? 'invalid_event' }
    }

    const stored = this.#sessions.get(event.sessionRef)
    if (stored === undefined) return { status: 'conflict', reason: 'session_not_found' }

    const byId = stored.eventsById.get(event.eventId)
    if (byId !== undefined) {
      return eventsMatch(byId, event)
        ? { status: 'replayed', snapshot: stored.snapshot }
        : { status: 'conflict', reason: 'event_id_conflict' }
    }

    const bySequence = stored.eventsBySequence.get(event.sequence)
    if (bySequence !== undefined) {
      return eventsMatch(bySequence, event)
        ? { status: 'replayed', snapshot: stored.snapshot }
        : { status: 'conflict', reason: 'event_sequence_conflict' }
    }

    if (stored.snapshot.generation !== expectedGeneration) {
      return { status: 'conflict', reason: 'generation_mismatch' }
    }

    const reduced = reduceSessionEvent(stored.snapshot, event)
    if (!reduced.ok) return { status: 'conflict', reason: reduced.issue.code }
    stored.snapshot = reduced.snapshot
    const retained = cloneEvent(event)
    stored.eventsById.set(event.eventId, retained)
    stored.eventsBySequence.set(event.sequence, retained)
    return { status: reduced.replayed ? 'replayed' : 'applied', snapshot: reduced.snapshot }
  }

  get(sessionRef: OpaqueReference): SessionSnapshot | undefined {
    return this.#sessions.get(sessionRef)?.snapshot
  }
}
