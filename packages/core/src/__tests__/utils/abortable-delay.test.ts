import { describe, expect, it } from 'vitest'
import { delay } from '../../utils/abortable-delay.js'

/**
 * Best-effort listener counter that works on Node's `AbortController` /
 * `AbortSignal`. Node exposes `eventEmitter.listenerCount` semantics on the
 * underlying EventTarget via `getEventListeners`/`eventEmitter` only in
 * specific runtimes; we fall back to instrumenting via a wrapping
 * `addEventListener` proxy when the runtime does not expose internals.
 */
function makeCountingSignal(): { signal: AbortSignal; count: () => number; abort: () => void } {
  const ctrl = new AbortController()
  let attached = 0
  const origAdd = ctrl.signal.addEventListener.bind(ctrl.signal)
  const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal)
  ctrl.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean) => {
    if (type === 'abort') attached++
    return origAdd(type, listener, opts)
  }) as typeof ctrl.signal.addEventListener
  ctrl.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, opts?: EventListenerOptions | boolean) => {
    if (type === 'abort') attached--
    return origRemove(type, listener, opts)
  }) as typeof ctrl.signal.removeEventListener
  return {
    signal: ctrl.signal,
    count: () => attached,
    abort: () => ctrl.abort(),
  }
}

describe('delay (abortable-delay)', () => {
  it('resolves after the requested duration', async () => {
    const start = Date.now()
    await delay(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })

  it('resolves immediately when signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    await delay(1_000, ctrl.signal)
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('resolves early when signal aborts mid-flight', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10)
    const start = Date.now()
    await delay(5_000, ctrl.signal)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('does NOT accumulate abort listeners across many invocations on the same signal', async () => {
    const tracker = makeCountingSignal()
    // Run many short delays back-to-back; without listener cleanup the
    // count would grow to 1000+. With cleanup it should stay at most 1
    // (transiently, while a delay is in flight).
    for (let i = 0; i < 1000; i++) {
      await delay(0, tracker.signal)
    }
    expect(tracker.count()).toBe(0)
  })
})
