import { describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  asSha256Digest,
  createSessionSnapshot,
  reduceSessionEvent,
  type ExecutionProfile,
  type InteractionClass,
  type NormalizedSessionEvent,
  type SessionSnapshot,
} from '../index.js'

const AT = '2026-09-04T20:00:00.000Z'
const PROFILE: ExecutionProfile = {
  schema: SESSION_CONTROL_SCHEMAS.executionProfile,
  executionStyle: 'durable',
  continuity: 'control_plane_managed',
  coordination: 'none',
}

function snapshot(
  overrides: Partial<Parameters<typeof createSessionSnapshot>[0]> = {},
): SessionSnapshot {
  const result = createSessionSnapshot({
    sessionRef: asOpaqueReference('session_7Gf3kP2x'),
    profile: PROFILE,
    origin: 'managed',
    status: 'idle',
    recordedAt: AT,
    ...overrides,
  })
  if (!result.ok) throw new Error(result.issue.code)
  return result.snapshot
}

function event(overrides: Partial<NormalizedSessionEvent> = {}): NormalizedSessionEvent {
  return {
    schema: SESSION_CONTROL_SCHEMAS.sessionEvent,
    eventId: asOpaqueReference('event_8Hk4mQ3y'),
    eventDigest: asSha256Digest(`sha256:${'a'.repeat(64)}`),
    sessionRef: asOpaqueReference('session_7Gf3kP2x'),
    sequence: 1,
    occurredAt: '2026-09-04T20:00:01.000Z',
    recordedAt: '2026-09-04T20:00:01.000Z',
    source: 'provider_adapter',
    type: 'turn.started',
    payload: { turnRef: 'turn_9Jm5nR4z' },
    ...overrides,
  } as NormalizedSessionEvent
}

describe('session event reducer', () => {
  it('requires the next event sequence without gaps', () => {
    expect(reduceSessionEvent(snapshot(), event({ sequence: 2 }))).toMatchObject({
      ok: false,
      issue: { code: 'event_sequence_gap' },
    })
  })

  it('replays an exact latest event and rejects conflicting reuse', () => {
    const firstEvent = event()
    const first = reduceSessionEvent(snapshot(), firstEvent)
    if (!first.ok) throw new Error(first.issue.code)

    expect(reduceSessionEvent(first.snapshot, firstEvent)).toEqual({
      ok: true,
      snapshot: first.snapshot,
      replayed: true,
    })
    expect(
      reduceSessionEvent(
        first.snapshot,
        event({ eventDigest: asSha256Digest(`sha256:${'b'.repeat(64)}`) }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'event_replay_conflict' } })
    expect(
      reduceSessionEvent(
        first.snapshot,
        event({ payload: { turnRef: 'turn_4Db0hJ6u' } }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'event_replay_conflict' } })
  })

  it('does not advance generation for progress or command acknowledgement', () => {
    const running = snapshot({ status: 'running' })
    const progress = reduceSessionEvent(
      running,
      event({ type: 'turn.progress', payload: { progressRef: 'progress_3Ca9gH5t' } }),
    )
    if (!progress.ok) throw new Error(progress.issue.code)
    expect(progress.snapshot.generation).toBe(0)

    const acknowledgement = reduceSessionEvent(
      progress.snapshot,
      event({
        eventId: asOpaqueReference('event_4Db0hJ6u'),
        eventDigest: asSha256Digest(`sha256:${'c'.repeat(64)}`),
        sequence: 2,
        type: 'command.acknowledged',
        payload: { commandId: 'command_5Ec1iK7v', status: 'accepted' },
      }),
    )
    if (!acknowledgement.ok) throw new Error(acknowledgement.issue.code)
    expect(acknowledgement.snapshot.generation).toBe(0)
  })

  it('advances generation exactly once for a control-relevant status change', () => {
    const changed = reduceSessionEvent(
      snapshot(),
      event({ type: 'session.status_changed', payload: { status: 'paused' } }),
    )
    expect(changed).toMatchObject({
      ok: true,
      replayed: false,
      snapshot: { status: 'paused', generation: 1, eventSequence: 1 },
    })
  })

  it.each([
    ['informational_clarification', 'waiting_for_input'],
    ['provider_specific', 'waiting_for_input'],
    ['plan_routing_choice', 'waiting_for_approval'],
    ['repository_mutation', 'waiting_for_approval'],
    ['permission_or_credential', 'waiting_for_approval'],
    ['dependency_wait', 'waiting_for_dependency'],
    ['unsupported_native_control', 'blocked'],
  ] as const)('maps %s interaction to %s without answering it', (interactionClass, status) => {
    const result = reduceSessionEvent(
      snapshot(),
      event({
        type: 'interaction.requested',
        payload: { interactionRef: 'interaction_6Fd2jL8w', interactionClass },
      }),
    )
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        status,
        pendingInteraction: { interactionRef: 'interaction_6Fd2jL8w', interactionClass },
      },
    })
    if (!result.ok) return
    expect(result.snapshot.pendingInteraction).not.toHaveProperty('answer')
  })

  it('resolves only the exact pending interaction', () => {
    const requested = reduceSessionEvent(
      snapshot(),
      event({
        type: 'interaction.requested',
        payload: {
          interactionRef: 'interaction_6Fd2jL8w',
          interactionClass: 'informational_clarification' satisfies InteractionClass,
        },
      }),
    )
    if (!requested.ok) throw new Error(requested.issue.code)

    expect(
      reduceSessionEvent(
        requested.snapshot,
        event({
          eventId: asOpaqueReference('event_5Ec1iK7v'),
          eventDigest: asSha256Digest(`sha256:${'d'.repeat(64)}`),
          sequence: 2,
          type: 'interaction.resolved',
          payload: { interactionRef: 'interaction_4Db0hJ6u' },
        }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'interaction_mismatch' } })
  })

  it('returns to idle only when the exact dependency becomes ready', () => {
    const waiting = reduceSessionEvent(
      snapshot(),
      event({
        type: 'dependency.wait_registered',
        payload: { dependencyRef: 'dependency_3Ca9gH5t' },
      }),
    )
    if (!waiting.ok) throw new Error(waiting.issue.code)
    expect(waiting.snapshot.status).toBe('waiting_for_dependency')

    const ready = reduceSessionEvent(
      waiting.snapshot,
      event({
        eventId: asOpaqueReference('event_4Db0hJ6u'),
        eventDigest: asSha256Digest(`sha256:${'e'.repeat(64)}`),
        sequence: 2,
        type: 'dependency.ready',
        payload: { dependencyRef: 'dependency_3Ca9gH5t' },
      }),
    )
    expect(ready).toMatchObject({
      ok: true,
      snapshot: { status: 'idle', pendingDependencyRef: undefined, generation: 2 },
    })
  })

  it('registers only opaque provider-attempt references', () => {
    expect(
      reduceSessionEvent(
        snapshot(),
        event({
          type: 'provider_attempt.registered',
          payload: { attemptRef: '/tmp/native/session', status: 'running' },
        }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'invalid_event_payload' } })

    expect(
      reduceSessionEvent(
        snapshot(),
        event({
          type: 'provider_attempt.registered',
          payload: { attemptRef: 'attempt_3Ca9gH5t', status: 'running' },
        }),
      ),
    ).toMatchObject({
      ok: true,
      snapshot: { attempts: [{ attemptRef: 'attempt_3Ca9gH5t', status: 'running' }] },
    })
  })

  it('makes externally discovered sessions read-only', () => {
    expect(snapshot({ origin: 'discovered_external', status: 'discovered' })).toMatchObject({
      origin: 'discovered_external',
      controlMode: 'read_only',
    })
  })

  it('rejects an invalid explicit control mode at session creation', () => {
    expect(
      createSessionSnapshot({
        sessionRef: asOpaqueReference('session_7Gf3kP2x'),
        profile: PROFILE,
        origin: 'managed',
        status: 'idle',
        controlMode: 'elevated' as never,
        recordedAt: AT,
      }),
    ).toMatchObject({ ok: false, issue: { code: 'invalid_control_mode' } })
  })

  it('keeps terminal sessions immutable', () => {
    const terminal = snapshot({ status: 'completed' })
    expect(
      reduceSessionEvent(
        terminal,
        event({ type: 'session.status_changed', payload: { status: 'running' } }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'terminal_session_immutable' } })
  })

  it.each([
    [
      'interaction',
      {
        type: 'interaction.requested',
        payload: {
          interactionRef: 'interaction_6Fd2jL8w',
          interactionClass: 'informational_clarification',
        },
      },
    ],
    [
      'dependency',
      {
        type: 'dependency.wait_registered',
        payload: { dependencyRef: 'dependency_3Ca9gH5t' },
      },
    ],
  ] as const)('requires session.terminal instead of status_changed with pending %s state', (_kind, pending) => {
    const waiting = reduceSessionEvent(snapshot(), event(pending as Partial<NormalizedSessionEvent>))
    if (!waiting.ok) throw new Error(waiting.issue.code)

    expect(
      reduceSessionEvent(
        waiting.snapshot,
        event({
          eventId: asOpaqueReference('event_4Db0hJ6u'),
          eventDigest: asSha256Digest(`sha256:${'f'.repeat(64)}`),
          sequence: 2,
          type: 'session.status_changed',
          payload: { status: 'completed' },
        }),
      ),
    ).toMatchObject({ ok: false, issue: { code: 'invalid_event_payload' } })
  })
})
