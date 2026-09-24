/**
 * MVP-04-CP07 acceptance: usage is bound to the attempt, uncertainty is
 * explicit, cost disagreement is recorded rather than resolved, and a total
 * over attempts collapses duplicate reports without hiding conflicts.
 *
 * Admission: workspace-docs doc-coord-mvp04-cp07-admit-20260924-r1/ADMISSION.md §5.
 */
import { describe, expect, it } from 'vitest'

import { coordinationCanonicalDigest, coordinationSelfDigest } from '../integration/coordination-assignment-decoder.js'
import {
  COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
  type CoordinationAttemptCorrelation,
} from '../integration/coordination-attempt-runner.js'
import {
  COORDINATION_ATTEMPT_USAGE_SCHEMA,
  recordCoordinationAttemptUsage,
  totalCoordinationAttemptUsage,
  type CoordinationAttemptUsageRecord,
  type CoordinationUsagePricer,
} from '../integration/coordination-attempt-usage.js'

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}` as const

function correlation(attemptId = 'attempt-1'): CoordinationAttemptCorrelation {
  return {
    schema: COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
    planDigest: digest(1),
    requestDigest: digest(2),
    assignmentDigest: digest(3),
    canonicalSeal: digest(4),
    assignmentId: 'assignment-1',
    attemptId,
    sessionId: 'session-1',
    bindingId: 'binding-1',
    sessionRef: 'session-ref-1',
    providerId: 'claude',
    backend: 'sdk',
    agentHost: null,
    tariffRef: 'tariff-sentinel-cp07',
  }
}

const USAGE = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 80 }

describe('A2. bound record', () => {
  it('takes identity from the correlation and verifies its own digest', () => {
    const record = recordCoordinationAttemptUsage(correlation(), USAGE)
    expect(record).toMatchObject({
      schema: COORDINATION_ATTEMPT_USAGE_SCHEMA,
      attemptId: 'attempt-1',
      assignmentId: 'assignment-1',
      bindingId: 'binding-1',
      providerId: 'claude',
      tariffRef: 'tariff-sentinel-cp07',
      correlationDigest: coordinationCanonicalDigest(correlation()),
      status: 'reported',
      tokens: USAGE,
      reasons: [],
    })
    expect(record.recordDigest).toBe(coordinationSelfDigest(record as unknown as Record<string, unknown>, 'recordDigest'))
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('gives a different record digest for a different attempt with the same usage', () => {
    const a = recordCoordinationAttemptUsage(correlation('attempt-1'), USAGE)
    const b = recordCoordinationAttemptUsage(correlation('attempt-2'), USAGE)
    expect(a.recordDigest).not.toBe(b.recordDigest)
  })
})

describe('A3. unknown is not zero', () => {
  it('records absent usage as unknown with no numeric field', () => {
    const record = recordCoordinationAttemptUsage(correlation(), undefined)
    expect(record.status).toBe('unknown')
    expect(record.reasons).toEqual(['USAGE_NOT_REPORTED'])
    expect(record).not.toHaveProperty('tokens')
    expect(record).not.toHaveProperty('providerReportedCostCents')
    expect(record).not.toHaveProperty('tariffCostCents')
  })

  it('does not price absent usage', () => {
    let calls = 0
    recordCoordinationAttemptUsage(correlation(), undefined, { priceUsage: () => { calls += 1; return 1 } })
    expect(calls).toBe(0)
  })
})

describe('A4. invalid values', () => {
  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses a %s token count without coercing it', (_label, bad) => {
    const record = recordCoordinationAttemptUsage(correlation(), { inputTokens: bad, outputTokens: 3 })
    expect(record.status).toBe('uncertain')
    expect(record.reasons).toEqual(['USAGE_VALUE_INVALID'])
    expect(record).not.toHaveProperty('tokens')
  })

  it('refuses an invalid optional count as well', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { inputTokens: 1, outputTokens: 1, cacheWriteTokens: -4 })
    expect(record.reasons).toEqual(['USAGE_VALUE_INVALID'])
    expect(record).not.toHaveProperty('tokens')
  })

  it('drops a negative provider cost and keeps valid tokens', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { ...USAGE, costCents: -2 })
    expect(record.status).toBe('uncertain')
    expect(record.reasons).toEqual(['USAGE_COST_INVALID'])
    expect(record).not.toHaveProperty('providerReportedCostCents')
    expect(record.tokens).toEqual(USAGE)
  })

  it('keeps a fractional provider cost as a claim', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { ...USAGE, costCents: 0.37 })
    expect(record.status).toBe('reported')
    expect(record.providerReportedCostCents).toBe(0.37)
  })
})

describe('A5. cost disagreement', () => {
  const pricing = (cents: number | undefined): CoordinationUsagePricer => () => cents

  it('records both figures and chooses neither when they differ', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { ...USAGE, costCents: 9 }, { priceUsage: pricing(4) })
    expect(record.status).toBe('uncertain')
    expect(record.reasons).toEqual(['USAGE_COST_DISAGREES'])
    expect(record.providerReportedCostCents).toBe(9)
    expect(record.tariffCostCents).toBe(4)
  })

  it('is reported when the figures agree', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { ...USAGE, costCents: 4 }, { priceUsage: pricing(4) })
    expect(record.status).toBe('reported')
    expect(record.reasons).toEqual([])
  })

  it('prices under the bound tariff and provider with the validated tokens', () => {
    const seen: unknown[] = []
    recordCoordinationAttemptUsage(correlation(), USAGE, { priceUsage: (input) => { seen.push(input); return 1 } })
    expect(seen).toEqual([{ tariffRef: 'tariff-sentinel-cp07', providerId: 'claude', tokens: USAGE }])
  })

  it('does not keep a throwing pricer message', () => {
    const record = recordCoordinationAttemptUsage(correlation(), USAGE, {
      priceUsage: () => { throw new Error('tariff-db-password=hunter2') },
    })
    expect(record.status).toBe('uncertain')
    expect(record.reasons).toEqual(['USAGE_TARIFF_PRICE_INVALID'])
    expect(JSON.stringify(record)).not.toContain('hunter2')
  })

  it('treats a non-finite price as invalid', () => {
    const record = recordCoordinationAttemptUsage(correlation(), USAGE, { priceUsage: pricing(Number.POSITIVE_INFINITY) })
    expect(record.reasons).toEqual(['USAGE_TARIFF_PRICE_INVALID'])
    expect(record).not.toHaveProperty('tariffCostCents')
  })

  it('records no tariff cost when the tariff cannot price', () => {
    const record = recordCoordinationAttemptUsage(correlation(), { ...USAGE, costCents: 9 }, { priceUsage: pricing(undefined) })
    expect(record.status).toBe('reported')
    expect(record).not.toHaveProperty('tariffCostCents')
  })
})

describe('A6. duplicate cumulative usage', () => {
  const reported = (attemptId: string, usage = USAGE) => recordCoordinationAttemptUsage(correlation(attemptId), usage)

  it('counts the same record reported twice once', () => {
    const record = reported('attempt-1')
    const total = totalCoordinationAttemptUsage([record, record, reported('attempt-2')])
    expect(total).toMatchObject({
      status: 'complete',
      attempts: 2,
      duplicatesCollapsed: 1,
      knownTokens: { inputTokens: 240, outputTokens: 60, cachedInputTokens: 160, cacheWriteTokens: 0 },
      incompleteAttempts: [],
      conflictingAttempts: [],
      reasons: [],
    })
  })

  it('excludes an attempt reported with two different records', () => {
    const total = totalCoordinationAttemptUsage([
      reported('attempt-1'),
      reported('attempt-1', { inputTokens: 500, outputTokens: 60 }),
      reported('attempt-2'),
    ])
    expect(total.status).toBe('uncertain')
    expect(total.conflictingAttempts).toEqual(['attempt-1'])
    expect(total.reasons).toEqual(['USAGE_DUPLICATE_DISAGREES'])
    expect(total.knownTokens.inputTokens).toBe(120)
  })

  it('never presents a set with an unknown attempt as complete', () => {
    const total = totalCoordinationAttemptUsage([
      reported('attempt-1'),
      recordCoordinationAttemptUsage(correlation('attempt-2'), undefined),
    ])
    expect(total.status).toBe('uncertain')
    expect(total.incompleteAttempts).toEqual(['attempt-2'])
    expect(total.reasons).toEqual(['USAGE_NOT_REPORTED'])
    expect(total.knownTokens.inputTokens).toBe(120)
  })

  it('refuses a tampered record', () => {
    const tampered = { ...reported('attempt-1'), tokens: { inputTokens: 1, outputTokens: 1 } } as CoordinationAttemptUsageRecord
    const total = totalCoordinationAttemptUsage([tampered])
    expect(total.status).toBe('uncertain')
    expect(total.reasons).toEqual(['USAGE_RECORD_INVALID'])
    expect(total.attempts).toBe(0)
  })

  it('marks a sum beyond the safe-integer range as uncertain', () => {
    const big = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }
    const total = totalCoordinationAttemptUsage([reported('attempt-1', big), reported('attempt-2', big)])
    expect(total.status).toBe('uncertain')
    expect(total.reasons).toEqual(['USAGE_TOTAL_OVERFLOW'])
  })

  it('totals an empty set as complete and zero', () => {
    expect(totalCoordinationAttemptUsage([])).toMatchObject({ status: 'complete', attempts: 0, knownTokens: { inputTokens: 0 } })
  })
})
