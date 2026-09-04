import { describe, expect, it } from 'vitest'
import {
  InMemoryCommandLedger,
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  asSha256Digest,
  createCommandRecord,
  isTerminalCommandStatus,
  transitionCommandRecord,
  type SessionControlCommand,
} from '../index.js'

const NOW = '2026-09-04T20:00:00.000Z'

function command(overrides: Partial<SessionControlCommand> = {}): SessionControlCommand {
  return {
    schema: SESSION_CONTROL_SCHEMAS.command,
    commandId: asOpaqueReference('command_7Gf3kP2x'),
    commandDigest: asSha256Digest(`sha256:${'a'.repeat(64)}`),
    sessionRef: asOpaqueReference('session_8Hk4mQ3y'),
    action: 'send_message',
    expectedGeneration: 7,
    deadline: '2026-09-04T20:05:00.000Z',
    idempotencyKey: asSha256Digest(`sha256:${'b'.repeat(64)}`),
    correlationRef: asOpaqueReference('correlation_9Jm5nR4z'),
    payload: { message: 'Proceed.' },
    ...overrides,
  } as SessionControlCommand
}

describe('command ledger semantics', () => {
  it('treats accepted and provider-waiting as non-terminal', () => {
    const accepted = createCommandRecord(command(), { status: 'accepted', recordedAt: NOW })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(isTerminalCommandStatus(accepted.record.status)).toBe(false)

    const waiting = transitionCommandRecord(accepted.record, {
      status: 'provider_waiting',
      recordedAt: '2026-09-04T20:00:01.000Z',
      evidence: {
        kind: 'transport_acknowledgement',
        ref: asOpaqueReference('acknowledgement_3Ca9gH5t'),
      },
    })
    expect(waiting).toMatchObject({ ok: true, record: { status: 'provider_waiting' } })
  })

  it('requires effect evidence before applied', () => {
    const accepted = createCommandRecord(command(), { status: 'accepted', recordedAt: NOW })
    if (!accepted.ok) throw new Error('fixture must be valid')

    expect(
      transitionCommandRecord(accepted.record, {
        status: 'applied',
        recordedAt: '2026-09-04T20:00:01.000Z',
        evidence: {
          kind: 'transport_acknowledgement',
          ref: asOpaqueReference('acknowledgement_3Ca9gH5t'),
        },
      }),
    ).toMatchObject({ ok: false, issue: { code: 'application_evidence_required' } })

    expect(
      transitionCommandRecord(accepted.record, {
        status: 'applied',
        recordedAt: '2026-09-04T20:00:01.000Z',
        evidence: {
          kind: 'normalized_event',
          ref: asOpaqueReference('event_4Db0hJ6u'),
        },
      }),
    ).toMatchObject({ ok: true, record: { status: 'applied' } })
  })

  it('keeps terminal records immutable', () => {
    const applied = createCommandRecord(command(), {
      status: 'applied',
      recordedAt: NOW,
      evidence: {
        kind: 'subsequent_read',
        ref: asOpaqueReference('reading_5Ec1iK7v'),
      },
    })
    if (!applied.ok) throw new Error('fixture must be valid')
    expect(isTerminalCommandStatus(applied.record.status)).toBe(true)
    expect(
      transitionCommandRecord(applied.record, {
        status: 'failed',
        recordedAt: '2026-09-04T20:00:02.000Z',
        failureCode: 'late_failure',
      }),
    ).toMatchObject({ ok: false, issue: { code: 'terminal_record_immutable' } })
  })

  it('stores no raw command payload in durable records', () => {
    const result = createCommandRecord(command(), { status: 'accepted', recordedAt: NOW })
    if (!result.ok) throw new Error('fixture must be valid')
    expect(result.record).not.toHaveProperty('payload')
    expect(JSON.stringify(result.record)).not.toContain('Proceed.')
  })

  it('returns the existing record for exact idempotent replay', () => {
    const ledger = new InMemoryCommandLedger()
    const first = ledger.register(command(), { status: 'accepted', recordedAt: NOW })
    const replay = ledger.register(command(), {
      status: 'accepted',
      recordedAt: '2026-09-04T20:01:00.000Z',
    })

    expect(first).toMatchObject({ status: 'created' })
    expect(replay).toMatchObject({ status: 'replayed' })
    if (first.status === 'conflict' || replay.status === 'conflict') return
    expect(replay.record).toBe(first.record)
  })

  it('rejects idempotency-key reuse with another digest', () => {
    const ledger = new InMemoryCommandLedger()
    ledger.register(command(), { status: 'accepted', recordedAt: NOW })
    const result = ledger.register(
      command({
        commandId: asOpaqueReference('command_6Fd2jL8w'),
        commandDigest: asSha256Digest(`sha256:${'c'.repeat(64)}`),
      }),
      { status: 'accepted', recordedAt: NOW },
    )

    expect(result).toEqual({ status: 'conflict', reason: 'idempotency_digest_conflict' })
  })

  it('rejects command-ID reuse with a different identity', () => {
    const ledger = new InMemoryCommandLedger()
    ledger.register(command(), { status: 'accepted', recordedAt: NOW })
    const result = ledger.register(
      command({ idempotencyKey: asSha256Digest(`sha256:${'d'.repeat(64)}`) }),
      { status: 'accepted', recordedAt: NOW },
    )

    expect(result).toEqual({ status: 'conflict', reason: 'command_id_conflict' })
  })

  it('updates command and idempotency indexes together', () => {
    const ledger = new InMemoryCommandLedger()
    const registered = ledger.register(command(), { status: 'accepted', recordedAt: NOW })
    if (registered.status === 'conflict') throw new Error('fixture must be valid')

    const transitioned = ledger.transition(command().commandId, {
      status: 'failed',
      recordedAt: '2026-09-04T20:00:01.000Z',
      failureCode: 'adapter_error',
    })
    expect(transitioned).toMatchObject({ ok: true, record: { status: 'failed' } })
    expect(ledger.getByCommandId(command().commandId)).toBe(
      ledger.getByIdempotencyKey(command().idempotencyKey),
    )
  })
})
