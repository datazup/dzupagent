import { describe, expect, it } from 'vitest'

import { createMemoryRetrievalConformanceSuite } from '../retrieval-conformance-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

describe('MEM-P005 retrieval conformance', () => {
  it('passes quality, temporal, security, provider, and deadline cases', async () => {
    const report = await createMemoryRetrievalConformanceSuite(benchmarkProfile()).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toEqual({
      total: 9,
      passed: 9,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
    expect(JSON.stringify(report)).not.toContain('INVENTED_CANARY_ALPHA_7F9D')
  })
})
