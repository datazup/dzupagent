import type { AdapterMonitorDashboardContract } from '@dzupagent/adapter-types/monitoring/dashboard'
import type { DzupEvent } from '@dzupagent/core/events'

import type { AgentEvent } from '../types.js'

const DEFAULT_MAX_TRACKED_RUNS = 10_000
const MICROS_PER_CENT = 10_000

export interface DashboardMetricObservation<T> {
  value: T | null
  stale?: boolean
}

export interface DashboardProviderMetrics {
  providerId: string
  watcherState?: DashboardMetricObservation<AdapterMonitorDashboardContract['watcherState']>
  rawEventCount?: DashboardMetricObservation<number>
  normalizedEventCount?: DashboardMetricObservation<number>
  artifactCount?: DashboardMetricObservation<number>
  approvalPromptCount?: DashboardMetricObservation<number>
  mcpToolUsageCount?: DashboardMetricObservation<number>
  mcpMode?: DashboardMetricObservation<NonNullable<AdapterMonitorDashboardContract['mcpMode']>>
  costMicros?: DashboardMetricObservation<number>
  totalTokens?: DashboardMetricObservation<number>
  fallbackCount?: DashboardMetricObservation<number>
}

export interface DashboardProjectionSource {
  getProviderIds?(): Iterable<string>
  getMetrics(providerId: string): DashboardProviderMetrics | null
  subscribe?(listener: (metrics: DashboardProviderMetrics) => void): () => void
}

type DashboardProjectionEventPayload =
  | { type: 'run_started'; providerId: string; runId: string }
  | {
      type: 'run_terminal'
      providerId: string
      runId: string
      outcome: 'completed' | 'failed' | 'process_death'
      usage?: { inputTokens?: number; outputTokens?: number; costCents?: number }
    }
  | { type: 'tool_called'; providerId?: string; runId?: string }
  | { type: 'approval_prompted'; providerId?: string; runId?: string }
  | { type: 'retry_started'; providerId: string }
  | { type: 'fallback_used'; providerId: string }
  | { type: 'metrics_observed'; metrics: DashboardProviderMetrics }

export type DashboardProjectionEvent = DashboardProjectionEventPayload & {
  eventId?: string
}

export interface ProviderTally {
  toolCallCount: number
  approvalPromptCount: number
  retryCount: number
  fallbackCount: number | null
  completedCount: number
  failedCount: number
  costMicros: number | null
  totalTokens: number | null
  metrics: Omit<DashboardProviderMetrics, 'providerId'>
}

export interface DashboardProjectionState {
  readonly providers: ReadonlyMap<string, ProviderTally>
  readonly openRuns: ReadonlyMap<string, string>
  readonly settledRuns: ReadonlyMap<string, string>
  readonly seenEventIds: ReadonlySet<string>
  readonly droppedUnattributed: number
  readonly maxTrackedRuns: number
}

export function createDashboardProjectionState(
  maxTrackedRuns = DEFAULT_MAX_TRACKED_RUNS,
): DashboardProjectionState {
  if (!Number.isInteger(maxTrackedRuns) || maxTrackedRuns <= 0) {
    throw new Error(`maxTrackedRuns must be a positive integer (got ${maxTrackedRuns})`)
  }
  return {
    providers: new Map(),
    openRuns: new Map(),
    settledRuns: new Map(),
    seenEventIds: new Set(),
    droppedUnattributed: 0,
    maxTrackedRuns,
  }
}

function emptyTally(): ProviderTally {
  return {
    toolCallCount: 0,
    approvalPromptCount: 0,
    retryCount: 0,
    fallbackCount: null,
    completedCount: 0,
    failedCount: 0,
    costMicros: null,
    totalTokens: null,
    metrics: {},
  }
}

function boundMap<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key)
  while (map.size >= maximum) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
  map.set(key, value)
}

function remember(set: Set<string>, value: string, maximum: number): void {
  set.delete(value)
  while (set.size >= maximum) {
    const oldest = set.values().next()
    if (oldest.done) break
    set.delete(oldest.value)
  }
  set.add(value)
}

export function reduceDashboardProjection(
  current: DashboardProjectionState,
  event: DashboardProjectionEvent,
): DashboardProjectionState {
  if (event.eventId !== undefined && current.seenEventIds.has(event.eventId)) return current
  const providers = new Map(current.providers)
  const openRuns = new Map(current.openRuns)
  const settledRuns = new Map(current.settledRuns)
  const seenEventIds = new Set(current.seenEventIds)
  let droppedUnattributed = current.droppedUnattributed
  const tallyFor = (providerId: string): ProviderTally => {
    const tally = { ...(providers.get(providerId) ?? emptyTally()) }
    tally.metrics = { ...tally.metrics }
    providers.set(providerId, tally)
    return tally
  }
  const attributed = (providerId?: string, runId?: string): string | null => {
    const resolved = providerId ?? (runId ? (openRuns.get(runId) ?? settledRuns.get(runId)) : undefined)
    if (resolved !== undefined) return resolved
    droppedUnattributed += 1
    return null
  }

  switch (event.type) {
    case 'run_started':
      tallyFor(event.providerId)
      if (!settledRuns.has(event.runId)) {
        boundMap(openRuns, event.runId, event.providerId, current.maxTrackedRuns)
      }
      break
    case 'run_terminal': {
      if (settledRuns.has(event.runId)) break
      const tally = tallyFor(event.providerId)
      if (event.outcome === 'completed') tally.completedCount += 1
      else tally.failedCount += 1
      if (event.usage?.costCents !== undefined) {
        tally.costMicros = (tally.costMicros ?? 0) + event.usage.costCents * MICROS_PER_CENT
      }
      if (event.usage?.inputTokens !== undefined || event.usage?.outputTokens !== undefined) {
        tally.totalTokens =
          (tally.totalTokens ?? 0) +
          (event.usage.inputTokens ?? 0) +
          (event.usage.outputTokens ?? 0)
      }
      openRuns.delete(event.runId)
      boundMap(settledRuns, event.runId, event.providerId, current.maxTrackedRuns)
      break
    }
    case 'tool_called': {
      const providerId = attributed(event.providerId, event.runId)
      if (providerId !== null) tallyFor(providerId).toolCallCount += 1
      break
    }
    case 'approval_prompted': {
      const providerId = attributed(event.providerId, event.runId)
      if (providerId !== null) tallyFor(providerId).approvalPromptCount += 1
      break
    }
    case 'retry_started':
      tallyFor(event.providerId).retryCount += 1
      break
    case 'fallback_used': {
      const tally = tallyFor(event.providerId)
      tally.fallbackCount = (tally.fallbackCount ?? 0) + 1
      break
    }
    case 'metrics_observed': {
      const { providerId, ...metrics } = event.metrics
      const tally = tallyFor(providerId)
      tally.metrics = { ...tally.metrics, ...metrics }
      break
    }
  }
  if (event.eventId !== undefined) remember(seenEventIds, event.eventId, current.maxTrackedRuns * 8)
  return { providers, openRuns, settledRuns, seenEventIds, droppedUnattributed, maxTrackedRuns: current.maxTrackedRuns }
}

export function replayDashboardProjection(
  events: Iterable<DashboardProjectionEvent>,
  initial = createDashboardProjectionState(),
): DashboardProjectionState {
  let state = initial
  for (const event of events) state = reduceDashboardProjection(state, event)
  return state
}

export function dashboardEventFromBus(event: DzupEvent, eventId: string): DashboardProjectionEvent | null {
  switch (event.type) {
    case 'agent:started': return { type: 'run_started', providerId: event.agentId, runId: event.runId, eventId }
    case 'agent:completed': return { type: 'run_terminal', providerId: event.agentId, runId: event.runId, outcome: 'completed', usage: event.usage, eventId }
    case 'agent:failed': return { type: 'run_terminal', providerId: event.agentId, runId: event.runId, outcome: 'failed', eventId }
    case 'tool:called': return { type: 'tool_called', providerId: event.agentId, runId: event.executionRunId ?? event.runId, eventId }
    case 'adapter:interaction_required': return { type: 'approval_prompted', providerId: event.providerId, eventId }
    case 'governance:approval_requested': return { type: 'approval_prompted', runId: event.runId, eventId }
    case 'recovery:attempt_started': return { type: 'retry_started', providerId: event.agentId, eventId }
    case 'agent:progress': return event.phase === 'registry:fallback_attempt' ? { type: 'fallback_used', providerId: event.agentId, eventId } : null
    case 'adapter:run_completed': return event.providerId === undefined ? null : { type: 'run_terminal', providerId: event.providerId, runId: event.runId, outcome: 'completed', eventId }
    case 'adapter:run_halted':
    case 'adapter:run_failed':
    case 'adapter:run_cancelled':
    case 'adapter:run_rejected':
      return event.providerId === undefined ? null : { type: 'run_terminal', providerId: event.providerId, runId: event.runId, outcome: event.type === 'adapter:run_halted' ? 'process_death' : 'failed', eventId }
    default: return null
  }
}

export function retainedEventFromAgentEvent(
  event: AgentEvent,
  runId: string,
  occurrenceId: string,
): DashboardProjectionEvent | null {
  const eventId = `run-store:${runId}:${occurrenceId}`
  switch (event.type) {
    case 'adapter:started': return { type: 'run_started', providerId: event.providerId, runId, eventId }
    case 'adapter:tool_call': return { type: 'tool_called', providerId: event.providerId, runId, eventId }
    case 'adapter:interaction_required': return { type: 'approval_prompted', providerId: event.providerId, runId, eventId }
    case 'adapter:completed': return { type: 'run_terminal', providerId: event.providerId, runId, outcome: 'completed', usage: event.usage, eventId }
    case 'adapter:failed': return { type: 'run_terminal', providerId: event.providerId, runId, outcome: 'failed', eventId }
    case 'adapter:progress': return event.phase === 'registry:fallback_attempt' ? { type: 'fallback_used', providerId: event.providerId, eventId } : null
    default: return null
  }
}
