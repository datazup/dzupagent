/** Public V1 adapter-monitor dashboard projection surface. */
export {
  DashboardProjectionSubscriber,
  createDashboardProjectionSubscriber,
  createDashboardProjectionState,
  reduceDashboardProjection,
  replayDashboardProjection,
  UNSOURCED_V1_FIELDS,
} from './dashboard-projection-subscriber.js'
export {
  createArtifactWatcherHostDashboardSource,
  createCostTrackingDashboardSource,
  createGovernanceDashboardSource,
  createMcpToolSharingDashboardSource,
  createRouterFallbackDashboardSource,
  createRunEventStoreDashboardSource,
} from './dashboard-projection-sources.js'
export type {
  DashboardMetricObservation,
  DashboardProjectionEvent,
  DashboardProjectionSource,
  DashboardProjectionState,
  DashboardProjectionStats,
  DashboardProjectionSubscriberOptions,
  DashboardProviderMetrics,
} from './dashboard-projection-subscriber.js'
