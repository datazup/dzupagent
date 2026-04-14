import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

export interface BatchConfig {
  /** Event type prefixes that should always be emitted immediately */
  immediatePatterns?: string[] | undefined
  /** Max batch size before flush. Default: 20 */
  maxBatchSize?: number | undefined
  /** Max delay before flush in ms. Default: 100 */
  maxDelayMs?: number | undefined
}

/** Default events that bypass batching (critical lifecycle events) */
const DEFAULT_IMMEDIATE = [
  'agent:started',
  'agent:completed',
  'agent:failed',
  'approval:requested',
  'approval:granted',
  'approval:rejected',
  'budget:exceeded',
  'recovery:',
]

/**
 * Wraps a DzupEventBus to batch non-critical events.
 * Critical events (agent lifecycle, approvals, budget) are emitted immediately.
 * Non-critical events are batched and flushed on timer or batch size threshold.
 */
export class BatchedEventEmitter {
  private queue: DzupEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly immediatePatterns: string[]
  private readonly maxBatchSize: number
  private readonly maxDelayMs: number

  constructor(
    private readonly bus: DzupEventBus,
    config?: Partial<BatchConfig>,
  ) {
    this.immediatePatterns = config?.immediatePatterns ?? DEFAULT_IMMEDIATE
    this.maxBatchSize = config?.maxBatchSize ?? 20
    this.maxDelayMs = config?.maxDelayMs ?? 100
  }

  /** Emit an event (immediately if critical, batched otherwise) */
  emit(event: DzupEvent): void {
    if (this.isImmediate(event)) {
      this.bus.emit(event)
      return
    }
    this.queue.push(event)
    if (this.queue.length >= this.maxBatchSize) {
      this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  /** Flush all queued events immediately */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    const batch = this.queue.splice(0)
    for (const event of batch) {
      this.bus.emit(event)
    }
  }

  /** Cleanup: flush remaining events and stop timer */
  dispose(): void {
    this.flush()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  /** Number of events currently queued */
  get queueSize(): number {
    return this.queue.length
  }

  private isImmediate(event: DzupEvent): boolean {
    const type = event.type
    return this.immediatePatterns.some(p => type === p || type.startsWith(p))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, this.maxDelayMs)
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref()
    }
  }
}
