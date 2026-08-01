import { describe, expect, it } from 'vitest'
import {
  AdapterHardBudgetHostProfileRegistry,
  AdapterHardBudgetProfileError,
  assertAdapterHardBudgetBinding,
  assertAdapterHardBudgetRequestProofBinding,
  defineAdapterHardBudgetHostProfile,
} from '../hard-budget.js'
import {
  FIXTURE_MODEL,
  fixtureBinding,
  fixtureProofProfile,
  fixtureProfile,
} from './hard-budget-test-fixtures.js'

describe('AdapterHardBudgetHostProfileRegistry', () => {
  it('freezes definitions and resolves exact provider/model identities', () => {
    const profile = defineAdapterHardBudgetHostProfile(fixtureProfile())
    const registry = new AdapterHardBudgetHostProfileRegistry([profile])

    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.tokenizer.allowedMethods)).toBe(true)
    expect(registry.resolve('openai', FIXTURE_MODEL)).toStrictEqual(profile)
    expect(registry.resolve('openai', FIXTURE_MODEL.toUpperCase())).toStrictEqual(
      profile,
    )
    expect(Object.isFrozen(registry.resolve('openai', FIXTURE_MODEL))).toBe(true)
    expect(registry.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces the same fingerprint independent of registration order', () => {
    const second = fixtureProfile({
      id: 'second',
      model: 'second-model',
    })
    const firstRegistry = new AdapterHardBudgetHostProfileRegistry([
      fixtureProfile(),
      second,
    ])
    const secondRegistry = new AdapterHardBudgetHostProfileRegistry([
      second,
      fixtureProfile(),
    ])

    expect(firstRegistry.fingerprint).toBe(secondRegistry.fingerprint)
  })

  it('rejects duplicates and unknown models fail closed', () => {
    expect(() => new AdapterHardBudgetHostProfileRegistry([
      fixtureProfile(),
      fixtureProfile({ id: 'duplicate-id' }),
    ])).toThrowError(expect.objectContaining({ code: 'duplicate_profile' }))

    const registry = new AdapterHardBudgetHostProfileRegistry([])
    expect(() => registry.resolveRequired('openai', 'unknown')).toThrowError(
      expect.objectContaining({ code: 'profile_not_found' }),
    )
  })

  it('rejects stale tokenizer and request-format bindings', () => {
    const profile = defineAdapterHardBudgetHostProfile(fixtureProfile())

    expect(() => assertAdapterHardBudgetBinding(profile, fixtureBinding({
      tokenizerRevision: 'stale',
    }))).toThrowError(expect.objectContaining({
      code: 'tokenizer_binding_mismatch',
    }))
    expect(() => assertAdapterHardBudgetBinding(profile, fixtureBinding({
      requestFormatRevision: 'stale',
    }))).toThrowError(expect.objectContaining({
      code: 'request_format_binding_mismatch',
    }))
  })

  it('rejects invalid reservation and provenance declarations', () => {
    expect(() => defineAdapterHardBudgetHostProfile(fixtureProfile({
      contextWindowTokens: 100,
      reservedOutputTokens: 100,
    }))).toThrow(AdapterHardBudgetProfileError)
    expect(() => defineAdapterHardBudgetHostProfile(fixtureProfile({
      tokenizer: {
        id: 'character-tokenizer',
        revision: '1',
        allowedMethods: [],
      },
    }))).toThrowError(expect.objectContaining({ code: 'invalid_profile' }))
  })

  it('binds hosted proof identity and request-format fingerprints', () => {
    const profile = defineAdapterHardBudgetHostProfile(fixtureProofProfile())
    const binding = {
      id: profile.requestProof!.id,
      revision: profile.requestProof!.revision,
      requestFormatId: profile.requestFormat.id,
      requestFormatRevision: profile.requestFormat.revision,
      requestFormatFingerprint: profile.requestFormat.fingerprint!,
      proveRequest: async () => ({
        tokens: 1,
        method: 'exact' as const,
        model: profile.model,
        requestFingerprint: 'a'.repeat(64),
        requestFormatFingerprint: profile.requestFormat.fingerprint!,
        measuredAt: '2026-08-01T00:00:00.000Z',
      }),
    }

    expect(() => assertAdapterHardBudgetRequestProofBinding(profile, binding))
      .not.toThrow()
    expect(() => assertAdapterHardBudgetRequestProofBinding(profile, {
      ...binding,
      requestFormatFingerprint: 'b'.repeat(64),
    })).toThrowError(expect.objectContaining({
      code: 'request_format_fingerprint_mismatch',
    }))
  })

  it('requires snapshot and serializer provenance for hosted proof', () => {
    expect(() => defineAdapterHardBudgetHostProfile(fixtureProfile({
      requestProof: fixtureProofProfile().requestProof,
    }))).toThrowError(expect.objectContaining({ code: 'invalid_profile' }))
  })
})
