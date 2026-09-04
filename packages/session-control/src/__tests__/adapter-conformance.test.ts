import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  asSha256Digest,
  createSessionSnapshot,
  isAdapterCapabilityCallable,
  validateAdapterOperationResult,
  validateAdapterConformance,
  validateCapabilityManifest,
  type SessionControlAdapter,
  type SessionControlCapability,
  type SessionControlCapabilityDeclaration,
  type SessionControlCapabilityManifest,
  type NormalizedSessionEvent,
} from '../index.js'

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
  overrides: Partial<Record<SessionControlCapability, SessionControlCapabilityDeclaration>> = {},
): SessionControlCapabilityManifest {
  return {
    schema: SESSION_CONTROL_SCHEMAS.capabilityManifest,
    manifestRef: asOpaqueReference('manifest_7Gf3kP2x'),
    adapterRef: asOpaqueReference('adapter_8Hk4mQ3y'),
    providerKey: 'provider-neutral-a',
    observedAt: '2026-09-04T20:00:00.000Z',
    capabilities: Object.fromEntries(
      SESSION_CONTROL_CAPABILITIES.map((capability) => [
        capability,
        overrides[capability] ?? unsupported(),
      ]),
    ) as Record<SessionControlCapability, SessionControlCapabilityDeclaration>,
  }
}

describe('adapter capability conformance', () => {
  it('requires an exact method for every callable declaration', () => {
    const declared = manifest({
      send_message: {
        support: 'native',
        qualification: 'qualified',
        availability: 'available',
        emulation: 'forbidden',
        evidenceRefs: [asOpaqueReference('evidence_9Jm5nR4z')],
      },
    })
    const adapter: SessionControlAdapter = { manifest: declared }

    expect(validateAdapterConformance(adapter)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'declared_method_missing',
          capability: 'send_message',
          method: 'sendMessage',
        }),
      ],
    })
  })

  it('passes when callable declarations have their methods', () => {
    const declared = manifest({
      send_message: {
        support: 'native',
        qualification: 'qualified',
        availability: 'available',
        emulation: 'forbidden',
        evidenceRefs: [asOpaqueReference('evidence_9Jm5nR4z')],
      },
    })
    const adapter: SessionControlAdapter = {
      manifest: declared,
      sendMessage: vi.fn(),
    }

    expect(validateAdapterConformance(adapter)).toEqual({ ok: true, value: adapter })
    expect(isAdapterCapabilityCallable(adapter, 'send_message')).toBe(true)
  })

  it('does not require a method while a qualified capability is unavailable', () => {
    const adapter: SessionControlAdapter = {
      manifest: manifest({
        send_message: {
          support: 'native',
          qualification: 'qualified',
          availability: 'temporarily_unavailable',
          emulation: 'forbidden',
          reason: 'runtime_offline',
          evidenceRefs: [asOpaqueReference('evidence_9Jm5nR4z')],
        },
      }),
    }

    expect(validateAdapterConformance(adapter)).toEqual({ ok: true, value: adapter })
    expect(isAdapterCapabilityCallable(adapter, 'send_message')).toBe(false)
  })

  it('does not infer support from an extra adapter method', () => {
    const adapter: SessionControlAdapter = {
      manifest: manifest(),
      pause: vi.fn(),
    }

    expect(validateAdapterConformance(adapter)).toEqual({ ok: true, value: adapter })
    expect(isAdapterCapabilityCallable(adapter, 'pause')).toBe(false)
  })

  it('requires an exact declaration for every version-1 capability', () => {
    const input = manifest() as unknown as Record<string, unknown>
    const capabilities = { ...(input.capabilities as Record<string, unknown>) }
    delete capabilities.fork
    input.capabilities = capabilities

    expect(validateCapabilityManifest(input)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'capabilities.fork', code: 'capability_missing' }),
      ]),
    })
  })

  it('rejects raw or credential-shaped manifest extensions', () => {
    expect(
      validateCapabilityManifest({
        ...manifest(),
        credential: { token: 'must-not-cross-boundary' },
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'credential', code: 'unexpected_field' }),
      ]),
    })
  })

  it('validates capability-specific start and read results with canonical data', () => {
    const created = createSessionSnapshot({
      sessionRef: asOpaqueReference('session_7Gf3kP2x'),
      profile: {
        schema: SESSION_CONTROL_SCHEMAS.executionProfile,
        executionStyle: 'durable',
        continuity: 'control_plane_managed',
        coordination: 'none',
      },
      origin: 'managed',
      status: 'idle',
      recordedAt: '2026-09-04T20:00:00.000Z',
    })
    if (!created.ok) throw new Error(created.issue.code)
    const event: NormalizedSessionEvent = {
      schema: SESSION_CONTROL_SCHEMAS.sessionEvent,
      eventId: asOpaqueReference('event_8Hk4mQ3y'),
      eventDigest: asSha256Digest(`sha256:${'a'.repeat(64)}`),
      sessionRef: created.snapshot.sessionRef,
      sequence: 1,
      occurredAt: '2026-09-04T20:00:01.000Z',
      recordedAt: '2026-09-04T20:00:01.000Z',
      source: 'provider_adapter',
      type: 'turn.started',
      payload: { turnRef: 'turn_9Jm5nR4z' },
    }
    const validateFor = validateAdapterOperationResult as unknown as (
      value: unknown,
      capability: SessionControlCapability,
    ) => ReturnType<typeof validateAdapterOperationResult>
    const evidence = {
      kind: 'provider_event' as const,
      ref: asOpaqueReference('evidence_3Ca9gH5t'),
    }

    expect(
      validateFor(
        { status: 'applied', sessionRef: created.snapshot.sessionRef, evidence },
        'start',
      ),
    ).toMatchObject({ ok: true, value: { sessionRef: created.snapshot.sessionRef } })
    expect(
      validateFor({ status: 'applied', snapshot: created.snapshot, evidence }, 'observe'),
    ).toMatchObject({ ok: true, value: { snapshot: created.snapshot } })
    expect(
      validateFor(
        { status: 'applied', events: [event], nextSequence: 2, evidence },
        'tail_events',
      ),
    ).toMatchObject({ ok: true, value: { events: [event], nextSequence: 2 } })
    expect(
      validateFor(
        { status: 'applied', snapshot: created.snapshot, evidence },
        'lookup_after_restart',
      ),
    ).toMatchObject({ ok: true, value: { snapshot: created.snapshot } })
  })
})
