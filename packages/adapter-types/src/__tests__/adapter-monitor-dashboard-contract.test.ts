import { describe, expect, it } from 'vitest'
import type { AdapterMonitorDashboardContract } from '../index.js'

describe('AdapterMonitorDashboardContract', () => {
  it('is importable from the package surface and conforms to the expected shape', () => {
    const row: AdapterMonitorDashboardContract = {
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

    const expectedKeys = [
      'providerId',
      'monitorTier',
      'watcherState',
      'rawEventCount',
      'normalizedEventCount',
      'artifactCount',
      'toolCallCount',
      'approvalPromptCount',
      'mcpToolUsageCount',
      'mcpMode',
      'costMicros',
      'totalTokens',
      'retryCount',
      'fallbackCount',
      'successRate',
    ] as const

    expect(Object.keys(row).sort()).toEqual([...expectedKeys].sort())
    expect(expectedKeys).toHaveLength(15)
    expect(row.providerId).toBe('claude')
    expect(row.monitorTier).toBe('deep')
    expect(row.watcherState).toBe('active')
  })

  it('allows numeric metrics to be null when a measurement is unavailable', () => {
    const empty: AdapterMonitorDashboardContract = {
      providerId: 'qwen',
      monitorTier: 'none',
      watcherState: 'not_configured',
      rawEventCount: null,
      normalizedEventCount: null,
      artifactCount: null,
      toolCallCount: null,
      approvalPromptCount: null,
      mcpToolUsageCount: null,
      mcpMode: null,
      costMicros: null,
      totalTokens: null,
      retryCount: null,
      fallbackCount: null,
      successRate: null,
    }

    expect(empty.rawEventCount).toBeNull()
    expect(empty.mcpMode).toBeNull()
    expect(empty.successRate).toBeNull()
    expect(empty.watcherState).toBe('not_configured')
  })
})
