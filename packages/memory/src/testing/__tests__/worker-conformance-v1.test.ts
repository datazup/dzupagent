import { describe, expect, it } from 'vitest'

import { createMemoryWorkerConformanceSuite } from '../worker-conformance-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

describe('memory worker conformance v1', () => {
  it('passes the provider-free reliable-delivery contract deterministically', async () => {
    const profile = benchmarkProfile()
    const first = await createMemoryWorkerConformanceSuite(profile).run()
    const second = await createMemoryWorkerConformanceSuite(profile).run()

    expect(first).toEqual(second)
    expect(first.harnessVersion).toBe('mem-p006-v1')
    expect(first.domain).toBe('worker')
    expect(first.status).toBe('passed')
    expect(first.counts).toEqual({
      total: 15,
      passed: 15,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
  })
})
