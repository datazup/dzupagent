/** Bounded V1 dashboard projection.
 * The reducer in this module is deliberately independent of the event bus and
 * storage implementations. Live bus traffic and retained replay are converted
 * to the same input union, which keeps recovery after a process restart
 * equivalent to uninterrupted collection.
 */
import type { AdapterMonitorDashboardContract } from '@dzupagent/adapter-types/monitoring/dashboard'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core/events'

import { getProviderCapabilities } from '../provider-catalog.js'
import type { RunEventStore } from '../runs/run-event-store.js'
import {
  createDashboardProjectionState,
  dashboardEventFromBus,
  reduceDashboardProjection,
  replayDashboardProjection,
  retainedEventFromAgentEvent,
} from './dashboard-projection-reducer.js'
import type {
  DashboardMetricObservation,
  DashboardProjectionEvent,
  DashboardProjectionSource,
  DashboardProjectionState,
} from './dashboard-projection-reducer.js'

const DEFAULT_MAX_QUEUED_EVENTS = 1_000

export interface DashboardProjectionStats {
  droppedUnattributed: number
  openRuns: number
  rememberedTerminalRuns: number
  queuedEvents: number
  overflowedEvents: number
  retainedRecoveries: number
}

export interface DashboardProjectionSubscriberOptions {
  maxTrackedRuns?: number
  /** Maximum live events awaiting an asynchronous reduction batch. */
  maxQueuedEvents?: number
  retainedEvents?: Iterable<DashboardProjectionEvent>
  /** Concrete retained stores used to recover after bounded-queue overflow. */
  runEventStores?: readonly RunEventStore[]
  runEventSource?: DashboardProjectionSource
  watcherSource?: DashboardProjectionSource
  mcpSource?: DashboardProjectionSource
  routerFallbackSource?: DashboardProjectionSource
  governanceSource?: DashboardProjectionSource
  costSource?: DashboardProjectionSource
}


function current<T>(observation: DashboardMetricObservation<T> | undefined): T | null | undefined {
  if (observation === undefined) return undefined
  return observation.stale === true ? null : observation.value
}

function observedOr<T>(
  observation: DashboardMetricObservation<T> | undefined,
  fallback: T | null,
): T | null {
  return observation === undefined ? fallback : (current(observation) ?? null)
}

export class DashboardProjectionSubscriber {
  private state: DashboardProjectionState
  private readonly unsubscribers: Array<() => void> = []
  private readonly sources: DashboardProjectionSource[]
  private readonly pendingEvents: DashboardProjectionEvent[] = []
  private readonly maxQueuedEvents: number
  private drainScheduled = false
  private retainedApplied = false
  private started = false
  private overflowedEvents = 0
  private retainedRecoveries = 0
  private recoveryPromise: Promise<void> | null = null
  private nextLiveEventId = 0
  private readonly liveEventIds = new WeakMap<object, string>()

  constructor(
    private readonly eventBus: DzupEventBus,
    private readonly options: DashboardProjectionSubscriberOptions = {},
  ) {
    this.state = createDashboardProjectionState(options.maxTrackedRuns)
    this.maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS
    if (!Number.isInteger(this.maxQueuedEvents) || this.maxQueuedEvents <= 0) {
      throw new Error(`maxQueuedEvents must be a positive integer (got ${this.maxQueuedEvents})`)
    }
    this.sources = [
      options.runEventSource,
      options.watcherSource,
      options.mcpSource,
      options.routerFallbackSource,
      options.governanceSource,
      options.costSource,
    ].filter((source): source is DashboardProjectionSource => source !== undefined)
  }

  /** Replay retained state first, then attach live adapters. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true

    if (!this.retainedApplied && this.options.retainedEvents !== undefined) {
      this.state = replayDashboardProjection(this.options.retainedEvents, this.state)
      this.retainedApplied = true
    }
    this.refreshSources()

    this.unsubscribers.push(
      this.eventBus.onAny((event) => {
        const projectionEvent = dashboardEventFromBus(event, this.liveEventId(event))
        if (projectionEvent !== null) this.enqueue(projectionEvent)
      }),
    )
    for (const source of this.sources) {
      if (source.subscribe !== undefined) {
        this.unsubscribers.push(
          source.subscribe((metrics) => this.accept({ type: 'metrics_observed', metrics })),
        )
      }
    }
  }

  /** Detach every bus/source listener and release bounded run lifecycle state. */
  dispose(): void {
    this.flushPending()
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.state = {
      ...this.state,
      openRuns: new Map(),
      settledRuns: new Map(),
      seenEventIds: new Set(),
    }
    this.started = false
  }

  /** Explicit retained-event repair, useful after reconnecting a durable store. */
  repair(events: Iterable<DashboardProjectionEvent>): void {
    this.flushPending()
    this.state = replayDashboardProjection(
      events,
      createDashboardProjectionState(this.state.maxTrackedRuns),
    )
    this.refreshSources()
  }

  /** Rebuild projection state from concrete retained RunEventStore streams. */
  async repairFromRunEventStores(
    stores: readonly RunEventStore[] = this.options.runEventStores ?? [],
  ): Promise<void> {
    await this.beginRetainedRecovery(stores)
  }

  /** Flush live input and await scheduled/in-flight retained repair before detaching. */
  async shutdown(): Promise<void> {
    this.flushPending()
    await this.recoveryPromise
    this.dispose()
  }

  private async recoverFromRunEventStores(stores: readonly RunEventStore[]): Promise<void> {
    const retained: DashboardProjectionEvent[] = []
    for (const store of stores) {
      const records = await store.readNormalizedEventRecords()
      records.forEach(({ event, occurrenceId }) => {
        const projected = retainedEventFromAgentEvent(event, store.getRunId(), occurrenceId)
        if (projected !== null) retained.push(projected)
      })
    }
    this.repair(retained)
    this.retainedRecoveries += 1
  }

  getProviderIds(): string[] {
    this.flushPending()
    return [...this.state.providers.keys()]
  }

  getProjection(providerId: string): AdapterMonitorDashboardContract | null {
    this.flushPending()
    if (!this.state.providers.has(providerId)) return null
    this.refreshProviderSources(providerId)
    const tally = this.state.providers.get(providerId)
    if (tally === undefined) return null
    const terminalCount = tally.completedCount + tally.failedCount
    const sourced = tally.metrics
    const watcherState = sourced.watcherState?.value
    // Frozen V1 cannot encode an unknown watcher state. With no concrete host
    // observation, omit the row instead of manufacturing `not_configured`.
    if (watcherState === undefined || watcherState === null) return null

    return {
      providerId,
      monitorTier: getProviderCapabilities(providerId)?.monitorIntrospection ?? 'none',
      // V1 has no stale/unknown watcher discriminator. Preserve the concrete
      // host's last observation when it becomes stale; never rewrite stale
      // `active`/`stopped` evidence to `not_configured`.
      watcherState,
      rawEventCount: observedOr(sourced.rawEventCount, null),
      normalizedEventCount: observedOr(sourced.normalizedEventCount, null),
      artifactCount: observedOr(sourced.artifactCount, null),
      toolCallCount: tally.toolCallCount,
      approvalPromptCount: observedOr(sourced.approvalPromptCount, tally.approvalPromptCount),
      mcpToolUsageCount: observedOr(sourced.mcpToolUsageCount, null),
      mcpMode: observedOr(sourced.mcpMode, null),
      costMicros: observedOr(sourced.costMicros, tally.costMicros),
      totalTokens: observedOr(sourced.totalTokens, tally.totalTokens),
      retryCount: tally.retryCount,
      fallbackCount: observedOr(sourced.fallbackCount, tally.fallbackCount),
      successRate: terminalCount === 0 ? null : tally.completedCount / terminalCount,
    }
  }

  getAllProjections(): AdapterMonitorDashboardContract[] {
    this.flushPending()
    return this.getProviderIds()
      .map((providerId) => this.getProjection(providerId))
      .filter((row): row is AdapterMonitorDashboardContract => row !== null)
  }

  getStats(): DashboardProjectionStats {
    this.flushPending()
    return {
      droppedUnattributed: this.state.droppedUnattributed,
      openRuns: this.state.openRuns.size,
      rememberedTerminalRuns: this.state.settledRuns.size,
      queuedEvents: this.pendingEvents.length,
      overflowedEvents: this.overflowedEvents,
      retainedRecoveries: this.retainedRecoveries,
    }
  }

  private accept(event: DashboardProjectionEvent): void {
    this.state = reduceDashboardProjection(this.state, event)
  }

  private enqueue(event: DashboardProjectionEvent): void {
    if (this.pendingEvents.length >= this.maxQueuedEvents) {
      this.overflowedEvents += 1
      this.scheduleRetainedRecovery()
      return
    }
    this.pendingEvents.push(event)
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      if (this.started) this.flushPending()
    })
  }

  private liveEventId(event: DzupEvent): string {
    const known = this.liveEventIds.get(event as object)
    if (known !== undefined) return known
    const id = `live:${this.nextLiveEventId++}`
    this.liveEventIds.set(event as object, id)
    return id
  }

  private scheduleRetainedRecovery(): void {
    const stores = this.options.runEventStores ?? []
    if (stores.length === 0) return
    void this.beginRetainedRecovery(stores)
  }

  private beginRetainedRecovery(stores: readonly RunEventStore[]): Promise<void> {
    if (this.recoveryPromise !== null) return this.recoveryPromise

    // Promise chaining intentionally defers disk reads until the current bus
    // emission batch completes, while assigning the promise immediately so an
    // immediate shutdown can observe and await the scheduled work.
    const recovery = Promise.resolve().then(async () => {
      if (!this.started || stores.length === 0) return
      await this.recoverFromRunEventStores(stores)
    })
    this.recoveryPromise = recovery
    const clearRecovery = (): void => {
      if (this.recoveryPromise === recovery) this.recoveryPromise = null
    }
    void recovery.then(clearRecovery, clearRecovery)
    return recovery
  }

  private flushPending(): void {
    if (this.pendingEvents.length === 0) return
    const pending = this.pendingEvents.splice(0)
    this.state = replayDashboardProjection(pending, this.state)
  }

  private refreshSources(): void {
    for (const source of this.sources) {
      for (const providerId of source.getProviderIds?.() ?? []) {
        const metrics = source.getMetrics(providerId)
        if (metrics !== null) this.accept({ type: 'metrics_observed', metrics })
      }
    }
  }

  private refreshProviderSources(providerId: string): void {
    for (const source of this.sources) {
      const metrics = source.getMetrics(providerId)
      if (metrics !== null) this.accept({ type: 'metrics_observed', metrics })
    }
  }
}

export function createDashboardProjectionSubscriber(
  eventBus: DzupEventBus,
  options?: DashboardProjectionSubscriberOptions,
): DashboardProjectionSubscriber {
  const subscriber = new DashboardProjectionSubscriber(eventBus, options)
  subscriber.start()
  return subscriber
}

/** Legacy diagnostic retained without claiming that every field is permanently unsourced. */
export const UNSOURCED_V1_FIELDS = {} as const satisfies Partial<
  Record<keyof AdapterMonitorDashboardContract, string>
>

export {
  createDashboardProjectionState,
  reduceDashboardProjection,
  replayDashboardProjection,
} from './dashboard-projection-reducer.js'
export type {
  DashboardMetricObservation,
  DashboardProjectionEvent,
  DashboardProjectionSource,
  DashboardProjectionState,
  DashboardProviderMetrics,
} from './dashboard-projection-reducer.js'
export type { DzupEvent }
