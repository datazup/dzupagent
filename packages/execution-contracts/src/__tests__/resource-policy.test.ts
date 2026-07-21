import { describe, expect, it } from 'vitest'

import {
  buildCommandCatalog,
  buildSignedExecutionPolicy,
  createDefaultResourcePolicy,
  createTemporalResourcePolicy,
  validateSignedExecutionPolicy,
  validateTemporallyValidSignedExecutionPolicy,
} from '../index.js'

const NOW_MS = Date.parse('2026-07-19T20:00:00.000Z')
const SKEW_MS = 30_000

function signedV2(issuedAt: string, expiresAt: string, wallTimeSec = 60) {
  return buildSignedExecutionPolicy(
    createTemporalResourcePolicy(
      { issuedAt, expiresAt },
      { policyId: 'execution-1', wallTimeSec },
    ),
    buildCommandCatalog([]),
  )
}

describe('resource policy v2 temporal validity', () => {
  it('accepts a signed policy within its deterministic trusted-clock window', () => {
    const signed = signedV2('2026-07-19T19:59:00.000Z', '2026-07-19T20:01:00.000Z')

    expect(
      validateTemporallyValidSignedExecutionPolicy(signed, {
        trustedNowMs: NOW_MS,
        clockSkewMs: SKEW_MS,
      }),
    ).toEqual({ valid: true, errors: [] })
  })

  it('keeps explicit v1 structural and integrity compatibility without granting temporal validity', () => {
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: 'legacy-v1' }),
      buildCommandCatalog([]),
    )

    expect(validateSignedExecutionPolicy(signed)).toEqual({ valid: true, errors: [] })
    expect(
      validateTemporallyValidSignedExecutionPolicy(signed, {
        trustedNowMs: NOW_MS,
        clockSkewMs: SKEW_MS,
      }),
    ).toMatchObject({
      valid: false,
      errors: ['temporal validation requires policy version "v2"'],
    })
  })

  it('rejects malformed, non-canonical, missing, and reversed temporal bounds', () => {
    const catalog = buildCommandCatalog([])
    const cases = [
      { issuedAt: 'invalid', expiresAt: '2026-07-19T20:01:00.000Z' },
      { issuedAt: '2026-07-19T20:00:00Z', expiresAt: '2026-07-19T20:01:00.000Z' },
      { issuedAt: '2026-07-19T20:00:00.000Z', expiresAt: '' },
      { issuedAt: '2026-07-19T20:00:00.000Z', expiresAt: '2026-07-19T20:00:00.000Z' },
      { issuedAt: '2026-07-19T20:01:00.000Z', expiresAt: '2026-07-19T20:00:00.000Z' },
    ]

    for (const temporal of cases) {
      const policy = createTemporalResourcePolicy(temporal, { policyId: 'execution-1' })
      const signed = buildSignedExecutionPolicy(policy, catalog)
      expect(validateSignedExecutionPolicy(signed).valid).toBe(false)
    }

    const missing = createTemporalResourcePolicy(
      { issuedAt: '2026-07-19T20:00:00.000Z', expiresAt: '2026-07-19T20:01:00.000Z' },
      { policyId: 'execution-1' },
    ) as unknown as Record<string, unknown>
    delete missing['issuedAt']
    const signedMissing = buildSignedExecutionPolicy(missing as never, catalog)
    expect(validateSignedExecutionPolicy(signedMissing).valid).toBe(false)
  })

  it('rejects not-yet-valid and expired policies, including the exclusive expiry boundary', () => {
    const notYetValid = signedV2('2026-07-19T20:00:30.001Z', '2026-07-19T20:02:00.000Z')
    const expiredAtBoundary = signedV2('2026-07-19T19:00:00.000Z', '2026-07-19T19:59:30.000Z')

    expect(
      validateTemporallyValidSignedExecutionPolicy(notYetValid, {
        trustedNowMs: NOW_MS,
        clockSkewMs: SKEW_MS,
      }).errors,
    ).toContain('policy is not yet valid')
    expect(
      validateTemporallyValidSignedExecutionPolicy(expiredAtBoundary, {
        trustedNowMs: NOW_MS,
        clockSkewMs: SKEW_MS,
      }).errors,
    ).toContain('policy is expired')
  })

  it('accepts both adjusted boundaries while still inside the expiry window', () => {
    const issuedAtBoundary = signedV2('2026-07-19T20:00:30.000Z', '2026-07-19T20:02:00.000Z')
    const expiresWithinSkew = signedV2('2026-07-19T19:00:00.000Z', '2026-07-19T19:59:30.001Z')

    for (const signed of [issuedAtBoundary, expiresWithinSkew]) {
      expect(
        validateTemporallyValidSignedExecutionPolicy(signed, {
          trustedNowMs: NOW_MS,
          clockSkewMs: SKEW_MS,
        }),
      ).toEqual({ valid: true, errors: [] })
    }
  })

  it('rejects missing or invalid trusted-clock inputs', () => {
    const signed = signedV2('2026-07-19T19:59:00.000Z', '2026-07-19T20:01:00.000Z')
    const cases = [
      { trustedNowMs: Number.NaN, clockSkewMs: SKEW_MS },
      { trustedNowMs: NOW_MS, clockSkewMs: -1 },
      { trustedNowMs: NOW_MS, clockSkewMs: Number.POSITIVE_INFINITY },
      undefined,
    ]

    for (const options of cases) {
      expect(validateTemporallyValidSignedExecutionPolicy(signed, options as never).valid).toBe(false)
    }
  })

  it('covers timestamps with the signature and never derives validity from wallTimeSec', () => {
    const signed = signedV2('2026-07-19T19:59:00.000Z', '2026-07-19T20:01:00.000Z', 1)
    const tampered = {
      ...signed,
      policy: { ...signed.policy, expiresAt: '2026-07-19T21:01:00.000Z' },
    }

    expect(validateSignedExecutionPolicy(tampered).errors).toContain(
      'signature does not match policy + catalog digest',
    )
    expect(
      validateTemporallyValidSignedExecutionPolicy(signed, {
        trustedNowMs: NOW_MS,
        clockSkewMs: SKEW_MS,
      }),
    ).toEqual({ valid: true, errors: [] })
  })
})
