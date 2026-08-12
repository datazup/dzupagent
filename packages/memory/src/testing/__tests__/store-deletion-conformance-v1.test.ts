import { describe, expect, it } from 'vitest'

import { createMemoryDeletionConformanceSuite } from '../deletion-conformance-v1.js'
import { createMemoryStoreConformanceSuite } from '../store-conformance-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

describe('MEM-P005 store and deletion conformance', () => {
  it('passes scope, CAS, restart, capability, and rollover cases', async () => {
    const report = await createMemoryStoreConformanceSuite(benchmarkProfile()).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toEqual({
      total: 8,
      passed: 8,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
  })

  it('passes revoke, invalidation, purge, and legal-hold cases', async () => {
    const report = await createMemoryDeletionConformanceSuite(benchmarkProfile()).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toEqual({
      total: 4,
      passed: 4,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
  })
})
