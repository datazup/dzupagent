import type { MemoryBenchmarkProfileV1 } from '../benchmark-profile-v1.js'

export function benchmarkProfile(
  overrides: Partial<MemoryBenchmarkProfileV1> = {},
): MemoryBenchmarkProfileV1 {
  return {
    schema: 'datazup.memory.benchmark-profile/v1',
    profileId: 'provider-free-conformance',
    profileVersion: 'v1',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    seed: 'invented-seed-001',
    tokenizer: {
      id: 'invented-exact-counter',
      version: 'v1',
      measurement: 'exact',
    },
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
    ...overrides,
  }
}
