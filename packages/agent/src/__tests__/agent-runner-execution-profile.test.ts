import { describe, expect, it, vi } from 'vitest'

import {
  buildRunnerProviderFreeExecutionProfile,
  evaluateRunnerProviderFreeExecutionProfile,
  type LegacyRunnerExecutionProfile,
} from './support/legacy-runner-execution-profile.js'

const behaviorDigest = 'sha256:r5k-runner-provider-free-behavior'

function profile(): LegacyRunnerExecutionProfile {
  return buildRunnerProviderFreeExecutionProfile({
    behaviorDigest,
    maxModelTurns: 4,
    maxToolAttempts: 2,
    observedMessageCount: 3,
    observedMessageTokens: 128,
    structuredOutputRequested: true,
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('AgentRunner R5K execution capability profile', () => {
  it('admits only the narrow direct provider-free runner profile', () => {
    const candidate = profile()
    expect(evaluateRunnerProviderFreeExecutionProfile(candidate, behaviorDigest)).toEqual({
      status: 'eligible',
      profileId: 'runner-provider-free/v1',
      profileDigest: candidate.profileDigest,
    })
    expect(candidate.claims.find((claim) => claim.obligation === 'legacy-result-projection'))
      .toMatchObject({
        disposition: 'disabled',
        owner: 'host',
        binding: { entrypoint: 'runner-direct-only' },
      })
  })

  it('admits the separately named R5M projection without reinterpreting direct-runner profiles', () => {
    const candidate = buildRunnerProviderFreeExecutionProfile({
      behaviorDigest,
      maxModelTurns: 4,
      maxToolAttempts: 2,
      observedMessageCount: 3,
      observedMessageTokens: 128,
      structuredOutputRequested: false,
      legacyResultProjection: 'no-tool-generate-result/v1',
    })
    expect(evaluateRunnerProviderFreeExecutionProfile(candidate, behaviorDigest)).toEqual({
      status: 'eligible',
      profileId: 'runner-provider-free/v1',
      profileDigest: candidate.profileDigest,
    })
    expect(candidate.claims.find((claim) => claim.obligation === 'legacy-result-projection'))
      .toMatchObject({
        disposition: 'supported',
        owner: 'host',
        evidence: ['r5m-no-tool-generate-result'],
        binding: {
          entrypoint: 'not-delegated',
          projection: 'no-tool-generate-result/v1',
        },
      })
    expect(profile().claims.find((claim) => claim.obligation === 'legacy-result-projection'))
      .toMatchObject({ disposition: 'disabled', evidence: ['runner-direct-only'] })
  })

  it.each(profile().claims.filter((claim) => claim.disposition === 'disabled').map(
    (claim) => claim.obligation,
  ))('rejects independently enabled unresolved obligation %s', (obligation) => {
    const candidate = clone(profile())
    const claim = candidate.claims.find((entry) => entry.obligation === obligation)
    if (claim === undefined) throw new Error(`Missing test claim ${obligation}`)
    ;(claim as { disposition: string }).disposition = 'required'

    expect(evaluateRunnerProviderFreeExecutionProfile(candidate, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([
        { code: 'claim-disposition-mismatch', obligation },
      ]),
    })
  })

  it('fails closed for omitted, duplicated, unknown, and unsupported claims', () => {
    const omitted = clone(profile())
    ;(omitted as unknown as { claims: unknown[] }).claims = omitted.claims.slice(1)
    expect(evaluateRunnerProviderFreeExecutionProfile(omitted, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{ code: 'claim-missing', obligation: 'ordered-items' }]),
    })

    const duplicate = clone(profile())
    ;(duplicate as unknown as { claims: unknown[] }).claims.push(clone(duplicate.claims[0]))
    expect(evaluateRunnerProviderFreeExecutionProfile(duplicate, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{ code: 'claim-duplicate', obligation: 'ordered-items' }]),
    })

    const unknown = clone(profile())
    ;(unknown as unknown as { claims: unknown[] }).claims.push({
      obligation: 'future-unreviewed-capability',
      disposition: 'supported',
      owner: 'runner',
      evidence: ['invented'],
      binding: {},
    })
    expect(evaluateRunnerProviderFreeExecutionProfile(unknown, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{
        code: 'claim-unknown', obligation: 'future-unreviewed-capability',
      }]),
    })

    const unsupported = clone(profile())
    const supportedClaim = unsupported.claims.find((claim) => claim.obligation === 'ordered-items')
    if (supportedClaim === undefined) throw new Error('Missing ordered-items claim')
    ;(supportedClaim as { disposition: string }).disposition = 'unsupported'
    expect(evaluateRunnerProviderFreeExecutionProfile(unsupported, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{
        code: 'claim-disposition-mismatch', obligation: 'ordered-items',
      }]),
    })

    const malformed = clone(profile())
    ;(malformed as unknown as { claims: unknown[] }).claims[0] = null
    expect(evaluateRunnerProviderFreeExecutionProfile(malformed, behaviorDigest)).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{ code: 'claim-malformed' }]),
    })
  })

  it('invalidates stale eligibility after behavior or configuration drift', () => {
    const behaviorDrift = evaluateRunnerProviderFreeExecutionProfile(
      profile(),
      'sha256:r5k-changed-behavior',
    )
    expect(behaviorDrift).toMatchObject({
      status: 'ineligible',
      reasons: expect.arrayContaining([{ code: 'behavior-digest-mismatch' }]),
    })

    const configurationDrift = clone(profile())
    const turns = configurationDrift.claims.find(
      (claim) => claim.obligation === 'bounded-model-turns',
    )
    if (turns === undefined) throw new Error('Missing bounded-model-turns claim')
    ;(turns.binding as { maxModelTurns: number }).maxModelTurns = 5
    expect(evaluateRunnerProviderFreeExecutionProfile(configurationDrift, behaviorDigest))
      .toMatchObject({
        status: 'ineligible',
        reasons: expect.arrayContaining([{ code: 'profile-digest-mismatch' }]),
      })
  })

  it('rejects unbounded compression inputs instead of manufacturing disablement', () => {
    expect(() => buildRunnerProviderFreeExecutionProfile({
      behaviorDigest,
      maxModelTurns: 4,
      maxToolAttempts: 2,
      observedMessageCount: 30,
      observedMessageTokens: 128,
      structuredOutputRequested: false,
    })).toThrow('Runner provider-free profile input is invalid')
    expect(() => buildRunnerProviderFreeExecutionProfile({
      behaviorDigest,
      maxModelTurns: 4,
      maxToolAttempts: 2,
      observedMessageCount: 3,
      observedMessageTokens: 12_000,
      structuredOutputRequested: false,
    })).toThrow('Runner provider-free profile input is invalid')
  })

  it('reconstructs from JSON with the same identity and decision', () => {
    const candidate = profile()
    const reconstructed = clone(candidate)
    expect(reconstructed).toEqual(candidate)
    expect(evaluateRunnerProviderFreeExecutionProfile(reconstructed, behaviorDigest)).toEqual({
      status: 'eligible',
      profileId: 'runner-provider-free/v1',
      profileDigest: candidate.profileDigest,
    })
  })

  it('does not invoke execution, provider, memory, middleware, or host mutation callbacks', () => {
    const legacy = vi.fn()
    const runner = vi.fn()
    const provider = vi.fn()
    const memory = vi.fn()
    const middleware = vi.fn()
    const hostMutation = vi.fn()
    const candidate = { ...profile(), callback: provider }

    expect(evaluateRunnerProviderFreeExecutionProfile(candidate, behaviorDigest)).toEqual({
      status: 'ineligible',
      reasons: [{ code: 'profile-not-json-safe' }],
    })
    expect([legacy, runner, provider, memory, middleware, hostMutation])
      .toSatisfy((callbacks: ReturnType<typeof vi.fn>[]) => callbacks.every(
        (callback) => callback.mock.calls.length === 0,
      ))
  })

  it('rejects credential and unrestricted-path fields without retaining their values', () => {
    expect(evaluateRunnerProviderFreeExecutionProfile({
      ...profile(),
      credential: 'not-retained',
    }, behaviorDigest)).toEqual({
      status: 'ineligible',
      reasons: [{ code: 'profile-forbidden-field' }],
    })
    expect(evaluateRunnerProviderFreeExecutionProfile({
      ...profile(),
      hostPath: '/not/retained',
    }, behaviorDigest)).toEqual({
      status: 'ineligible',
      reasons: [{ code: 'profile-forbidden-field' }],
    })
  })
})
