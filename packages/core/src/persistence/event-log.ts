/**
 * Event-sourced run history for debugging and replay.
 *
 * - `RunEvent` captures every meaningful event during a run
 * - `EventLogStore` is the abstract interface; `InMemoryEventLog` is the dev/test impl
 * - `EventLogSink` auto-captures DzipEventBus events into a log
 */

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

export class InMemoryEventLog implements EventLogStore {
  private events: Map<string, RunEvent[]> = new Map()
  private seqCounters: Map<string, number> = new Map()

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
    }
    list.push(full)
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
  }
}

// ---------------------------------------------------------------------------
// Event bus sink — auto-records DzipEventBus events into an EventLogStore
// ---------------------------------------------------------------------------

/** Minimal event bus contract for the sink (avoids tight coupling to DzipEventBus). */
interface EventBusLike {
  onAny: (handler: (event: { type: string; [key: string]: unknown }) => void) => () => void
}

/**
 * Listens to a DzipEventBus and auto-appends every event to an EventLogStore.
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
