import {
  createMemoryCompactionConformanceSuite,
  type MemoryBenchmarkProfileV1,
} from '@dzupagent/memory/testing'
import { describe, expect, it } from 'vitest'

import {
  MEMORY_COMPACTION_CONFORMANCE_CANARY,
  runContextCompactionConformanceScenario,
} from './memory-compaction-conformance-port.js'

const benchmarkProfile: MemoryBenchmarkProfileV1 = {
  schema: 'datazup.memory.benchmark-profile/v1',
  profileId: 'provider-free-context-conformance',
  profileVersion: 'v1',
  sourceDigest: `sha256:${'a'.repeat(64)}`,
  seed: 'invented-context-seed',
  tokenizer: { id: 'invented-exact', version: 'v1', measurement: 'exact' },
  provider: {
    mode: 'none',
    deadlineMs: 250,
    retainsInput: false,
    allowQueryText: false,
    allowedInlineSensitivities: [],
  },
  limits: {
    maxCases: 64,
    maxRecords: 256,
    maxResults: 32,
    maxTokens: 20_000,
    maxCostMicrousd: 0,
  },
  thresholds: {
    precisionAtK: 1,
    recallAtK: 1,
    mrr: 1,
    ndcg: 1,
    activeVersionAccuracy: 1,
    temporalAccuracy: 1,
    correctionAccuracy: 1,
    abstentionAccuracy: 1,
    groundedSelectionRate: 1,
    minimumReclaimedTokens: 1,
    maxLeakageRate: 0,
    maxStaleRetrievalRate: 0,
    maxRevokedRetrievalRate: 0,
    maxLatencyMs: 250,
    maxTokens: 20_000,
    maxCostMicrousd: 0,
  },
}

describe('context completed-tool implementation against memory conformance', () => {
  it('passes every transcript, provenance, bound, and hostile-input case', async () => {
    const report = await createMemoryCompactionConformanceSuite(
      benchmarkProfile,
      { run: runContextCompactionConformanceScenario },
    ).run()

    expect(report.status).toBe('passed')
    expect(report.counts).toMatchObject({ total: 8, passed: 8, failed: 0 })
    expect(JSON.stringify(report)).not.toContain(MEMORY_COMPACTION_CONFORMANCE_CANARY)
  })
})
