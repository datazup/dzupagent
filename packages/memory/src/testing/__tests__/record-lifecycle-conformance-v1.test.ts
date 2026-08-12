import { describe, expect, it } from 'vitest'

import { createMemoryLifecycleConformanceSuite } from '../lifecycle-conformance-v1.js'
import { createMemoryRecordConformanceSuite } from '../record-conformance-v1.js'
import { MEMORY_CONFORMANCE_CANARY } from '../fixtures-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

describe('MEM-P005 record and lifecycle conformance', () => {
  it('passes every canonical record case without leaking fixture content', async () => {
    const report = await createMemoryRecordConformanceSuite(benchmarkProfile()).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toEqual({
      total: 5,
      passed: 5,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
    expect(JSON.stringify(report)).not.toContain(MEMORY_CONFORMANCE_CANARY)
  })

  it('passes lifecycle replay, branch, revoke, purge, and ordering cases', async () => {
    const report = await createMemoryLifecycleConformanceSuite(benchmarkProfile()).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toEqual({
      total: 8,
      passed: 8,
      failed: 0,
      expectedRed: 0,
      unexpectedPass: 0,
    })
    expect(report.cases.map(entry => entry.caseId)).toEqual([
      'lifecycle.archive-preserves-custody',
      'lifecycle.bounded-generated-sequences',
      'lifecycle.conflicting-replay-rejected',
      'lifecycle.correction-preserves-branches',
      'lifecycle.legal-sequence-and-replay',
      'lifecycle.purge-remains-proposal',
      'lifecycle.reorder-gap-and-time-reversal',
      'lifecycle.revoke-excludes-immediately',
    ])
  })
})
