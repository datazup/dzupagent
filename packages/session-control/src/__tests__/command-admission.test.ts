import { describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_COMMAND_ACTIONS,
  SESSION_CONTROL_SCHEMAS,
  SESSION_STATUSES,
  admitSessionControlCommand,
  asOpaqueReference,
  asSha256Digest,
  projectInlineAdapterResult,
  validateSessionControlCommand,
  type ExecutionProfile,
  type SessionControlCapability,
  type SessionControlCapabilityDeclaration,
  type SessionControlCapabilityManifest,
  type SessionControlCommand,
  type SessionControlCommandAction,
  type SessionControlSessionView,
  type SessionStatus,
} from '../index.js'

const ALLOW = {
  decision: 'allow',
  decisionRef: asOpaqueReference('decision_7Gf3kP2x'),
} as const
const NOW = '2026-09-04T20:00:00.000Z'

function unsupported(): SessionControlCapabilityDeclaration {
  return {
    support: 'unsupported',
    qualification: 'unqualified',
    availability: 'available',
    emulation: 'forbidden',
    reason: 'native_control_absent',
  }
}

function manifest(
  action: SessionControlCapability = 'send_message',
  declaration: SessionControlCapabilityDeclaration = {
    support: 'native',
    qualification: 'qualified',
    availability: 'available',
    emulation: 'forbidden',
    evidenceRefs: [asOpaqueReference('evidence_8Hk4mQ3y')],
  },
): SessionControlCapabilityManifest {
  return {
    schema: SESSION_CONTROL_SCHEMAS.capabilityManifest,
    manifestRef: asOpaqueReference('manifest_9Jm5nR4z'),
    adapterRef: asOpaqueReference('adapter_6Fd2jL8w'),
    providerKey: 'provider-neutral-a',
    observedAt: NOW,
    capabilities: Object.fromEntries(
      SESSION_CONTROL_CAPABILITIES.map((capability) => [
        capability,
        capability === action ? declaration : unsupported(),
      ]),
    ) as Record<SessionControlCapability, SessionControlCapabilityDeclaration>,
  }
}

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
    payload: { message: 'Proceed with the admitted validation only.' },
    ...overrides,
  } as SessionControlCommand
}

function session(overrides: Partial<SessionControlSessionView> = {}): SessionControlSessionView {
  return {
    sessionRef: asOpaqueReference('session_8Hk4mQ3y'),
    origin: 'managed',
    generation: 7,
    status: 'idle',
    controlMode: 'controllable',
    ...overrides,
  }
}

describe('session command admission', () => {
  it('admits a valid exact-generation command with explicit authority', () => {
    expect(
      admitSessionControlCommand({
        command: command(),
        session: session(),
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toEqual({
      status: 'accepted',
      capability: 'send_message',
      authorityDecisionRef: 'decision_7Gf3kP2x',
    })
  })

  it('rejects malformed digests and non-finite deadlines', () => {
    expect(validateSessionControlCommand(command({ commandDigest: 'ABC' as never }))).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_digest' })]),
    })
    expect(
      validateSessionControlCommand(command({ deadline: 'sometime later' })),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_deadline' })]),
    })
  })

  it('rejects expired or generation-stale commands before authority', () => {
    expect(
      admitSessionControlCommand({
        command: command({ deadline: NOW }),
        session: session(),
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_stale', reason: 'deadline_expired' })
    expect(
      admitSessionControlCommand({
        command: command({ deadline: NOW }),
        session: session(),
        manifest: manifest(),
        authority: ALLOW,
        now: '2026-09-04T20:00:00.001Z',
      }),
    ).toMatchObject({ status: 'rejected_stale', reason: 'deadline_expired' })
    expect(
      admitSessionControlCommand({
        command: command({ expectedGeneration: 6 }),
        session: session(),
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_stale', reason: 'generation_mismatch' })
  })

  it('has no default authority and preserves explicit denial', () => {
    expect(
      admitSessionControlCommand({
        command: command(),
        session: session(),
        manifest: manifest(),
        authority: undefined,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_authority', reason: 'authority_decision_required' })
    expect(
      admitSessionControlCommand({
        command: command(),
        session: session(),
        manifest: manifest(),
        authority: {
          decision: 'deny',
          decisionRef: asOpaqueReference('decision_5Ec1iK7v'),
        },
        now: NOW,
      }),
    ).toMatchObject({
      status: 'rejected_authority',
      reason: 'authority_denied',
      authorityDecisionRef: 'decision_5Ec1iK7v',
    })
  })

  it('rejects terminal and read-only sessions', () => {
    expect(
      admitSessionControlCommand({
        command: command(),
        session: session({ status: 'completed' }),
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_stale', reason: 'session_terminal' })
    expect(
      admitSessionControlCommand({
        command: command(),
        session: session({ controlMode: 'read_only' }),
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_authority', reason: 'session_read_only' })
  })

  it('rejects an externally discovered session that claims to be controllable', () => {
    const malformedExternal = {
      ...session(),
      origin: 'discovered_external',
      controlMode: 'controllable',
    } as unknown as SessionControlSessionView

    expect(
      admitSessionControlCommand({
        command: command(),
        session: malformedExternal,
        manifest: manifest(),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'failed', reason: 'invalid_session_view' })
  })

  it('distinguishes unsupported, unqualified, and temporarily unavailable control', () => {
    const base = { command: command(), session: session(), authority: ALLOW, now: NOW }
    expect(admitSessionControlCommand({ ...base, manifest: manifest('pause') })).toMatchObject({
      status: 'unsupported',
      reason: 'capability_unsupported',
    })
    expect(
      admitSessionControlCommand({
        ...base,
        manifest: manifest('send_message', {
          support: 'native',
          qualification: 'unqualified',
          availability: 'available',
          emulation: 'forbidden',
          reason: 'qualification_pending',
        }),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'capability_unqualified' })
    expect(
      admitSessionControlCommand({
        ...base,
        manifest: manifest('send_message', {
          support: 'native',
          qualification: 'qualified',
          availability: 'temporarily_unavailable',
          emulation: 'forbidden',
          reason: 'runtime_offline',
          evidenceRefs: [asOpaqueReference('evidence_8Hk4mQ3y')],
        }),
      }),
    ).toMatchObject({ status: 'failed', reason: 'capability_temporarily_unavailable' })
  })

  it('requires the exact pending interaction for interaction responses', () => {
    const interactionCommand = command({
      action: 'respond_interaction',
      payload: { interactionRef: 'interaction_4Db0hJ6u', answer: 'Proceed.' },
    })
    expect(
      admitSessionControlCommand({
        command: interactionCommand,
        session: session({
          status: 'waiting_for_input',
          pendingInteractionRef: asOpaqueReference('interaction_3Ca9gH5t'),
        }),
        manifest: manifest('respond_interaction'),
        authority: ALLOW,
        now: NOW,
      }),
    ).toMatchObject({ status: 'rejected_stale', reason: 'interaction_mismatch' })
  })

  it.each(SESSION_CONTROL_COMMAND_ACTIONS)(
    'fails closed for every unspecified %s session-state pair',
    (action) => {
      const allowed: Readonly<Record<SessionControlCommandAction, readonly SessionStatus[]>> = {
        send_message: ['idle'],
        steer_active_turn: ['running'],
        respond_interaction: ['waiting_for_input', 'waiting_for_approval'],
        pause: [
          'idle',
          'running',
          'waiting_for_input',
          'waiting_for_approval',
          'waiting_for_dependency',
          'blocked',
        ],
        resume: ['paused', 'unreachable'],
        interrupt: [
          'running',
          'waiting_for_input',
          'waiting_for_approval',
          'waiting_for_dependency',
          'blocked',
        ],
        fork: ['idle', 'paused', 'blocked'],
      }
      const payloadByAction: Readonly<Record<SessionControlCommandAction, SessionControlCommand['payload']>> = {
        send_message: { message: 'Proceed.' },
        steer_active_turn: { message: 'Use the admitted path.' },
        respond_interaction: { interactionRef: 'interaction_4Db0hJ6u', answer: 'Proceed.' },
        pause: { reasonRef: 'reason_5Ec1iK7v' },
        resume: {},
        interrupt: { reasonRef: 'reason_5Ec1iK7v' },
        fork: { targetSessionRef: 'session_6Fd2jL8w' },
      }

      for (const status of SESSION_STATUSES) {
        const result = admitSessionControlCommand({
          command: command({ action, payload: payloadByAction[action] }),
          session: session({
            status,
            ...(action === 'respond_interaction' &&
            (status === 'waiting_for_input' || status === 'waiting_for_approval')
              ? { pendingInteractionRef: asOpaqueReference('interaction_4Db0hJ6u') }
              : {}),
          }),
          manifest: manifest(action),
          authority: ALLOW,
          now: NOW,
        })
        if (allowed[action].includes(status)) {
          expect(result, `${action}:${status}`).toMatchObject({ status: 'accepted' })
        } else {
          expect(result, `${action}:${status}`).toMatchObject({ status: 'rejected_stale' })
        }
      }
    },
  )

  it('returns inline interactions to the caller without autonomous continuation', () => {
    const inlineProfile: ExecutionProfile = {
      schema: SESSION_CONTROL_SCHEMAS.executionProfile,
      executionStyle: 'inline',
      continuity: 'none',
      coordination: 'none',
    }
    expect(
      projectInlineAdapterResult(inlineProfile, {
        status: 'interaction_required',
        interactionRef: asOpaqueReference('interaction_4Db0hJ6u'),
      }),
    ).toEqual({
      status: 'interaction_required',
      interactionRef: 'interaction_4Db0hJ6u',
      automaticContinuation: false,
    })
  })

  it('fails closed for invalid inline profiles and incomplete adapter receipts', () => {
    const invalidInlineProfile = {
      schema: SESSION_CONTROL_SCHEMAS.executionProfile,
      executionStyle: 'inline',
      continuity: 'provider_native',
      coordination: 'supervised',
    } as const
    const inlineProfile: ExecutionProfile = {
      schema: SESSION_CONTROL_SCHEMAS.executionProfile,
      executionStyle: 'inline',
      continuity: 'none',
      coordination: 'none',
    }

    expect(
      projectInlineAdapterResult(invalidInlineProfile, { status: 'accepted' }),
    ).toEqual({
      status: 'failed',
      failureCode: 'invalid_execution_profile',
      automaticContinuation: false,
    })
    expect(
      projectInlineAdapterResult(inlineProfile, { status: 'applied' } as never),
    ).toEqual({
      status: 'failed',
      failureCode: 'application_evidence_required',
      automaticContinuation: false,
    })
    expect(
      projectInlineAdapterResult(inlineProfile, { status: 'interaction_required' } as never),
    ).toEqual({
      status: 'failed',
      failureCode: 'interaction_reference_required',
      automaticContinuation: false,
    })
  })
})
