/**
 * CascadingTimeout — hierarchical timeout management for parent/child agents.
 *
 * Creates a tree of timeouts where:
 * - Each node has its own AbortController + deadline
 * - Parent abort cascades to all children
 * - Child abort does NOT cascade to parent
 * - Reserve time ensures parent has cleanup time after child times out
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CascadingTimeoutConfig {
  /** Total timeout in milliseconds */
  totalMs: number
  /** Reserve time for parent cleanup (default: 1000ms) */
  reserveMs?: number
}

// ---------------------------------------------------------------------------
// CascadingTimeout
// ---------------------------------------------------------------------------

export class CascadingTimeout {
  private readonly controller: AbortController
  private readonly deadline: number
  private readonly reserveMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly children: CascadingTimeout[] = []
  private parentAbortHandler: (() => void) | undefined
  private parentSignal: AbortSignal | undefined
  private disposed = false

  private constructor(
    totalMs: number,
    reserveMs: number,
    parentSignal?: AbortSignal,
  ) {
    this.controller = new AbortController()
    this.reserveMs = reserveMs

    // Compute effective deadline from now
    const effectiveMs = Math.max(0, totalMs)
    this.deadline = Date.now() + effectiveMs

    // Set up auto-abort timer
    if (effectiveMs > 0) {
      this.timer = setTimeout(() => {
        this.controller.abort('Timeout expired')
      }, effectiveMs)
      // Allow Node.js to exit even if timer is still pending
      if (typeof this.timer === 'object' && 'unref' in this.timer) {
        this.timer.unref()
      }
    } else {
      // Already expired
      this.controller.abort('Timeout expired')
    }

    // Listen for parent abort to cascade down
    if (parentSignal) {
      this.parentSignal = parentSignal
      if (parentSignal.aborted) {
        this.controller.abort('Parent timeout expired')
      } else {
        this.parentAbortHandler = () => {
          this.controller.abort('Parent timeout expired')
        }
        parentSignal.addEventListener('abort', this.parentAbortHandler, { once: true })
      }
    }
  }

  /** Create a root cascading timeout */
  static create(totalMs: number, reserveMs?: number): CascadingTimeout {
    return new CascadingTimeout(totalMs, reserveMs ?? 1000)
  }

  /**
   * Fork a child timeout with min(childMs, remaining - reserveMs) deadline.
   *
   * The child timeout is constrained by the parent's remaining time minus
   * the reserve, ensuring the parent always has cleanup time.
   */
  fork(childMs?: number): CascadingTimeout {
    const available = Math.max(0, this.remainingMs - this.reserveMs)
    const effectiveMs = childMs !== undefined
      ? Math.min(childMs, available)
      : available

    const child = new CascadingTimeout(
      effectiveMs,
      this.reserveMs,
      this.controller.signal,
    )
    this.children.push(child)
    return child
  }

  /** Get the AbortSignal for this timeout */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Get remaining time in ms */
  get remainingMs(): number {
    return Math.max(0, this.deadline - Date.now())
  }

  /** Whether this timeout has expired */
  get expired(): boolean {
    return this.controller.signal.aborted || this.remainingMs <= 0
  }

  /** Abort this timeout and all children */
  abort(reason?: string): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? 'Manually aborted')
    }
  }

  /** Clean up timers to prevent leaks */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    // Clear our own timer
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    // Remove parent abort listener
    if (this.parentSignal && this.parentAbortHandler) {
      this.parentSignal.removeEventListener('abort', this.parentAbortHandler)
      this.parentAbortHandler = undefined
      this.parentSignal = undefined
    }

    // Dispose all children
    for (const child of this.children) {
      child.dispose()
    }
    this.children.length = 0
  }
}
