import { describe, expect, it } from 'vitest'
import {
  InMemorySessionStore,
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  asSha256Digest,
  createSessionSnapshot,
  type ExecutionProfile,
  type NormalizedSessionEvent,
} from '../index.js'

const PROFILE: ExecutionProfile = {
  schema: SESSION_CONTROL_SCHEMAS.executionProfile,
  executionStyle: 'durable',
  continuity: 'control_plane_managed',
  coordination: 'none',
}

function initial() {
  const result = createSessionSnapshot({
    sessionRef: asOpaqueReference('session_7Gf3kP2x'),
    profile: PROFILE,
    origin: 'managed',
    status: 'idle',
    recordedAt: '2026-09-04T20:00:00.000Z',
  })
  if (!result.ok) throw new Error(result.issue.code)
  return result.snapshot
}

function event(
  sequence: number,
  eventId: string,
  digestCharacter: string,
  overrides: Partial<NormalizedSessionEvent> = {},
): NormalizedSessionEvent {
  return {
    schema: SESSION_CONTROL_SCHEMAS.sessionEvent,
    eventId: asOpaqueReference(eventId),
    eventDigest: asSha256Digest(`sha256:${digestCharacter.repeat(64)}`),
    sessionRef: asOpaqueReference('session_7Gf3kP2x'),
    sequence,
    occurredAt: `2026-09-04T20:00:0${sequence}.000Z`,
    recordedAt: `2026-09-04T20:00:0${sequence}.000Z`,
    source: 'provider_adapter',
    type: sequence === 1 ? 'turn.started' : 'turn.progress',
    payload: sequence === 1 ? { turnRef: 'turn_8Hk4mQ3y' } : { progressRef: 'progress_9Jm5nR4z' },
    ...overrides,
  } as NormalizedSessionEvent
}

describe('in-memory session reference store', () => {
  it('enforces compare-and-swap generation before applying a new event', () => {
    const store = new InMemorySessionStore()
    expect(store.add(initial())).toMatchObject({ status: 'created' })

    expect(store.append(event(1, 'event_8Hk4mQ3y', 'a'), 1)).toEqual({
      status: 'conflict',
      reason: 'generation_mismatch',
    })
    expect(store.append(event(1, 'event_8Hk4mQ3y', 'a'), 0)).toMatchObject({
      status: 'applied',
      snapshot: { status: 'running', generation: 1, eventSequence: 1 },
    })
  })

  it('recognizes an exact older replay after later events', () => {
    const store = new InMemorySessionStore()
    store.add(initial())
    const first = event(1, 'event_8Hk4mQ3y', 'a')
    store.append(first, 0)
    store.append(event(2, 'event_9Jm5nR4z', 'b'), 1)

    expect(store.append(first, 999)).toMatchObject({
      status: 'replayed',
      snapshot: { eventSequence: 2 },
    })
  })

  it.each([
    ['payload', { payload: { turnRef: 'turn_4Db0hJ6u' } }],
    ['type', { type: 'session.status_changed', payload: { status: 'running' } }],
    [
      'time',
      {
        occurredAt: '2026-09-04T20:00:00.500Z',
        recordedAt: '2026-09-04T20:00:01.000Z',
      },
    ],
    ['source', { source: 'host' }],
  ] as const)('rejects replay with altered %s even when its digest is reused', (_field, change) => {
    const store = new InMemorySessionStore()
    const first = event(1, 'event_8Hk4mQ3y', 'a')
    store.add(initial())
    store.append(first, 0)

    expect(store.append({ ...first, ...change } as NormalizedSessionEvent, 1)).toEqual({
      status: 'conflict',
      reason: 'event_id_conflict',
    })
  })

  it('rejects reuse of an older event ID or sequence with different content', () => {
    const store = new InMemorySessionStore()
    store.add(initial())
    store.append(event(1, 'event_8Hk4mQ3y', 'a'), 0)
    store.append(event(2, 'event_9Jm5nR4z', 'b'), 1)

    expect(
      store.append(event(3, 'event_8Hk4mQ3y', 'c', { type: 'turn.progress' }), 1),
    ).toEqual({ status: 'conflict', reason: 'event_id_conflict' })
    expect(store.append(event(1, 'event_4Db0hJ6u', 'd'), 1)).toEqual({
      status: 'conflict',
      reason: 'event_sequence_conflict',
    })
  })

  it('keeps sessions isolated by opaque session reference', () => {
    const store = new InMemorySessionStore()
    store.add(initial())
    const missing = event(1, 'event_8Hk4mQ3y', 'a', {
      sessionRef: asOpaqueReference('session_5Ec1iK7v'),
    })
    expect(store.append(missing, 0)).toEqual({ status: 'conflict', reason: 'session_not_found' })
    expect(store.get(asOpaqueReference('session_7Gf3kP2x'))).toMatchObject({
      sessionRef: 'session_7Gf3kP2x',
    })
  })

  it('rejects an externally discovered snapshot that claims controllable state', () => {
    const store = new InMemorySessionStore()
    const malformed = {
      ...initial(),
      origin: 'discovered_external',
      controlMode: 'controllable',
    } as const

    expect(store.add(malformed)).toEqual({ status: 'conflict', reason: 'invalid_snapshot' })
  })
})
