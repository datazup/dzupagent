/**
 * W13-14: SSE backpressure — onBufferSaturation supplemental tests
 *
 * Covers angles not already in sse-streaming-adapter.test.ts:
 * - Interaction with runTimeoutMs (both options active simultaneously)
 * - Extremely small maxBufferBytes (= 1)
 * - bufferedBytes correctly decremented after writeSSE resolves
 * - Saturation fires only once when synchronous events fill the window simultaneously
 * - onBufferSaturation is not called when the option is explicitly undefined
 * - Saturation state is independent between separate streamRunHandleToSSE calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamingRunHandle } from '@dzupagent/agent'
import { streamRunHandleToSSE } from '../streaming/sse-streaming-adapter.js'
import type { SSEStreamLike } from '../streaming/sse-streaming-adapter.js'

/** Create a mock SSE stream that records writes. */
function createMockStream(): SSEStreamLike & {
  written: Array<{ data: string; event?: string }>
  abortCallbacks: Array<() => void>
  triggerAbort: () => void
} {
  const written: Array<{ data: string; event?: string }> = []
  const abortCallbacks: Array<() => void> = []
  return {
    written,
    abortCallbacks,
    async writeSSE(msg) {
      written.push(msg)
    },
    onAbort(cb) {
      abortCallbacks.push(cb)
    },
    triggerAbort() {
      for (const cb of abortCallbacks) cb()
    },
  }
}

describe('streamRunHandleToSSE — onBufferSaturation supplemental', () => {
  let handle: StreamingRunHandle
  let stream: ReturnType<typeof createMockStream>

  beforeEach(() => {
    vi.useFakeTimers()
    handle = new StreamingRunHandle({ maxBufferSize: 200 })
    stream = createMockStream()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('works correctly when both onBufferSaturation and runTimeoutMs are set', async () => {
    const saturationCb = vi.fn()

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      runTimeoutMs: 5000,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    // Push a large event that triggers saturation (before timeout)
    handle.push({ type: 'text_delta', content: 'A'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    expect(saturationCb).toHaveBeenCalledTimes(1)

    // Complete normally before timeout fires
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    expect(handle.status).toBe('completed')
  })

  it('does not fire when maxBufferBytes is 1 and event is 0 bytes (impossible case guard)', async () => {
    // A done event with empty finalOutput serialized as: {"type":"done","finalOutput":""}
    // which is > 1 byte, so ratio > 1.0 > 0.8, and the callback SHOULD fire.
    const saturationCb = vi.fn()
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 1,
    })

    // With maxBufferBytes=1, any non-empty event will have ratio >> 0.8
    expect(saturationCb).toHaveBeenCalled()
    const ratio = saturationCb.mock.calls[0]![0] as number
    expect(ratio).toBeGreaterThan(0.8)
  })

  it('saturation state resets between separate streamRunHandleToSSE calls', async () => {
    const saturationCb = vi.fn()

    // First call — fires once
    handle.push({ type: 'text_delta', content: 'B'.repeat(100) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    expect(saturationCb).toHaveBeenCalledTimes(1)

    // Second independent call — a fresh invocation should fire independently
    const handle2 = new StreamingRunHandle({ maxBufferSize: 200 })
    const stream2 = createMockStream()
    saturationCb.mockClear()

    handle2.push({ type: 'text_delta', content: 'C'.repeat(100) })
    handle2.push({ type: 'done', finalOutput: '' })
    handle2.complete()

    await streamRunHandleToSSE(handle2, stream2, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    // The second call has its own debounce state — should fire again
    expect(saturationCb).toHaveBeenCalledTimes(1)
  })

  it('does not fire when onBufferSaturation is explicitly undefined', async () => {
    // Push a large event — no callback provided at all
    handle.push({ type: 'text_delta', content: 'D'.repeat(500) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    // Should not throw even with maxBufferBytes so small everything triggers
    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: undefined,
      maxBufferBytes: 1,
    })

    // Verify events were still written
    expect(stream.written).toHaveLength(2)
  })

  it('bufferedBytes decrements after writeSSE — non-saturating second event after large first', async () => {
    const saturationCb = vi.fn()

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    // First large event triggers saturation (ratio > 0.8)
    handle.push({ type: 'text_delta', content: 'E'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)
    expect(saturationCb).toHaveBeenCalledTimes(1)

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(500)

    // Second tiny event — after the first write drained, bufferedBytes = 0.
    // The tiny event adds ~30 bytes. With maxBufferBytes=50, ratio < 0.8.
    // So saturation should NOT fire for this event.
    handle.push({ type: 'text_delta', content: 'x' })
    await vi.advanceTimersByTimeAsync(1)

    // Still only 1 saturation call (tiny event did not trigger)
    expect(saturationCb).toHaveBeenCalledTimes(1)

    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })

  it('fires when first of several synchronous events exceeds threshold (debounce blocks rest)', async () => {
    const saturationCb = vi.fn()

    // All pushed synchronously at the same fake-time tick
    for (let i = 0; i < 8; i++) {
      handle.push({ type: 'text_delta', content: 'F'.repeat(100) })
    }
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    // All events processed without any fake timer advance — all at same timestamp.
    // Debounce means only the first crossing fires the callback.
    expect(saturationCb).toHaveBeenCalledTimes(1)
  })

  it('keepAliveIntervalMs: 0 does not suppress onBufferSaturation callbacks', async () => {
    const saturationCb = vi.fn()

    handle.push({ type: 'text_delta', content: 'G'.repeat(200) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,    // no ping timer
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    // keepAliveIntervalMs=0 disables ping but must not suppress saturation
    expect(saturationCb).toHaveBeenCalled()
    expect(stream.written.some((w) => w.event === 'ping')).toBe(false)
  })

  it('fillRatio is passed to callback and is > 0 on every call', async () => {
    const ratios: number[] = []
    const saturationCb = vi.fn((ratio: number) => { ratios.push(ratio) })

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: saturationCb,
      maxBufferBytes: 50,
    })

    handle.push({ type: 'text_delta', content: 'H'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(500) // past debounce

    handle.push({ type: 'text_delta', content: 'I'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    expect(ratios.length).toBe(2)
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(0)
      expect(ratio).toBeGreaterThan(0.8)
    }
  })
})
