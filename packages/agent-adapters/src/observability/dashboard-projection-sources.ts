import type { DzupEventBus } from '@dzupagent/core/events'

import type { ArtifactWatcherHost } from '../base/artifact-watcher-host.js'
import type { MCPToolSharingBridge } from '../mcp/mcp-tool-sharing.js'
import type { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import type { RunEventStore } from '../runs/run-event-store.js'
import type { AdapterProviderId } from '../types.js'
import type {
  DashboardProjectionSource,
  DashboardProviderMetrics,
} from './dashboard-projection-reducer.js'

const MICROS_PER_CENT = 10_000

export function createRunEventStoreDashboardSource(
  providerId: string,
  store: RunEventStore,
): DashboardProjectionSource {
  const getMetrics = (): DashboardProviderMetrics => {
    const counts = store.getCounts()
    return {
      providerId,
      rawEventCount: { value: counts.rawEventCount, stale: false },
      normalizedEventCount: { value: counts.normalizedEventCount, stale: false },
      artifactCount: { value: counts.artifactCount, stale: false },
    }
  }
  return {
    getProviderIds: () => [providerId],
    getMetrics,
    subscribe: (listener) => store.onCountsChanged(() => listener(getMetrics())),
  }
}

export function createArtifactWatcherHostDashboardSource(
  host: ArtifactWatcherHost,
  options: { now?: () => number; staleAfterMs?: number } = {},
): DashboardProjectionSource {
  const now = options.now ?? Date.now
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const providerId = host.getProviderId()
  const getMetrics = (): DashboardProviderMetrics => ({
    providerId,
    watcherState: {
      value: host.watcherActivationStatus(),
      stale: now() - host.getStatusObservedAt() > staleAfterMs,
    },
  })
  return {
    getProviderIds: () => [providerId],
    getMetrics,
    subscribe: (listener) => host.onStatusChanged(() => listener(getMetrics())),
  }
}

export function createMcpToolSharingDashboardSource(
  bridge: MCPToolSharingBridge,
): DashboardProjectionSource {
  const getMetrics = (providerId: string): DashboardProviderMetrics | null => {
    const snapshot = bridge.getProviderObservability(providerId as AdapterProviderId)
    return snapshot === null
      ? null
      : {
          providerId,
          mcpMode: { value: snapshot.mode, stale: false },
          mcpToolUsageCount: { value: snapshot.invocationCount, stale: false },
        }
  }
  return {
    getProviderIds: () => bridge.getObservedProviderIds(),
    getMetrics,
    subscribe: (listener) =>
      bridge.onProviderObservabilityChanged((snapshot) => {
        const metrics = getMetrics(snapshot.providerId)
        if (metrics !== null) listener(metrics)
      }),
  }
}

export function createCostTrackingDashboardSource(
  middleware: CostTrackingMiddleware,
): DashboardProjectionSource {
  const getProviderIds = (): string[] => Object.keys(middleware.getUsage().perProvider)
  const getMetrics = (providerId: string): DashboardProviderMetrics | null => {
    const usage = middleware.getUsage().perProvider[providerId]
    return usage === undefined
      ? null
      : {
          providerId,
          costMicros: { value: usage.costCents * MICROS_PER_CENT, stale: false },
          totalTokens: { value: usage.inputTokens + usage.outputTokens, stale: false },
        }
  }
  return {
    getProviderIds,
    getMetrics,
    subscribe: (listener) =>
      middleware.onUsageChanged(() => {
        for (const providerId of getProviderIds()) {
          const metrics = getMetrics(providerId)
          if (metrics !== null) listener(metrics)
        }
      }),
  }
}

export function createRouterFallbackDashboardSource(
  eventBus: DzupEventBus,
): DashboardProjectionSource {
  const counts = new Map<string, number>()
  return {
    getProviderIds: () => counts.keys(),
    getMetrics: (providerId) =>
      counts.has(providerId)
        ? { providerId, fallbackCount: { value: counts.get(providerId)!, stale: false } }
        : null,
    subscribe: (listener) =>
      eventBus.on('agent:progress', (event) => {
        if (event.phase !== 'registry:fallback_attempt') return
        const value = (counts.get(event.agentId) ?? 0) + 1
        counts.set(event.agentId, value)
        listener({ providerId: event.agentId, fallbackCount: { value, stale: false } })
      }),
  }
}

export function createGovernanceDashboardSource(
  eventBus: DzupEventBus,
): DashboardProjectionSource {
  const counts = new Map<string, number>()
  const runProviders = new Map<string, string>()
  const seenApprovals = new Set<string>()
  const listeners = new Set<(metrics: DashboardProviderMetrics) => void>()
  const publish = (providerId: string, identity: string): void => {
    if (seenApprovals.has(identity)) return
    seenApprovals.add(identity)
    const value = (counts.get(providerId) ?? 0) + 1
    counts.set(providerId, value)
    for (const listener of listeners) {
      listener({ providerId, approvalPromptCount: { value, stale: false } })
    }
  }
  let detach: Array<() => void> = []
  return {
    getProviderIds: () => counts.keys(),
    getMetrics: (providerId) =>
      counts.has(providerId)
        ? { providerId, approvalPromptCount: { value: counts.get(providerId)!, stale: false } }
        : null,
    subscribe: (listener) => {
      listeners.add(listener)
      if (detach.length === 0) {
        detach = [
          eventBus.on('agent:started', (event) => {
            runProviders.set(event.runId, event.agentId)
          }),
          eventBus.on('adapter:interaction_required', (event) =>
            publish(event.providerId, event.interactionId),
          ),
          eventBus.onAny((event) => {
            if (event.type !== 'governance:approval_requested') return
            const governance = event as { runId: string; approvalId?: string }
            const providerId = runProviders.get(governance.runId)
            if (providerId !== undefined) {
              publish(providerId, governance.approvalId ?? governance.runId)
            }
          }),
        ]
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          for (const unsubscribe of detach) unsubscribe()
          detach = []
        }
      }
    },
  }
}
