/**
 * Additive V2 adapter-monitor dashboard projection (spec doc 06 §5.2).
 *
 * V2 deliberately embeds the complete V1 projection.  Consumers which have
 * not adopted the installation and health fields can therefore continue to
 * render exactly the V1 view without interpreting derived V2 data.
 */
import type { AdapterMonitorDashboardContract } from './adapter-monitor-dashboard.js'

/** V2 dashboard projection for one provider installation. */
export interface AdapterMonitorDashboardContractV2 {
  /** The unmodified V1 projection consumed by existing dashboards. */
  v1: AdapterMonitorDashboardContract
  installationId: string | null
  installedVersion: string | null
  manifestHash: string | null
  healthOverall:
    | 'healthy'
    | 'degraded'
    | 'misconfigured'
    | 'unavailable'
    | 'updating'
    | 'unknown'
  /** Integer rung number in the inclusive range 0..6, or null when unknown. */
  highestRungPassed: number | null
  lastCanaryAt: string | null
  lastCanaryOutcome: 'passed' | 'failed' | 'skipped:budget' | null
  lifecycleState:
    | 'active'
    | 'staging'
    | 'updating'
    | 'rolling-back'
    | 'quarantined'
    | null
  driftFindingsOpen: number | null
  /** Age of the newest contributing datum, or null when no datum is known. */
  stalenessSeconds: number | null
  budget: {
    l5RemainingMicros: number | null
    l6RemainingMicros: number | null
  }
}

const V1_PROJECTION_KEYS = [
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
] as const satisfies readonly (keyof AdapterMonitorDashboardContract)[]

/**
 * Returns the V1 projection for a V1-only consumer.
 *
 * This is intentionally a projection, not a reconstruction: V2-derived
 * fields must never affect a V1 change decision (D-06).
 */
export function projectAdapterMonitorDashboardV1(
  dashboard: AdapterMonitorDashboardContractV2,
): AdapterMonitorDashboardContract {
  return dashboard.v1
}

/**
 * Compares only V1 source fields for a V1 consumer's change detector.
 *
 * The matcher deliberately excludes every V2-derived field.  A health or
 * budget refresh must not make a V1 source projection appear changed.
 */
export function matchesAdapterMonitorDashboardV1Projection(
  dashboard: AdapterMonitorDashboardContractV2,
  expected: AdapterMonitorDashboardContract,
): boolean {
  return V1_PROJECTION_KEYS.every((key) => dashboard.v1[key] === expected[key])
}
