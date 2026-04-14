/**
 * Event-sourced run history for debugging and replay.
 *
 * - `RunEvent` captures every meaningful event during a run
 * - `EventLogStore` is the abstract interface; `InMemoryEventLog` is the dev/test impl
 * - `EventLogSink` auto-captures DzupEventBus events into a log
 */

import { defaultLogger, type FrameworkLogger } from '../utils/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunEvent {
  runId: string
  seq: number
  timestamp: number
  type: string
  payload: Record<string, unknown>
}

export interface EventLogStore {
  /** Append an event to the log. */
  append(event: Omit<RunEvent, 'seq' | 'timestamp'>): Promise<RunEvent>
  /** Get all events for a run, ordered by seq. */
  getEvents(runId: string): Promise<RunEvent[]>
  /** Get events after a specific sequence number (for incremental replay). */
  getEventsSince(runId: string, afterSeq: number): Promise<RunEvent[]>
  /** Get the latest event for a run. */
  getLatest(runId: string): Promise<RunEvent | null>
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export interface InMemoryEventLogOptions {
  /** Maximum number of runs retained in memory (default: 10_000). Use `Infinity` to opt out. */
  maxRuns?: number
  /** Maximum number of events retained per run (default: 5_000). Use `Infinity` to opt out. */
  maxEventsPerRun?: number
}

const DEFAULT_MAX_EVENT_LOG_RUNS = 10_000
const DEFAULT_MAX_EVENTS_PER_RUN = 5_000

function attachRetentionMetadata(
  target: object,
  limits: { maxRuns: number; maxEventsPerRun: number },
  explicitUnbounded: boolean,
): void {
  Object.defineProperty(target, '__dzupagentRetention', {
    value: {
      ...limits,
      explicitUnbounded,
    },
    configurable: true,
    enumerable: false,
    writable: true,
  })
}

const logger: FrameworkLogger = defaultLogger

function warnIfExplicitlyUnbounded(limitName: string): void {
  logger.warn(
    `[InMemoryEventLog] ${limitName} is configured as unbounded. ` +
      'This is intended for explicit development/test opt-out only.',
  )
}

export class InMemoryEventLog implements EventLogStore {
  private events: Map<string, RunEvent[]> = new Map()
  private seqCounters: Map<string, number> = new Map()
  private readonly runOrder: string[] = []
  private readonly maxRuns: number
  private readonly maxEventsPerRun: number

  constructor(options?: InMemoryEventLogOptions) {
    if (options?.maxRuns === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxRuns')
    }
    if (options?.maxEventsPerRun === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxEventsPerRun')
    }

    this.maxRuns = options?.maxRuns ?? DEFAULT_MAX_EVENT_LOG_RUNS
    this.maxEventsPerRun = options?.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN
    attachRetentionMetadata(this, this.getRetentionLimits(), Boolean(
      options?.maxRuns === Number.POSITIVE_INFINITY ||
      options?.maxEventsPerRun === Number.POSITIVE_INFINITY,
    ))
  }

  getRetentionLimits(): { maxRuns: number; maxEventsPerRun: number } {
    return {
      maxRuns: this.maxRuns,
      maxEventsPerRun: this.maxEventsPerRun,
    }
  }

  async append(event: Omit<RunEvent, 'seq' | 'timestamp'>): Promise<RunEvent> {
    const { runId, type, payload } = event
    const nextSeq = (this.seqCounters.get(runId) ?? 0) + 1
    this.seqCounters.set(runId, nextSeq)

    const full: RunEvent = {
      runId,
      seq: nextSeq,
      timestamp: Date.now(),
      type,
      payload,
    }

    let list = this.events.get(runId)
    if (!list) {
      list = []
      this.events.set(runId, list)
      this.runOrder.push(runId)
      this.enforceRunLimit()
    }
    list.push(full)
    this.enforcePerRunLimit(runId, list)
    return full
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    return [...(this.events.get(runId) ?? [])]
  }

  async getEventsSince(runId: string, afterSeq: number): Promise<RunEvent[]> {
    const all = this.events.get(runId) ?? []
    return all.filter((e) => e.seq > afterSeq)
  }

  async getLatest(runId: string): Promise<RunEvent | null> {
    const all = this.events.get(runId)
    if (!all || all.length === 0) return null
    return all[all.length - 1]!
  }

  /** Get total event count across all runs. */
  get totalEvents(): number {
    let count = 0
    for (const list of this.events.values()) {
      count += list.length
    }
    return count
  }

  /** Clear all events (for testing). */
  clear(): void {
    this.events.clear()
    this.seqCounters.clear()
    this.runOrder.length = 0
  }

  private enforceRunLimit(): void {
    if (!Number.isFinite(this.maxRuns)) return
    while (this.runOrder.length > this.maxRuns) {
      const evictedRunId = this.runOrder.shift()
      if (!evictedRunId) break
      this.events.delete(evictedRunId)
      this.seqCounters.delete(evictedRunId)
    }
  }

  private enforcePerRunLimit(runId: string, events: RunEvent[]): void {
    if (!Number.isFinite(this.maxEventsPerRun)) return
    const overflow = events.length - this.maxEventsPerRun
    if (overflow <= 0) return
    events.splice(0, overflow)
    // Keep run order stable; no-op when runId missing due external mutation.
    if (!this.runOrder.includes(runId)) {
      this.runOrder.push(runId)
    }
  }
}

// ---------------------------------------------------------------------------
// Event bus sink — auto-records DzupEventBus events into an EventLogStore
// ---------------------------------------------------------------------------

/** Minimal event bus contract for the sink (avoids tight coupling to DzupEventBus). */
interface EventBusLike {
  onAny: (handler: (event: { type: string; [key: string]: unknown }) => void) => () => void
}

/**
 * Listens to a DzupEventBus and auto-appends every event to an EventLogStore.
 */
export class EventLogSink {
  constructor(private readonly log: EventLogStore) {}

  /**
   * Start capturing events from the bus for a specific run.
   * Returns an unsubscribe function to stop capturing.
   */
  attach(eventBus: EventBusLike, runId: string): () => void {
    return eventBus.onAny((event) => {
      const { type, ...rest } = event
      // Fire-and-forget; errors are silently swallowed to keep non-fatal
      void this.log.append({ runId, type, payload: rest as Record<string, unknown> })
    })
  }
}
