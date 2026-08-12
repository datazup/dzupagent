import { describe, expect, it } from 'vitest'

import {
  decodeMemoryBenchmarkProfileV1,
  digestMemoryBenchmarkProfileV1,
} from '../benchmark-profile-v1.js'
import { createMemoryConformanceSuiteV1 } from '../conformance-core-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

describe('MEM-P005 conformance core', () => {
  it('strictly decodes and source-binds a provider-free benchmark profile', () => {
    const profile = decodeMemoryBenchmarkProfileV1(benchmarkProfile())

    expect(profile.sourceDigest).toBe(`sha256:${'a'.repeat(64)}`)
    expect(profile.provider).toEqual({
      mode: 'none',
      deadlineMs: 250,
      retainsInput: false,
      allowQueryText: false,
      allowedInlineSensitivities: [],
    })
    expect(digestMemoryBenchmarkProfileV1(profile)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it('rejects unknown fields, provider retention, and threshold-limit drift', () => {
    expect(() => decodeMemoryBenchmarkProfileV1({
      ...benchmarkProfile(),
      unexpected: true,
    })).toThrow()
    expect(() => decodeMemoryBenchmarkProfileV1({
      ...benchmarkProfile(),
      provider: { ...benchmarkProfile().provider, retainsInput: true },
    })).toThrow()
    expect(() => decodeMemoryBenchmarkProfileV1({
      ...benchmarkProfile(),
      thresholds: { ...benchmarkProfile().thresholds, maxTokens: 20_001 },
    })).toThrow()
  })

  it('does not invoke accessors while rejecting hostile profiles', () => {
    let invoked = false
    const profile = benchmarkProfile() as unknown as Record<string, unknown>
    Object.defineProperty(profile, 'unexpected', {
      enumerable: true,
      get() {
        invoked = true
        return true
      },
    })

    expect(() => decodeMemoryBenchmarkProfileV1(profile)).toThrow()
    expect(invoked).toBe(false)
  })

  it('keeps expected-red distinct and makes reports byte-stable', async () => {
    const suite = createMemoryConformanceSuiteV1({
      suiteId: 'core-self-test',
      suiteVersion: 'v1',
      domain: 'record',
      fixtureSetId: 'invented-core-fixture',
      fixtureVersion: 'v1',
      profile: benchmarkProfile(),
      cases: [{
        id: 'core.expected-pass',
        capability: 'reporting',
        expected: 'pass',
        run: async () => ({ passed: true, reasonCode: 'completed' }),
      }, {
        id: 'core.named-expected-red',
        capability: 'expected-red-reporting',
        expected: 'red',
        run: async () => ({ passed: false, reasonCode: 'known-gap-retained' }),
      }],
    })

    const first = await suite.run()
    const second = await suite.run()

    expect(first.status).toBe('completed-with-expected-red')
    expect(first.counts).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      expectedRed: 1,
      unexpectedPass: 0,
    })
    expect(first.cases.find(entry => entry.expectation === 'red')?.status)
      .toBe('expected-red')
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('fails a metric below its predeclared threshold', async () => {
    const suite = createMemoryConformanceSuiteV1({
      suiteId: 'metric-self-test',
      suiteVersion: 'v1',
      domain: 'retrieval',
      fixtureSetId: 'invented-metric-fixture',
      fixtureVersion: 'v1',
      profile: benchmarkProfile(),
      cases: [{
        id: 'metric.precision',
        capability: 'threshold-enforcement',
        expected: 'pass',
        run: async () => ({
          passed: true,
          reasonCode: 'measurement-completed',
          metrics: [{
            name: 'precision-at-k',
            value: 0.5,
            unit: 'ratio',
            threshold: 1,
            comparison: 'at-least',
          }],
        }),
      }],
    })

    const report = await suite.run()
    expect(report.status).toBe('failed')
    expect(report.cases[0]?.metrics[0]).toMatchObject({ passed: false })
  })
})
