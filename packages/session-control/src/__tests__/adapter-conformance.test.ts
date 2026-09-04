import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_SCHEMAS,
  asOpaqueReference,
  isAdapterCapabilityCallable,
  validateAdapterConformance,
  validateCapabilityManifest,
  type SessionControlAdapter,
  type SessionControlCapability,
  type SessionControlCapabilityDeclaration,
  type SessionControlCapabilityManifest,
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
})
