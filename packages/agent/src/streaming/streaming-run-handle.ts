/**
 * StreamingRunHandle — wraps a running agent execution and exposes
 * an async iterable of StreamEvent objects for real-time consumption.
 *
 * This is the bridge between the agent's internal event production
 * (tool loop, LLM streaming) and external consumers (SSE transport,
 * playground UI, orchestrators).
 *
 * Usage:
 * ```typescript
 * const handle = new StreamingRunHandle();
 *
 * // Consumer side (e.g., SSE handler)
 * for await (const event of handle.events()) {
 *   sseWriter.write(event);
 * }
 *
 * // Producer side (e.g., agent runner)
 * handle.push({ type: 'text_delta', content: 'Hello' });
 * handle.push({ type: 'done', finalOutput: 'Hello world' });
 * handle.complete();
 * ```
 */
import type { StreamEvent } from './streaming-types.js'

/** Run status for a streaming execution. */
export type StreamingStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface StreamingRunHandleOptions {
  /** Maximum number of events to buffer before the consumer reads them (default: 1000). */
  maxBufferSize?: number
}

/**
 * A handle that provides an async iterable of stream events from a running agent.
 *
 * The producer pushes events via `push()` and signals completion via `complete()`,
 * `fail()`, or `cancel()`. The consumer reads events via `events()`.
 */
export class StreamingRunHandle {
  private _status: StreamingStatus = 'running'
  private readonly eventQueue: StreamEvent[] = []
  private readonly maxBuffer: number
  private waiter: {
    resolve: (value: IteratorResult<StreamEvent>) => void
  } | null = null

  constructor(options?: StreamingRunHandleOptions) {
    this.maxBuffer = options?.maxBufferSize ?? 1000
  }

  /** Current status of the streaming run. */
  get status(): StreamingStatus {
    return this._status
  }

  /**
   * Push a stream event to consumers.
   * Events are buffered if no consumer is currently awaiting.
   *
   * @throws {Error} if the handle is already in a terminal state
   */
  push(event: StreamEvent): void {
    if (this._status !== 'running') {
      throw new Error(`Cannot push events to a ${this._status} stream`)
    }

    // If a consumer is waiting, deliver directly
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: event, done: false })
      return
    }

    // Otherwise buffer (with overflow protection)
    if (this.eventQueue.length < this.maxBuffer) {
      this.eventQueue.push(event)
    }
    // Events beyond maxBuffer are silently dropped to prevent memory leaks
  }

  /**
   * Signal that the stream completed successfully.
   * After calling this, the async iterable will drain remaining buffered
   * events and then terminate.
   */
  complete(): void {
    if (this._status !== 'running') return
    this._status = 'completed'
    this.resolveWaiter()
  }

  /**
   * Signal that the stream failed with an error.
   * Pushes an error event and terminates the stream.
   */
  fail(error: Error): void {
    if (this._status !== 'running') return
    // Push the error event before transitioning to terminal state
    const errorEvent: StreamEvent = { type: 'error', error }
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: errorEvent, done: false })
    } else if (this.eventQueue.length < this.maxBuffer) {
      this.eventQueue.push(errorEvent)
    }
    this._status = 'failed'
    this.resolveWaiter()
  }

  /**
   * Signal that the stream was cancelled.
   */
  cancel(): void {
    if (this._status !== 'running') return
    this._status = 'cancelled'
    this.resolveWaiter()
  }

  /**
   * Returns an async iterable of StreamEvent objects.
   *
   * Yields buffered events first, then waits for new events from the producer.
   * Terminates when the handle reaches a terminal state and all buffered
   * events have been consumed.
   */
  events(): AsyncIterable<StreamEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
        return {
          next: (): Promise<IteratorResult<StreamEvent>> => {
            // Drain buffered events first
            if (this.eventQueue.length > 0) {
              const event = this.eventQueue.shift()!
              return Promise.resolve({ value: event, done: false })
            }

            // If terminal and no more buffered events, we are done
            if (this._status !== 'running') {
              return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true })
            }

            // Wait for the next event from the producer
            return new Promise<IteratorResult<StreamEvent>>((resolve) => {
              this.waiter = { resolve }
            })
          },
        }
      },
    }
  }

  /** Resolve a pending waiter with done=true (used when transitioning to terminal). */
  private resolveWaiter(): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      // Don't signal done yet if there are buffered events — the consumer's
      // next() call will drain them first, then see terminal status.
      if (this.eventQueue.length === 0) {
        w.resolve({ value: undefined as unknown as StreamEvent, done: true })
      }
      // If there are buffered events, the waiter should never be set
      // (the queue drain path handles it), so this branch is defensive.
    }
  }
}
