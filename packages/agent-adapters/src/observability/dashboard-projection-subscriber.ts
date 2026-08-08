/**
 * V1 producer for {@link AdapterMonitorDashboardContract} (spec doc 06 §5.1).
 *
 * Closes the seam where the dashboard contract existed and was tested but had
 * no producer. Subscribes to {@link DzupEventBus} and materializes one
 * contract row per provider.
 *
 * Three rules govern this file:
 *
 * 1. **Aggregate on the bus, never in the path** (NFR-2). Everything here is a
 *    bus subscriber, so execution is byte-identical with the producer off.
 * 2. **Null ≠ zero.** A metric with no source reports `null`, not `0`. A `0`
 *    from this producer always means "measured zero".
 * 3. **Never guess attribution.** Bus events that cannot be attributed to a
 *    provider are counted as dropped, never assigned to an arbitrary one.
 *
 * ## Provider attribution
 *
 * `EventBusBridge.mapToDzupEvent` does not carry `providerId` onto
 * `tool:called` — the bus-plane event has only `executionRunId`. The
 * subscriber therefore learns run ownership from `agent:started` (which
 * carries `agentId`) and resolves later run-scoped events through that map.
 * A run whose `agent:started` was missed is unattributable, and its events are
 * counted in {@link DashboardProjectionStats.droppedUnattributed} rather than
 * being folded into some other provider's row.
 *
 * ## Fields with no V1 source
 *
 * `rawEventCount`, `normalizedEventCount`, `artifactCount`, `mcpToolUsageCount`,
 * `mcpMode`, and `fallbackCount` are always `null` in V1 — see
 * {@link UNSOURCED_V1_FIELDS} for why each one is unavailable. They are not
 * approximated: a wrong number is worse than an honest gap.
 */
import type { DzupEvent, DzupEventBus } from '@dzupagent/core/events'
import type { AdapterMonitorDashboardContract } from '@dzupagent/adapter-types'
import { getProviderCapabilities } from '../provider-catalog.js'

/**
 * Why each V1 contract field has no producer source yet.
 *
 * Recorded in code rather than only in the packet notes so a later packet
 * adding instrumentation can find every gap by reading this constant.
 */
export const UNSOURCED_V1_FIELDS = {
  rawEventCount: 'RunEventStore exposes no counters; raw events never reach the bus.',
  normalizedEventCount: 'RunEventStore exposes no counters for normalized events.',
  artifactCount: 'ArtifactWatcherHost emits no artifact events on the bus.',
  mcpToolUsageCount: 'No per-invocation MCP event exists; mcp:connected is per-server.',
  mcpMode: 'mcpMode is private to MCPToolSharingBridge with no per-provider lookup.',
  fallbackCount: 'No fallback-success bus event exists; fallback is a trace record only.',
} as const satisfies Partial<Record<keyof AdapterMonitorDashboardContract, string>>

/** Mutable per-provider tallies. Converted to the contract on read. */
interface ProviderTally {
  toolCallCount: number
  approvalPromptCount: number
  retryCount: number
  completedCount: number
  failedCount: number
  /** Micro-dollars accumulated from reported `costCents`; null until one is reported. */
  costMicros: number | null
  /** Sum of reported input+output tokens; null until a run reports usage. */
  totalTokens: number | null
}

/** Diagnostics about the subscriber itself, for tests and operational checks. */
export interface DashboardProjectionStats {
  /** Run-scoped events seen with no known provider — never misattributed. */
  droppedUnattributed: number
  /** Runs currently being tracked (awaiting a terminal event). */
  openRuns: number
}

export interface DashboardProjectionSubscriberOptions {
  /**
   * Cap on concurrently tracked runs, guarding against unbounded growth when
   * terminal events are missed. Oldest entries are evicted first.
   */
  maxTrackedRuns?: number
}

const DEFAULT_MAX_TRACKED_RUNS = 10_000

/** Cents → micro-dollars. One cent is 10,000 micro-dollars. */
const MICROS_PER_CENT = 10_000

function emptyTally(): ProviderTally {
  return {
    toolCallCount: 0,
    approvalPromptCount: 0,
    retryCount: 0,
    completedCount: 0,
    failedCount: 0,
    costMicros: null,
    totalTokens: null,
  }
}

/**
 * Materializes {@link AdapterMonitorDashboardContract} rows from bus traffic.
 *
 * Construct, call {@link start}, and read with {@link getProjection} or
 * {@link getAllProjections}. Call {@link dispose} to unsubscribe — after which
 * the bus has no reference to this instance.
 */
export class DashboardProjectionSubscriber {
  private readonly tallies = new Map<string, ProviderTally>()
  /** runId → providerId, learned from `agent:started`. */
  private readonly runProviders = new Map<string, string>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly maxTrackedRuns: number
  private droppedUnattributed = 0
  private started = false

  constructor(
    private readonly eventBus: DzupEventBus,
    options: DashboardProjectionSubscriberOptions = {},
  ) {
    this.maxTrackedRuns = options.maxTrackedRuns ?? DEFAULT_MAX_TRACKED_RUNS
  }

  /** Subscribe to the bus. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.started) return
    this.started = true

    this.unsubscribers.push(
      this.eventBus.on('agent:started', (event) => {
        this.rememberRun(event.runId, event.agentId)
        this.tallyFor(event.agentId)
      }),

      this.eventBus.on('agent:completed', (event) => {
        const tally = this.tallyFor(event.agentId)
        tally.completedCount += 1
        this.recordUsage(tally, event.usage)
        this.runProviders.delete(event.runId)
      }),

      this.eventBus.on('agent:failed', (event) => {
        this.tallyFor(event.agentId).failedCount += 1
        this.runProviders.delete(event.runId)
      }),

      // `tool:called` carries no providerId (the bridge drops it), so it is
      // resolved through the run map or dropped.
      this.eventBus.on('tool:called', (event) => {
        const providerId = this.resolveRunProvider(
          event.agentId ?? this.lookupRun(event.executionRunId ?? event.runId),
        )
        if (providerId === null) return
        this.tallyFor(providerId).toolCallCount += 1
      }),

      this.eventBus.on('adapter:interaction_required', (event) => {
        this.tallyFor(event.providerId).approvalPromptCount += 1
      }),

      // Bus-plane `governance:approval_requested` carries no providerId, so it
      // cannot contribute to a per-provider count and is deliberately not
      // subscribed. Doc 06 §5.1 lists it as a source; the shape does not
      // support that. Recorded in UNSOURCED_V1_FIELDS' sibling notes.

      // Only `recovery:attempt_started` carries the real provider id;
      // `recovery:succeeded` hardcodes agentId to 'adapter-recovery'.
      this.eventBus.on('recovery:attempt_started', (event) => {
        this.tallyFor(event.agentId).retryCount += 1
      }),
    )
  }

  /** Unsubscribe from the bus and drop all retained run state. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.length = 0
    this.runProviders.clear()
    this.started = false
  }

  /** Providers with at least one observed event, in first-seen order. */
  getProviderIds(): string[] {
    return [...this.tallies.keys()]
  }

  /** Contract row for one provider, or `null` if nothing was observed for it. */
  getProjection(providerId: string): AdapterMonitorDashboardContract | null {
    const tally = this.tallies.get(providerId)
    if (tally === undefined) return null
    return this.project(providerId, tally)
  }

  /** Contract rows for every observed provider. */
  getAllProjections(): AdapterMonitorDashboardContract[] {
    return [...this.tallies.entries()].map(([providerId, tally]) =>
      this.project(providerId, tally),
    )
  }

  /** Subscriber diagnostics — not part of the dashboard contract. */
  getStats(): DashboardProjectionStats {
    return {
      droppedUnattributed: this.droppedUnattributed,
      openRuns: this.runProviders.size,
    }
  }

  private project(
    providerId: string,
    tally: ProviderTally,
  ): AdapterMonitorDashboardContract {
    const terminalCount = tally.completedCount + tally.failedCount

    return {
      providerId,
      // Catalog calls this `monitorIntrospection`; the contract calls it
      // `monitorTier`. Same union, different name.
      monitorTier: getProviderCapabilities(providerId)?.monitorIntrospection ?? 'none',
      // The subscriber does not own a watcher; watcher state belongs to
      // ArtifactWatcherHost, which is per-adapter-instance rather than global.
      watcherState: 'not_configured',
      rawEventCount: null,
      normalizedEventCount: null,
      artifactCount: null,
      toolCallCount: tally.toolCallCount,
      approvalPromptCount: tally.approvalPromptCount,
      mcpToolUsageCount: null,
      mcpMode: null,
      costMicros: tally.costMicros,
      totalTokens: tally.totalTokens,
      retryCount: tally.retryCount,
      fallbackCount: null,
      // A ratio over zero terminal events is undefined, not 1.0 — reporting a
      // perfect success rate for a provider that has never finished a run is
      // the phantom-green failure this contract exists to prevent.
      successRate: terminalCount === 0 ? null : tally.completedCount / terminalCount,
    }
  }

  private recordUsage(
    tally: ProviderTally,
    usage: { inputTokens?: number; outputTokens?: number; costCents?: number } | undefined,
  ): void {
    if (usage === undefined) return

    if (typeof usage.costCents === 'number') {
      tally.costMicros = (tally.costMicros ?? 0) + usage.costCents * MICROS_PER_CENT
    }

    // Only count tokens the provider actually reported. An absent field stays
    // absent rather than contributing a zero.
    const hasInput = typeof usage.inputTokens === 'number'
    const hasOutput = typeof usage.outputTokens === 'number'
    if (hasInput || hasOutput) {
      const reported = (hasInput ? usage.inputTokens! : 0) + (hasOutput ? usage.outputTokens! : 0)
      tally.totalTokens = (tally.totalTokens ?? 0) + reported
    }
  }

  private tallyFor(providerId: string): ProviderTally {
    let tally = this.tallies.get(providerId)
    if (tally === undefined) {
      tally = emptyTally()
      this.tallies.set(providerId, tally)
    }
    return tally
  }

  private rememberRun(runId: string, providerId: string): void {
    // Bound the map so a stream of runs missing terminal events cannot grow it
    // without limit. Insertion order makes the oldest key the first one.
    if (this.runProviders.size >= this.maxTrackedRuns) {
      const oldest = this.runProviders.keys().next()
      if (!oldest.done) this.runProviders.delete(oldest.value)
    }
    this.runProviders.set(runId, providerId)
  }

  private lookupRun(runId: string | undefined): string | undefined {
    if (runId === undefined) return undefined
    return this.runProviders.get(runId)
  }

  /** Returns the provider id, or `null` after recording an unattributed drop. */
  private resolveRunProvider(providerId: string | undefined): string | null {
    if (providerId === undefined) {
      this.droppedUnattributed += 1
      return null
    }
    return providerId
  }
}

/** Convenience: construct, start, and return the subscriber. */
export function createDashboardProjectionSubscriber(
  eventBus: DzupEventBus,
  options?: DashboardProjectionSubscriberOptions,
): DashboardProjectionSubscriber {
  const subscriber = new DashboardProjectionSubscriber(eventBus, options)
  subscriber.start()
  return subscriber
}

/** Re-exported for consumers narrowing bus events alongside this subscriber. */
export type { DzupEvent }
