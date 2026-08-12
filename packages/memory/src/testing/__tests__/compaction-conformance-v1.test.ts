import { describe, expect, it } from 'vitest'

import { createMemoryCompactionConformanceSuite } from '../compaction-conformance-v1.js'
import { benchmarkProfile } from './profile-fixture.js'

const expected = {
  'complete-pairs': observation('complete-pairs', {
    statuses: ['completed'],
    reasons: ['compacted'],
    beforeTokens: 120,
    afterTokens: 40,
    reclaimedTokens: 80,
    compactedCount: 1,
  }),
  'incomplete-pairs': observation('incomplete-pairs', {
    statuses: ['unchanged'],
    reasons: ['no-eligible-results'],
  }),
  'malformed-pairs': observation('malformed-pairs', {
    statuses: ['rejected', 'rejected', 'rejected', 'rejected'],
    reasons: Array(4).fill('invalid-tool-pairing'),
  }),
  'metadata-and-canary': observation('metadata-and-canary', {
    statuses: ['completed'],
    reasons: ['compacted'],
    metadataPreserved: true,
    beforeTokens: 100,
    afterTokens: 20,
    reclaimedTokens: 80,
    compactedCount: 1,
  }),
  'measurement-provenance': observation('measurement-provenance', {
    statuses: ['completed', 'completed', 'rejected'],
    reasons: ['compacted', 'compacted', 'token-measurement-unproven'],
    measurementMethods: ['exact', 'heuristic', 'exact'],
    beforeTokens: 120,
    afterTokens: 40,
    reclaimedTokens: 80,
  }),
  idempotence: observation('idempotence', {
    statuses: ['completed', 'unchanged'],
    reasons: ['compacted', 'no-token-reclamation'],
    idempotent: true,
    beforeTokens: 120,
    afterTokens: 40,
    reclaimedTokens: 80,
  }),
  'bounded-target': observation('bounded-target', {
    statuses: ['partial'],
    reasons: ['target-not-met'],
    beforeTokens: 200,
    afterTokens: 120,
    reclaimedTokens: 80,
    compactedCount: 1,
  }),
  'hostile-input': observation('hostile-input', {
    statuses: ['rejected', 'rejected'],
    reasons: ['invalid-input', 'invalid-profile'],
  }),
} as const

describe('MEM-P005 compaction conformance contract', () => {
  it('produces a deterministic report from content-free host observations', async () => {
    const port = { run: async ({ scenario }: { scenario: keyof typeof expected }) => expected[scenario] }
    const first = await createMemoryCompactionConformanceSuite(benchmarkProfile(), port).run()
    const second = await createMemoryCompactionConformanceSuite(benchmarkProfile(), port).run()

    expect(first.status).toBe('passed')
    expect(first.counts).toMatchObject({ total: 8, passed: 8, failed: 0 })
    expect(second).toEqual(first)
  })
})

function observation(
  scenario: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema: 'datazup.memory.compaction-conformance-observation/v1',
    scenario,
    statuses: [],
    reasons: [],
    measurementMethods: [],
    inputUnchanged: true,
    structurePreserved: true,
    metadataPreserved: false,
    idempotent: false,
    canaryAbsent: true,
    beforeTokens: 0,
    afterTokens: 0,
    reclaimedTokens: 0,
    compactedCount: 0,
    ...overrides,
  }
}
