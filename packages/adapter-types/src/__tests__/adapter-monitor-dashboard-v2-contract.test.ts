import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  matchesAdapterMonitorDashboardV1Projection,
  projectAdapterMonitorDashboardV1,
} from '../monitoring/dashboard.js'
import type {
  AdapterMonitorDashboardContract,
  AdapterMonitorDashboardContractV2,
} from '../monitoring/dashboard.js'

const v1: AdapterMonitorDashboardContract = {
  providerId: 'claude',
  monitorTier: 'deep',
  watcherState: 'active',
  rawEventCount: 12,
  normalizedEventCount: 8,
  artifactCount: 3,
  toolCallCount: 5,
  approvalPromptCount: 1,
  mcpToolUsageCount: 2,
  mcpMode: 'native',
  costMicros: 4200,
  totalTokens: 1024,
  retryCount: 0,
  fallbackCount: 0,
  successRate: 1,
}

const v2: AdapterMonitorDashboardContractV2 = {
  v1,
  installationId: 'inst-claude-01',
  installedVersion: '1.2.3',
  manifestHash: 'sha256:manifest',
  healthOverall: 'healthy',
  highestRungPassed: 4,
  lastCanaryAt: null,
  lastCanaryOutcome: null,
  lifecycleState: 'active',
  driftFindingsOpen: 0,
  stalenessSeconds: 15,
  budget: { l5RemainingMicros: null, l6RemainingMicros: null },
}

describe('AdapterMonitorDashboardContractV2', () => {
  it('embeds the unchanged V1 contract for V1-only consumers', () => {
    const projected = projectAdapterMonitorDashboardV1(v2)

    expect(projected).toBe(v1)
    expect(projected).toEqual(v1)
    expectTypeOf(projected).toEqualTypeOf<AdapterMonitorDashboardContract>()
  })

  it('matches source fields while ignoring derived V2 fields', () => {
    const healthChanged: AdapterMonitorDashboardContractV2 = {
      ...v2,
      healthOverall: 'degraded',
      highestRungPassed: 2,
      driftFindingsOpen: 1,
      budget: { l5RemainingMicros: 100, l6RemainingMicros: 0 },
    }

    expect(matchesAdapterMonitorDashboardV1Projection(healthChanged, v1)).toBe(true)
  })

  it('rejects a changed V1 source field even when V2 fields are unchanged', () => {
    const changedSource: AdapterMonitorDashboardContractV2 = {
      ...v2,
      v1: { ...v1, totalTokens: 1025 },
    }

    expect(matchesAdapterMonitorDashboardV1Projection(changedSource, v1)).toBe(false)
  })

  it('keeps null-honest installation and budget data expressible', () => {
    const unknown: AdapterMonitorDashboardContractV2 = {
      ...v2,
      installationId: null,
      installedVersion: null,
      manifestHash: null,
      highestRungPassed: null,
      stalenessSeconds: null,
    }

    expect(unknown.installationId).toBeNull()
    expect(unknown.budget.l5RemainingMicros).toBeNull()
  })

  it('does not admit a bare canary skip that loses the budget reason', () => {
    // @ts-expect-error V2 preserves the explicit skip reason from the spec.
    const invalid: AdapterMonitorDashboardContractV2['lastCanaryOutcome'] = 'skipped'
    void invalid
  })
})
