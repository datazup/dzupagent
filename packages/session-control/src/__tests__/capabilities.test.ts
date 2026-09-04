import { describe, expect, it } from 'vitest'
import {
  asOpaqueReference,
  evaluateCapabilityDeclaration,
  validateCapabilityDeclaration,
  type SessionControlCapabilityDeclaration,
} from '../index.js'

function declaration(
  overrides: Partial<SessionControlCapabilityDeclaration> = {},
): SessionControlCapabilityDeclaration {
  return {
    support: 'native',
    qualification: 'qualified',
    availability: 'available',
    emulation: 'forbidden',
    evidenceRefs: [asOpaqueReference('evidence_7Gf3kP2x')],
    ...overrides,
  }
}

describe('capability truth', () => {
  it('calls only native, qualified, currently available capabilities', () => {
    expect(evaluateCapabilityDeclaration(declaration())).toEqual({
      callable: true,
      status: 'available',
    })
    expect(
      evaluateCapabilityDeclaration(
        declaration({
          qualification: 'unqualified',
          reason: 'qualification_pending',
          evidenceRefs: undefined,
        }),
      ),
    ).toEqual({ callable: false, status: 'unqualified' })
    expect(
      evaluateCapabilityDeclaration(
        declaration({ availability: 'temporarily_unavailable', reason: 'runtime_offline' }),
      ),
    ).toEqual({ callable: false, status: 'temporarily_unavailable' })
    expect(
      evaluateCapabilityDeclaration(
        declaration({
          support: 'unsupported',
          qualification: 'unqualified',
          reason: 'native_control_absent',
          evidenceRefs: undefined,
        }),
      ),
    ).toEqual({ callable: false, status: 'unsupported' })
  })

  it('requires evidence for qualified declarations', () => {
    expect(validateCapabilityDeclaration(declaration({ evidenceRefs: undefined }))).toMatchObject({
      ok: false,
      issues: [{ code: 'qualification_evidence_required' }],
    })
  })

  it('requires a safe reason for unsupported, unqualified, or unavailable states', () => {
    expect(
      validateCapabilityDeclaration(
        declaration({ qualification: 'unqualified', evidenceRefs: undefined }),
      ),
    ).toMatchObject({ ok: false })
    expect(
      validateCapabilityDeclaration(
        declaration({ availability: 'temporarily_unavailable', reason: undefined }),
      ),
    ).toMatchObject({ ok: false })
    expect(
      validateCapabilityDeclaration(
        declaration({ support: 'unsupported', qualification: 'unqualified', evidenceRefs: undefined }),
      ),
    ).toMatchObject({ ok: false })
  })

  it('rejects qualified unsupported capability claims', () => {
    expect(
      validateCapabilityDeclaration(
        declaration({ support: 'unsupported', reason: 'native_control_absent' }),
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported_cannot_be_qualified' }),
      ]),
    })
  })

  it('forbids declaring an emulation path', () => {
    expect(
      validateCapabilityDeclaration({
        ...declaration(),
        emulation: 'terminal_injection' as never,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'emulation_forbidden' })]),
    })
  })
})
