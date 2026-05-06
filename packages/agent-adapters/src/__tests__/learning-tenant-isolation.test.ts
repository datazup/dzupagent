/**
 * MC-AGT-01: Tenant isolation in AdapterLearningLoop.
 *
 * Verifies that profile and routing decisions for a given tenant are not
 * contaminated by execution records from other tenants, that the global
 * profile correctly aggregates across tenants for ops dashboards, and
 * that v1 -> v2 snapshot migration assigns legacy data to a single tenant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'
import type { ExecutionRecord } from '../learning/adapter-learning-loop.js'
import type { LearningSnapshot } from '../learning/learning-store.js'
import { migrateLearningSnapshotV1toV2 } from '../learning/learning-store.js'
import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  providerId: AdapterProviderId,
  taskType: string,
  success: boolean,
  tenantId: string,
  overrides?: Partial<ExecutionRecord>,
): ExecutionRecord {
  return {
    tenantId,
    providerId,
    taskType,
    tags: [],
    success,
    durationMs: 100,
    inputTokens: 500,
    outputTokens: 200,
    costCents: 1,
    timestamp: Date.now(),
    ...overrides,
  }
}

function addRecords(
  loop: AdapterLearningLoop,
  providerId: AdapterProviderId,
  taskType: string,
  count: number,
  success: boolean,
  tenantId: string,
  overrides?: Partial<ExecutionRecord>,
): void {
  for (let i = 0; i < count; i++) {
    loop.record(
      makeRecord(providerId, taskType, success, tenantId, {
        timestamp: Date.now() - (count - i) * 1000,
        ...overrides,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterLearningLoop tenant isolation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('getProfile for tenant A is not contaminated by tenant B records', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })

    addRecords(loop, 'claude', 'summarize', 50, false, 'tenant-A')
    addRecords(loop, 'claude', 'summarize', 50, true, 'tenant-B')

    const profileA = loop.getProfile('claude', 'tenant-A')
    const profileB = loop.getProfile('claude', 'tenant-B')

    expect(profileA.totalExecutions).toBe(50)
    expect(profileA.successRate).toBe(0)

    expect(profileB.totalExecutions).toBe(50)
    expect(profileB.successRate).toBe(1)
  })

  it('getBestProvider for tenant B does not consult tenant A failure patterns', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })

    // Tenant A: claude is bad
    addRecords(loop, 'claude', 'summarize', 30, false, 'tenant-A')

    // Tenant B: claude is great, openai is mediocre
    addRecords(loop, 'claude', 'summarize', 30, true, 'tenant-B')
    addRecords(loop, 'openai', 'summarize', 20, true, 'tenant-B')
    addRecords(loop, 'openai', 'summarize', 10, false, 'tenant-B')

    const best = loop.getBestProvider(
      'summarize',
      ['claude', 'openai'] as AdapterProviderId[],
      'tenant-B',
    )

    expect(best).toBe('claude')
  })

  it('getGlobalProfile aggregates across all tenants', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })

    addRecords(loop, 'claude', 'summarize', 50, false, 'tenant-A')
    addRecords(loop, 'claude', 'summarize', 50, true, 'tenant-B')

    const global = loop.getGlobalProfile('claude')

    expect(global.totalExecutions).toBe(100)
    expect(global.successRate).toBeCloseTo(0.5, 5)
  })

  it('warns when getProfile is called without tenantId on a populated loop', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    addRecords(loop, 'claude', 'summarize', 5, true, 'tenant-A')

    loop.getProfile('claude')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'tenantId not provided',
    )
  })

  it('does not warn when explicit tenantId is provided', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    addRecords(loop, 'claude', 'summarize', 5, true, 'tenant-A')

    loop.getProfile('claude', 'tenant-A')
    loop.getBestProvider('summarize', ['claude'] as AdapterProviderId[], 'tenant-A')
    loop.getAllProfiles('tenant-A')

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when records map is empty', () => {
    const loop = new AdapterLearningLoop()
    loop.getProfile('claude')
    loop.getAllProfiles()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('migrateLearningSnapshotV1toV2 assigns bare-key records to legacyTenantId', () => {
    const v1: LearningSnapshot = {
      version: 1,
      exportedAt: 1700000000000,
      records: {
        claude: [
          makeRecord('claude', 'summarize', true, 'default', { timestamp: 1700000000000 }),
        ],
      },
      profiles: {},
      failurePatterns: {},
    }

    const v2 = migrateLearningSnapshotV1toV2(v1, 'legacy-org')

    expect(v2.version).toBe(2)
    expect(v2.records['legacy-org']).toBeDefined()
    expect(v2.records['legacy-org']!.claude).toHaveLength(1)
    expect(v2.records['legacy-org']!.claude![0]?.providerId).toBe('claude')
  })

  it('migrateLearningSnapshotV1toV2 preserves explicit tenantId in scoped keys', () => {
    const v1: LearningSnapshot = {
      version: 1,
      exportedAt: 1700000000000,
      records: {
        'tenant-A:claude': [
          makeRecord('claude', 'summarize', true, 'tenant-A', { timestamp: 1700000000000 }),
        ],
        openai: [
          makeRecord('openai', 'summarize', false, 'default', { timestamp: 1700000000000 }),
        ],
      },
      profiles: {},
      failurePatterns: {},
    }

    const v2 = migrateLearningSnapshotV1toV2(v1, 'legacy-org')

    expect(v2.records['tenant-A']).toBeDefined()
    expect(v2.records['tenant-A']!.claude).toHaveLength(1)
    expect(v2.records['legacy-org']).toBeDefined()
    expect(v2.records['legacy-org']!.openai).toHaveLength(1)
  })

  it('migrateLearningSnapshotV1toV2 throws when legacyTenantId is empty', () => {
    const v1: LearningSnapshot = {
      version: 1,
      exportedAt: 0,
      records: {},
      profiles: {},
      failurePatterns: {},
    }

    expect(() => migrateLearningSnapshotV1toV2(v1, '')).toThrow(/legacyTenantId/)
  })
})
