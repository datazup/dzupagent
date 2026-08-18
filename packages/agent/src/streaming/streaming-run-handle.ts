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

type TerminalStreamEvent = Extract<StreamEvent, { type: 'done' | 'error' }>
type OrdinaryStreamEvent = Exclude<StreamEvent, TerminalStreamEvent>

class StreamBufferOverflowError extends Error {
  constructor() {
    super('stream_buffer_overflow')
    this.name = 'StreamBufferOverflowError'
  }
}

function isTerminalEvent(event: StreamEvent): event is TerminalStreamEvent {
  return event.type === 'done' || event.type === 'error'
}

export interface StreamingRunHandleOptions {
  /** Maximum ordinary events to buffer; one terminal slot is reserved separately (default: 1000). */
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
  private readonly eventQueue: OrdinaryStreamEvent[] = []
  private readonly maxBuffer: number
  private terminalEvent: TerminalStreamEvent | null = null
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

    if (isTerminalEvent(event)) {
      this.acceptTerminal(event, event.type === 'done' ? 'completed' : 'failed')
      return
    }

    // If a consumer is waiting, deliver directly
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: event, done: false })
      return
    }

    // maxBuffer is the exact ordinary-event capacity. Terminal events use a
    // separate reserved slot so overflow or upstream failure stays observable.
    if (this.eventQueue.length < this.maxBuffer) {
      this.eventQueue.push(event)
      return
    }

    this.acceptTerminal(
      { type: 'error', error: new StreamBufferOverflowError() },
      'failed',
    )
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
    this.acceptTerminal({ type: 'error', error }, 'failed')
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

            if (this.terminalEvent) {
              const event = this.terminalEvent
              this.terminalEvent = null
              return Promise.resolve({ value: event, done: false })
            }

            // If terminal and no more buffered events, we are done.
            // `IteratorReturnResult` allows `value: undefined`, so no cast
            // is needed — explicitly type the resolution as the return form.
            if (this._status !== 'running') {
              const result: IteratorReturnResult<undefined> = { value: undefined, done: true }
              return Promise.resolve(result)
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

  /** Reserve and expose exactly one done/error event, outside ordinary capacity. */
  private acceptTerminal(event: TerminalStreamEvent, status: 'completed' | 'failed'): void {
    this.terminalEvent = event
    this._status = status
    this.resolveWaiter()
  }

  /** Resolve a pending waiter with done=true (used when transitioning to terminal). */
  private resolveWaiter(): void {
    if (!this.waiter) return

    const w = this.waiter
    this.waiter = null
    if (this.eventQueue.length > 0) {
      w.resolve({ value: this.eventQueue.shift()!, done: false })
      return
    }
    if (this.terminalEvent) {
      const event = this.terminalEvent
      this.terminalEvent = null
      w.resolve({ value: event, done: false })
      return
    }
    if (this._status !== 'running') {
      const result: IteratorReturnResult<undefined> = { value: undefined, done: true }
      w.resolve(result)
    }
  }
}
