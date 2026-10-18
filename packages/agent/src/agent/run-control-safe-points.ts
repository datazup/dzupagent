/**
 * Cooperative run control (B-01) — safe-point helpers for the generate tool
 * loop and the controller state behind a cooperative {@link RunHandle}.
 *
 * Only `launch(..., { controlMode: 'cooperative' })` creates a controller.
 * Without one, the loop and the handle behave exactly as the legacy path.
 * Cancel travels on the run's `AbortSignal`; pause and resume travel on the
 * {@link RunControlPort}. Acknowledgements are delivered through the handle's
 * synthetic-event path, not the run journal.
 */

import { ModelCancellationError } from './model-timeout-error.js'
import type {
  ControlAcknowledgement,
  RunControlPort,
  RunControlSafePoint,
} from './run-handle-types.js'

/**
 * Reject as soon as the run deadline (or caller cancellation) fires, instead of
 * waiting on a provider that may never settle. Resolves normally otherwise.
 */
export function raceAgainstSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new ModelCancellationError())
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ModelCancellationError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }) as Promise<T>
}

/**
 * Observe run control at one safe point. Returns `true` when the loop must
 * stop with `stopReason: 'aborted'`. A requested pause is acknowledged and
 * held until `resume()` or an abort of `signal`; the caller then continues
 * the same iteration.
 */
export async function observeRunControl(
  port: RunControlPort,
  signal: AbortSignal | undefined,
  at: RunControlSafePoint,
): Promise<boolean> {
  if (signal?.aborted) {
    port.acknowledge('cancel', at)
    return true
  }
  if (!port.shouldPause()) return false
  port.acknowledge('pause', at)
  await waitForResumeOrAbort(port, signal)
  if (signal?.aborted) {
    port.acknowledge('cancel', at)
    return true
  }
  port.acknowledge('resume', at)
  return false
}

function waitForResumeOrAbort(
  port: RunControlPort,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return port.waitForResume()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([port.waitForResume(), aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

/** Abort when either signal fires (whichever comes first). */
export function composeAbortSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): AbortSignal {
  if (!secondary) return primary
  const controller = new AbortController()
  const abort = (source: AbortSignal) => () => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
  for (const source of [primary, secondary]) {
    if (source.aborted) abort(source)()
    else source.addEventListener('abort', abort(source), { once: true })
  }
  return controller.signal
}

/** Handle-side reactions to observed controls. */
export interface CooperativeRunControlHooks {
  /** A pause was observed at a safe point (status `paused`, `run_paused`). */
  onPauseObserved(at: RunControlSafePoint): void
  /** A cancel was observed at a safe point (run ends `cancelled`). */
  onCancelObserved(): void
  /** Every acknowledgement, for delivery to handle subscribers. */
  onAcknowledgement(ack: ControlAcknowledgement): void
}

interface PendingAck {
  readonly promise: Promise<ControlAcknowledgement>
  resolve(ack: ControlAcknowledgement): void
  settled: boolean
}

function createPendingAck(): PendingAck {
  let resolve!: (ack: ControlAcknowledgement) => void
  const promise = new Promise<ControlAcknowledgement>((settle) => {
    resolve = settle
  })
  return { promise, resolve, settled: false }
}

function acknowledgement(
  kind: ControlAcknowledgement['kind'],
  state: ControlAcknowledgement['state'],
  safePoint?: RunControlSafePoint,
): ControlAcknowledgement {
  return {
    kind,
    state,
    ...(safePoint !== undefined ? { safePoint } : {}),
    at: new Date().toISOString(),
  }
}

/**
 * Controller state for a cooperative handle: the run's abort controller, the
 * pause flag, pending acknowledgements and resume waiters.
 */
export class CooperativeRunController implements RunControlPort {
  private readonly abortController = new AbortController()
  private pauseRequested = false
  private pauseObserved = false
  private pendingPause: PendingAck | undefined
  private pendingCancel: PendingAck | undefined
  private resumeWaiters: Array<() => void> = []

  constructor(private readonly hooks: CooperativeRunControlHooks) {}

  /** The run's cancel signal. */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  get cancelRequested(): boolean {
    return this.pendingCancel !== undefined
  }

  /** True while a pause is requested, timed out or observed. */
  get pausePending(): boolean {
    return this.pendingPause !== undefined
  }

  get isPauseObserved(): boolean {
    return this.pauseObserved
  }

  /**
   * Abort the run once and await the cancel acknowledgement. A repeated call
   * (e.g. after `timed-out`) re-awaits the same pending acknowledgement.
   */
  requestCancel(timeoutMs?: number): Promise<ControlAcknowledgement> {
    if (!this.pendingCancel) {
      this.pendingCancel = createPendingAck()
      this.hooks.onAcknowledgement(acknowledgement('cancel', 'requested'))
      this.abortController.abort()
      this.releaseResumeWaiters()
    }
    return this.awaitAck(this.pendingCancel, 'cancel', timeoutMs)
  }

  /** Request a pause and await its acknowledgement at the next safe point. */
  requestPause(timeoutMs?: number): Promise<ControlAcknowledgement> {
    if (!this.pendingPause) {
      this.pendingPause = createPendingAck()
      this.pauseRequested = true
      this.hooks.onAcknowledgement(acknowledgement('pause', 'requested'))
    }
    return this.awaitAck(this.pendingPause, 'pause', timeoutMs)
  }

  /**
   * Release a requested, timed-out or observed pause. A pause that was never
   * observed resolves its waiters with `requested`. Returns whether the pause
   * had been observed.
   */
  release(): boolean {
    const observed = this.pauseObserved
    if (this.pendingPause && !observed) {
      this.settle(this.pendingPause, acknowledgement('pause', 'requested'))
    }
    this.pauseRequested = false
    this.pauseObserved = false
    this.pendingPause = undefined
    this.releaseResumeWaiters()
    return observed
  }

  /**
   * The background `generate()` settled. A pending cancel counts as observed
   * (without a safe point); a pending, unobserved pause resolves `requested`.
   */
  settleRun(): void {
    if (this.pendingCancel && !this.pendingCancel.settled) {
      this.settle(this.pendingCancel, acknowledgement('cancel', 'observed-at-safe-point'))
    }
    if (this.pendingPause && !this.pendingPause.settled) {
      this.settle(this.pendingPause, acknowledgement('pause', 'requested'))
    }
  }

  // RunControlPort ------------------------------------------------------------

  shouldPause(): boolean {
    return this.pauseRequested && !this.signal.aborted
  }

  waitForResume(): Promise<void> {
    if (!this.pauseRequested || this.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve)
    })
  }

  acknowledge(kind: 'pause' | 'cancel' | 'resume', at: RunControlSafePoint): void {
    if (kind === 'cancel') {
      if (!this.pendingCancel || this.pendingCancel.settled) return
      this.settle(this.pendingCancel, acknowledgement('cancel', 'observed-at-safe-point', at))
      this.hooks.onCancelObserved()
      return
    }
    if (kind === 'pause') {
      if (!this.pauseRequested || this.pauseObserved || !this.pendingPause) return
      this.pauseObserved = true
      this.settle(this.pendingPause, acknowledgement('pause', 'observed-at-safe-point', at))
      this.hooks.onPauseObserved(at)
      return
    }
    this.hooks.onAcknowledgement(acknowledgement('resume', 'observed-at-safe-point', at))
  }

  // Private -------------------------------------------------------------------

  private settle(pending: PendingAck, ack: ControlAcknowledgement): void {
    if (pending.settled) return
    pending.settled = true
    pending.resolve(ack)
    this.hooks.onAcknowledgement(ack)
  }

  private awaitAck(
    pending: PendingAck,
    kind: ControlAcknowledgement['kind'],
    timeoutMs: number | undefined,
  ): Promise<ControlAcknowledgement> {
    if (timeoutMs === undefined || pending.settled) return pending.promise
    return new Promise<ControlAcknowledgement>((resolve) => {
      const timer = setTimeout(() => {
        const ack = acknowledgement(kind, 'timed-out')
        this.hooks.onAcknowledgement(ack)
        resolve(ack)
      }, timeoutMs)
      void pending.promise.then((ack) => {
        clearTimeout(timer)
        resolve(ack)
      })
    })
  }

  private releaseResumeWaiters(): void {
    const waiters = this.resumeWaiters
    this.resumeWaiters = []
    for (const resolve of waiters) resolve()
  }
}
