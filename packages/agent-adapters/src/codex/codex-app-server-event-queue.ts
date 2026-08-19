import { CodexAppServerClientError } from './codex-app-server-client-contracts.js'

/**
 * Bounded single-consumer queue bridging pushed frames to an async iterator.
 *
 * The bound only applies to *buffered* values: a waiting consumer is handed the
 * value directly, so a caller that keeps up is never throttled. Overflow is
 * reported to the owner rather than dropped, because silently discarding an
 * event would desynchronise the caller from the provider's turn state.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void
    readonly reject: (error: Error) => void
  }> = []
  private closed = false
  private terminalError: Error | undefined

  constructor(
    private readonly maxValues: number,
    private readonly onOverflow: (error: CodexAppServerClientError) => void,
  ) {}

  push(value: T): void {
    if (this.closed || this.terminalError) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }
    if (this.values.length >= this.maxValues) {
      this.onOverflow(new CodexAppServerClientError(
        'CODEX_APP_SERVER_OUTPUT_LIMIT',
        'Codex app-server event queue exceeded its limit',
      ))
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.splice(0)
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.terminalError) return
    this.terminalError = error
    this.values.splice(0)
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.terminalError) return Promise.reject(this.terminalError)
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}
