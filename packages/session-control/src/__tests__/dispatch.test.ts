import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  asSha256Digest,
  dispatchSessionCommand,
  type CommandAuthorityDecision,
  type SessionControlAdapter,
  type SessionControlCapability,
  type SessionControlCapabilityDeclaration,
  type SessionControlCapabilityManifest,
  type SessionControlCommand,
  type SessionControlSessionView,
} from '../index.js'

const NOW = '2026-09-04T20:00:00.000Z'
const AUTHORITY: CommandAuthorityDecision = {
  decision: 'allow',
  decisionRef: asOpaqueReference('decision_7Gf3kP2x'),
}

function unsupported(): SessionControlCapabilityDeclaration {
  return {
    support: 'unsupported',
    qualification: 'unqualified',
    availability: 'available',
    emulation: 'forbidden',
    reason: 'native_control_absent',
  }
}

function manifest(...callable: SessionControlCapability[]): SessionControlCapabilityManifest {
  return {
    schema: SESSION_CONTROL_SCHEMAS.capabilityManifest,
    manifestRef: asOpaqueReference('manifest_8Hk4mQ3y'),
    adapterRef: asOpaqueReference('adapter_9Jm5nR4z'),
    providerKey: 'provider-neutral-a',
    observedAt: NOW,
    capabilities: Object.fromEntries(
      SESSION_CONTROL_CAPABILITIES.map((capability) => [
        capability,
        callable.includes(capability)
          ? {
              support: 'native',
              qualification: 'qualified',
              availability: 'available',
              emulation: 'forbidden',
              evidenceRefs: [asOpaqueReference('evidence_3Ca9gH5t')],
            }
          : unsupported(),
      ]),
    ) as Record<SessionControlCapability, SessionControlCapabilityDeclaration>,
  }
}

function command(overrides: Partial<SessionControlCommand> = {}): SessionControlCommand {
  return {
    schema: SESSION_CONTROL_SCHEMAS.command,
    commandId: asOpaqueReference('command_4Db0hJ6u'),
    commandDigest: asSha256Digest(`sha256:${'a'.repeat(64)}`),
    sessionRef: asOpaqueReference('session_5Ec1iK7v'),
    action: 'send_message',
    expectedGeneration: 3,
    deadline: '2026-09-04T20:05:00.000Z',
    idempotencyKey: asSha256Digest(`sha256:${'b'.repeat(64)}`),
    correlationRef: asOpaqueReference('correlation_6Fd2jL8w'),
    payload: { message: 'Proceed.' },
    ...overrides,
  } as SessionControlCommand
}

function session(overrides: Partial<SessionControlSessionView> = {}): SessionControlSessionView {
  return {
    sessionRef: asOpaqueReference('session_5Ec1iK7v'),
    generation: 3,
    status: 'idle',
    controlMode: 'controllable',
    ...overrides,
  }
}

describe('session command dispatch', () => {
  it('makes zero adapter calls when authority admission rejects', async () => {
    const sendMessage = vi.fn(async () => ({ status: 'accepted' as const }))
    const adapter: SessionControlAdapter = { manifest: manifest('send_message'), sendMessage }

    await expect(
      dispatchSessionCommand({
        command: command(),
        session: session(),
        adapter,
        authority: undefined,
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'rejected_authority' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('selects the exact method and passes only the normalized invocation', async () => {
    const sendMessage = vi.fn(async () => ({ status: 'accepted' as const }))
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted' as const }))
    const adapter: SessionControlAdapter = {
      manifest: manifest('send_message', 'steer_active_turn'),
      sendMessage,
      steerActiveTurn,
    }

    await expect(
      dispatchSessionCommand({
        command: command(),
        session: session(),
        adapter,
        authority: AUTHORITY,
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'accepted' })
    expect(sendMessage).toHaveBeenCalledWith({
      commandId: 'command_4Db0hJ6u',
      sessionRef: 'session_5Ec1iK7v',
      expectedGeneration: 3,
      deadline: '2026-09-04T20:05:00.000Z',
      idempotencyKey: `sha256:${'b'.repeat(64)}`,
      correlationRef: 'correlation_6Fd2jL8w',
      payload: { message: 'Proceed.' },
    })
    expect(steerActiveTurn).not.toHaveBeenCalled()
  })

  it('requires effect evidence for an adapter-applied result', async () => {
    const transportOnly: SessionControlAdapter = {
      manifest: manifest('send_message'),
      sendMessage: vi.fn(async () => ({
        status: 'applied' as const,
        evidence: {
          kind: 'transport_acknowledgement' as const,
          ref: asOpaqueReference('acknowledgement_7Gf3kP2x'),
        },
      })),
    }
    const evidenced: SessionControlAdapter = {
      manifest: manifest('send_message'),
      sendMessage: vi.fn(async () => ({
        status: 'applied' as const,
        evidence: {
          kind: 'provider_event' as const,
          ref: asOpaqueReference('event_8Hk4mQ3y'),
        },
      })),
    }
    const input = { command: command(), session: session(), authority: AUTHORITY, now: NOW }

    await expect(dispatchSessionCommand({ ...input, adapter: transportOnly })).resolves.toEqual({
      status: 'failed',
      reason: 'application_evidence_required',
    })
    await expect(dispatchSessionCommand({ ...input, adapter: evidenced })).resolves.toEqual({
      status: 'applied',
      evidence: { kind: 'provider_event', ref: 'event_8Hk4mQ3y' },
    })
  })

  it('normalizes adapter exceptions without leaking native error objects', async () => {
    const adapter: SessionControlAdapter = {
      manifest: manifest('send_message'),
      sendMessage: vi.fn(async () => {
        throw new Error('secret native provider transcript')
      }),
    }
    const result = await dispatchSessionCommand({
      command: command(),
      session: session(),
      adapter,
      authority: AUTHORITY,
      now: NOW,
    })

    expect(result).toEqual({ status: 'failed', reason: 'adapter_error' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('rejects nonconformant callable manifests before invocation', async () => {
    const adapter: SessionControlAdapter = { manifest: manifest('send_message') }
    await expect(
      dispatchSessionCommand({
        command: command(),
        session: session(),
        adapter,
        authority: AUTHORITY,
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'adapter_nonconformant' })
  })
})
