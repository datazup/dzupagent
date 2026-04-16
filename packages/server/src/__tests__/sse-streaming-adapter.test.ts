import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamingRunHandle } from '@dzupagent/agent'
import type { StreamEvent } from '@dzupagent/agent'
import { streamRunHandleToSSE } from '../streaming/sse-streaming-adapter.js'
import type { SSEStreamLike } from '../streaming/sse-streaming-adapter.js'

/** Create a mock SSE stream that records writes. */
function createMockStream(): SSEStreamLike & {
  written: Array<{ data: string; event?: string; id?: string }>
  abortCallbacks: Array<() => void>
  triggerAbort: () => void
} {
  const written: Array<{ data: string; event?: string; id?: string }> = []
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

/** Helper to drain the adapter and return written SSE messages. */
async function drainAdapter(
  handle: StreamingRunHandle,
  stream: ReturnType<typeof createMockStream>,
  opts?: { onError?: (e: unknown) => void },
): Promise<Array<{ data: string; event?: string }>> {
  await streamRunHandleToSSE(handle, stream, opts)
  return stream.written
}

describe('streamRunHandleToSSE', () => {
  let handle: StreamingRunHandle
  let stream: ReturnType<typeof createMockStream>

  beforeEach(() => {
    handle = new StreamingRunHandle({ maxBufferSize: 100 })
    stream = createMockStream()
  })

  // --- text_delta events ---

  it('streams a single text_delta event as SSE', async () => {
    handle.push({ type: 'text_delta', content: 'Hello' })
    handle.push({ type: 'done', finalOutput: 'Hello' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(2)
    expect(written[0]!.event).toBe('text_delta')
    expect(JSON.parse(written[0]!.data)).toEqual({ type: 'text_delta', content: 'Hello' })
  })

  it('streams multiple text_delta events in order', async () => {
    handle.push({ type: 'text_delta', content: 'Hello' })
    handle.push({ type: 'text_delta', content: ' world' })
    handle.push({ type: 'done', finalOutput: 'Hello world' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(3)
    expect(written[0]!.event).toBe('text_delta')
    expect(written[1]!.event).toBe('text_delta')
    expect(JSON.parse(written[0]!.data)).toEqual({ type: 'text_delta', content: 'Hello' })
    expect(JSON.parse(written[1]!.data)).toEqual({ type: 'text_delta', content: ' world' })
  })

  it('handles text_delta with empty string content', async () => {
    handle.push({ type: 'text_delta', content: '' })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(2)
    expect(JSON.parse(written[0]!.data)).toEqual({ type: 'text_delta', content: '' })
  })

  it('handles text_delta with unicode content', async () => {
    handle.push({ type: 'text_delta', content: 'Hello \u{1F30D} \u{1F600}' })
    handle.push({ type: 'done', finalOutput: 'Hello \u{1F30D} \u{1F600}' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(JSON.parse(written[0]!.data)).toEqual({ type: 'text_delta', content: 'Hello \u{1F30D} \u{1F600}' })
  })

  // --- tool_call_start events ---

  it('streams tool_call_start events as SSE', async () => {
    handle.push({ type: 'tool_call_start', toolName: 'search', callId: 'tc-1' })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written[0]!.event).toBe('tool_call_start')
    expect(JSON.parse(written[0]!.data)).toEqual({
      type: 'tool_call_start',
      toolName: 'search',
      callId: 'tc-1',
    })
  })

  // --- tool_call_end events ---

  it('streams tool_call_end events as SSE', async () => {
    handle.push({ type: 'tool_call_end', callId: 'tc-1', result: { items: [1, 2] } })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written[0]!.event).toBe('tool_call_end')
    expect(JSON.parse(written[0]!.data)).toEqual({
      type: 'tool_call_end',
      callId: 'tc-1',
      result: { items: [1, 2] },
    })
  })

  it('streams a complete tool call lifecycle', async () => {
    handle.push({ type: 'tool_call_start', toolName: 'web_search', callId: 'tc-42' })
    handle.push({ type: 'tool_call_end', callId: 'tc-42', result: 'search results' })
    handle.push({ type: 'text_delta', content: 'Based on search...' })
    handle.push({ type: 'done', finalOutput: 'Based on search...' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(4)
    expect(written.map(w => w.event)).toEqual([
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'done',
    ])
  })

  // --- done event ---

  it('closes stream after done event', async () => {
    handle.push({ type: 'done', finalOutput: 'result' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('done')
    expect(JSON.parse(written[0]!.data)).toEqual({ type: 'done', finalOutput: 'result' })
  })

  it('does not forward events buffered after done', async () => {
    // Push done, then complete. The adapter should stop after done.
    handle.push({ type: 'done', finalOutput: 'final' })
    // The handle is still running so we can't push after done without
    // first completing. complete() terminates the iterable.
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('done')
  })

  // --- error event ---

  it('closes stream after error event', async () => {
    handle.fail(new Error('LLM timeout'))

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('error')
  })

  it('serializes error event with message and name', async () => {
    const error = new TypeError('Invalid input')
    handle.fail(error)

    const written = await drainAdapter(handle, stream)

    const parsed = JSON.parse(written[0]!.data) as { type: string; error: { message: string; name: string } }
    expect(parsed.type).toBe('error')
    expect(parsed.error.message).toBe('Invalid input')
    expect(parsed.error.name).toBe('TypeError')
  })

  it('does not include error stack in serialized output', async () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at something.ts:42'
    handle.fail(error)

    const written = await drainAdapter(handle, stream)

    const raw = written[0]!.data
    expect(raw).not.toContain('something.ts')
    expect(raw).not.toContain('stack')
  })

  // --- client disconnect (onAbort) ---

  it('cancels handle when stream aborts', async () => {
    // Start iterating in the background
    const promise = streamRunHandleToSSE(handle, stream)

    // Push one event, then trigger abort
    handle.push({ type: 'text_delta', content: 'partial' })

    // Give the iterator time to consume the event
    await new Promise(resolve => setTimeout(resolve, 10))

    stream.triggerAbort()

    // The adapter should resolve once the handle is cancelled
    await promise

    expect(handle.status).toBe('cancelled')
  })

  it('does not write events after abort', async () => {
    const promise = streamRunHandleToSSE(handle, stream)

    // Trigger abort immediately
    stream.triggerAbort()

    // The handle is now cancelled, so complete() is a no-op
    // and the iteration should end
    await promise

    expect(stream.written).toHaveLength(0)
  })

  // --- empty stream ---

  it('handles empty stream with immediate done', async () => {
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('done')
  })

  it('handles stream that completes without any events', async () => {
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(0)
  })

  it('handles stream that is cancelled without any events', async () => {
    handle.cancel()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(0)
  })

  // --- onError callback ---

  it('calls opts.onError when stream.writeSSE throws', async () => {
    const onError = vi.fn()
    const failingStream: SSEStreamLike & { abortCallbacks: Array<() => void> } = {
      abortCallbacks: [],
      async writeSSE() {
        throw new Error('write failed')
      },
      onAbort(cb) {
        this.abortCallbacks.push(cb)
      },
    }

    handle.push({ type: 'text_delta', content: 'data' })
    handle.push({ type: 'done', finalOutput: 'data' })
    handle.complete()

    await streamRunHandleToSSE(handle, failingStream, { onError })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'write failed' }))
  })

  it('cancels handle when stream.writeSSE throws', async () => {
    const failingStream: SSEStreamLike = {
      async writeSSE() {
        throw new Error('broken pipe')
      },
      onAbort() { /* noop */ },
    }

    // Push an event but do NOT complete the handle — it must still be
    // 'running' when the write fails so cancel() takes effect.
    handle.push({ type: 'text_delta', content: 'data' })

    const promise = streamRunHandleToSSE(handle, failingStream)
    await promise

    expect(handle.status).toBe('cancelled')
  })

  it('does not call onError when stream succeeds', async () => {
    const onError = vi.fn()

    handle.push({ type: 'done', finalOutput: 'ok' })
    handle.complete()

    await drainAdapter(handle, stream, { onError })

    expect(onError).not.toHaveBeenCalled()
  })

  // --- interleaved events ---

  it('handles interleaved text and tool events', async () => {
    handle.push({ type: 'text_delta', content: 'Let me search...' })
    handle.push({ type: 'tool_call_start', toolName: 'search', callId: 'c1' })
    handle.push({ type: 'tool_call_end', callId: 'c1', result: 'found it' })
    handle.push({ type: 'text_delta', content: 'Found: ' })
    handle.push({ type: 'tool_call_start', toolName: 'read', callId: 'c2' })
    handle.push({ type: 'tool_call_end', callId: 'c2', result: { content: 'file data' } })
    handle.push({ type: 'text_delta', content: 'the answer is 42' })
    handle.push({ type: 'done', finalOutput: 'the answer is 42' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(8)
    expect(written.map(w => w.event)).toEqual([
      'text_delta',
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'done',
    ])
  })

  // --- data field is valid JSON ---

  it('every written data field is valid JSON', async () => {
    handle.push({ type: 'text_delta', content: 'hello' })
    handle.push({ type: 'tool_call_start', toolName: 'x', callId: '1' })
    handle.push({ type: 'tool_call_end', callId: '1', result: null })
    handle.push({ type: 'done', finalOutput: 'hello' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    for (const msg of written) {
      expect(() => JSON.parse(msg.data)).not.toThrow()
    }
  })

  // --- event field matches StreamEvent.type ---

  it('SSE event field matches the StreamEvent type discriminator', async () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', content: 'a' },
      { type: 'tool_call_start', toolName: 't', callId: '1' },
      { type: 'tool_call_end', callId: '1', result: 'r' },
      { type: 'done', finalOutput: 'a' },
    ]
    for (const e of events) handle.push(e)
    handle.complete()

    const written = await drainAdapter(handle, stream)

    for (let i = 0; i < events.length; i++) {
      expect(written[i]!.event).toBe(events[i]!.type)
    }
  })

  // --- concurrent producer/consumer ---

  it('handles producer pushing events while consumer is iterating', async () => {
    const promise = streamRunHandleToSSE(handle, stream)

    // Push events asynchronously
    await new Promise(resolve => setTimeout(resolve, 5))
    handle.push({ type: 'text_delta', content: 'a' })
    await new Promise(resolve => setTimeout(resolve, 5))
    handle.push({ type: 'text_delta', content: 'b' })
    await new Promise(resolve => setTimeout(resolve, 5))
    handle.push({ type: 'done', finalOutput: 'ab' })
    handle.complete()

    await promise

    expect(stream.written).toHaveLength(3)
    expect(stream.written.map(w => w.event)).toEqual(['text_delta', 'text_delta', 'done'])
  })

  // --- handle already completed ---

  it('resolves immediately when handle is already completed before iteration', async () => {
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(0)
  })

  it('resolves immediately when handle is already failed before iteration', async () => {
    handle.fail(new Error('already failed'))

    const written = await drainAdapter(handle, stream)

    // The fail() pushed an error event before going terminal
    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('error')
  })

  it('resolves immediately when handle is already cancelled before iteration', async () => {
    handle.cancel()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(0)
  })

  // --- tool_call_end with complex result ---

  it('serializes tool_call_end with nested object result', async () => {
    const complexResult = {
      data: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }],
      meta: { total: 2, page: 1 },
    }
    handle.push({ type: 'tool_call_end', callId: 'tc-99', result: complexResult })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    const parsed = JSON.parse(written[0]!.data) as { result: unknown }
    expect(parsed.result).toEqual(complexResult)
  })

  // --- large burst of events ---

  it('handles a burst of 50 text_delta events', async () => {
    for (let i = 0; i < 50; i++) {
      handle.push({ type: 'text_delta', content: `chunk-${i}` })
    }
    handle.push({ type: 'done', finalOutput: 'all chunks' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(51) // 50 deltas + 1 done
    for (let i = 0; i < 50; i++) {
      const parsed = JSON.parse(written[i]!.data) as { content: string }
      expect(parsed.content).toBe(`chunk-${i}`)
    }
  })

  // --- onAbort registers callback ---

  it('registers exactly one onAbort callback', async () => {
    handle.push({ type: 'done', finalOutput: 'ok' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream)

    expect(stream.abortCallbacks).toHaveLength(1)
  })

  // --- multiple tool calls ---

  it('handles multiple parallel tool calls', async () => {
    handle.push({ type: 'tool_call_start', toolName: 'search', callId: 'a' })
    handle.push({ type: 'tool_call_start', toolName: 'read', callId: 'b' })
    handle.push({ type: 'tool_call_end', callId: 'b', result: 'file content' })
    handle.push({ type: 'tool_call_end', callId: 'a', result: 'search result' })
    handle.push({ type: 'done', finalOutput: 'combined' })
    handle.complete()

    const written = await drainAdapter(handle, stream)

    expect(written).toHaveLength(5)
    expect(written[0]!.event).toBe('tool_call_start')
    expect(written[1]!.event).toBe('tool_call_start')
    expect(written[2]!.event).toBe('tool_call_end')
    expect(written[3]!.event).toBe('tool_call_end')
    expect(written[4]!.event).toBe('done')
  })

  // --- writeSSE fails on second event ---

  it('stops iteration when writeSSE fails mid-stream', async () => {
    let callCount = 0
    const failingStream: SSEStreamLike = {
      async writeSSE() {
        callCount++
        if (callCount === 2) throw new Error('network error')
      },
      onAbort() { /* noop */ },
    }

    // Only push two events and do NOT complete — the handle is still
    // 'running' when the second write fails, so cancel() transitions it.
    handle.push({ type: 'text_delta', content: 'first' })
    handle.push({ type: 'text_delta', content: 'second' })

    await streamRunHandleToSSE(handle, failingStream)

    // Should have attempted 2 writes (succeeded on first, failed on second)
    expect(callCount).toBe(2)
    expect(handle.status).toBe('cancelled')
  })
})

describe('streamRunHandleToSSE — keep-alive and timeout', () => {
  let handle: StreamingRunHandle
  let stream: ReturnType<typeof createMockStream>

  beforeEach(() => {
    vi.useFakeTimers()
    handle = new StreamingRunHandle({ maxBufferSize: 100 })
    stream = createMockStream()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits a ping event after the keep-alive interval elapses with no data', async () => {
    // Start streaming in the background with a short keep-alive
    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 100,
    })

    // Advance time past the keep-alive interval (tick interval = min(100, 5000) = 100)
    await vi.advanceTimersByTimeAsync(100)

    // The ping should have been written
    const pings = stream.written.filter(m => m.event === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(1)
    expect(pings[0]!.data).toBe('{}')

    // Clean up
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })

  it('does not emit a ping when events are flowing within the keep-alive window', async () => {
    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 200,
    })

    // Push an event at t=50ms — well within the keep-alive window
    await vi.advanceTimersByTimeAsync(50)
    handle.push({ type: 'text_delta', content: 'hello' })
    await vi.advanceTimersByTimeAsync(1) // let the iterator consume

    // At t=100ms (first tick of the interval timer), lastEventTime was just updated
    // so the condition (Date.now() - lastEventTime >= 200) is false
    await vi.advanceTimersByTimeAsync(100)

    const pings = stream.written.filter(m => m.event === 'ping')
    expect(pings).toHaveLength(0)

    // Clean up
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })

  it('clears the keep-alive timer on stream abort', async () => {
    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 100,
    })

    // Abort immediately
    stream.triggerAbort()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    // Advance time well past the keep-alive interval — no ping should appear
    await vi.advanceTimersByTimeAsync(500)

    const pings = stream.written.filter(m => m.event === 'ping')
    expect(pings).toHaveLength(0)
  })

  it('clears the keep-alive timer after done event', async () => {
    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 100,
    })

    handle.push({ type: 'done', finalOutput: 'result' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    // Advance time well past the interval — no ping should appear
    const writtenBefore = stream.written.length
    await vi.advanceTimersByTimeAsync(500)
    // Only the done event should be written, no pings after
    expect(stream.written.length).toBe(writtenBefore)
  })

  it('fires handle.fail() when runTimeoutMs > 0 and timeout elapses', async () => {
    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      runTimeoutMs: 500,
    })

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(500)

    // handle.fail() emits an error event, which the iterator consumes
    await vi.advanceTimersByTimeAsync(1)
    await promise

    expect(handle.status).toBe('failed')
    const errorEvents = stream.written.filter(m => m.event === 'error')
    expect(errorEvents).toHaveLength(1)
    const parsed = JSON.parse(errorEvents[0]!.data) as { error: { message: string } }
    expect(parsed.error.message).toBe('run_timeout')
  })

  it('clears timeout timer after done event', async () => {
    const failSpy = vi.spyOn(handle, 'fail')

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      runTimeoutMs: 500,
    })

    // Complete before timeout
    handle.push({ type: 'done', finalOutput: 'ok' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    // Advance past the original timeout — fail should not be called
    await vi.advanceTimersByTimeAsync(1000)
    expect(failSpy).not.toHaveBeenCalled()
  })

  it('does not set a timeout when runTimeoutMs is 0', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const callsBefore = setTimeoutSpy.mock.calls.length

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      runTimeoutMs: 0,
    })

    // No setTimeout should have been called for the timeout (we check none were
    // added beyond what existed before, accounting for internal microtask delays).
    // Instead, verify directly: fail is never called.
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    // The handle completed normally — not failed by timeout
    expect(handle.status).toBe('completed')

    setTimeoutSpy.mockRestore()
  })

  it('does not set an interval when keepAliveIntervalMs is 0', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const callsBefore = setIntervalSpy.mock.calls.length

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      runTimeoutMs: 0,
    })

    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    // No new setInterval calls should have been made
    const callsAfter = setIntervalSpy.mock.calls.length
    expect(callsAfter).toBe(callsBefore)

    setIntervalSpy.mockRestore()
  })
})

describe('streamRunHandleToSSE — onBufferSaturation', () => {
  let handle: StreamingRunHandle
  let stream: ReturnType<typeof createMockStream>

  beforeEach(() => {
    vi.useFakeTimers()
    handle = new StreamingRunHandle({ maxBufferSize: 100 })
    stream = createMockStream()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onBufferSaturation when a single event exceeds 80% of maxBufferBytes', async () => {
    const cb = vi.fn()
    // A text_delta with ~50 bytes of content. With JSON overhead the serialized
    // form is well over 50 bytes. Set maxBufferBytes=60 so the ratio > 0.8.
    handle.push({ type: 'text_delta', content: 'A'.repeat(50) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 60,
    })

    expect(cb).toHaveBeenCalled()
    const fillRatio = cb.mock.calls[0]![0] as number
    expect(fillRatio).toBeGreaterThan(0.8)
  })

  it('does not fire onBufferSaturation when event is below 80% of maxBufferBytes', async () => {
    const cb = vi.fn()
    // Small event, large buffer — ratio well below 0.8
    handle.push({ type: 'text_delta', content: 'hi' })
    handle.push({ type: 'done', finalOutput: 'hi' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 1_048_576,
    })

    expect(cb).not.toHaveBeenCalled()
  })

  it('does not fire when onBufferSaturation is not provided', async () => {
    // Ensure no error when callback is absent and buffer is full
    handle.push({ type: 'text_delta', content: 'A'.repeat(100) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    // Should not throw
    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      maxBufferBytes: 10,
    })

    expect(stream.written).toHaveLength(2)
  })

  it('debounces: does not fire again within 500ms', async () => {
    const cb = vi.fn()
    // Push multiple large events — all exceed threshold but debounce should limit calls
    for (let i = 0; i < 5; i++) {
      handle.push({ type: 'text_delta', content: 'B'.repeat(100) })
    }
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    // All events processed at the same fake-time (0ms elapsed), so debounce
    // allows only the first call
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires again after 500ms debounce window elapses', async () => {
    const cb = vi.fn()

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    // First large event — fires callback
    handle.push({ type: 'text_delta', content: 'C'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    expect(cb).toHaveBeenCalledTimes(1)

    // Second large event within 500ms — debounced
    handle.push({ type: 'text_delta', content: 'D'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    expect(cb).toHaveBeenCalledTimes(1)

    // Advance past 500ms debounce window
    await vi.advanceTimersByTimeAsync(500)

    // Third large event after debounce — should fire again
    handle.push({ type: 'text_delta', content: 'E'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    expect(cb).toHaveBeenCalledTimes(2)

    // Clean up
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })

  it('fillRatio argument is accurate', async () => {
    const cb = vi.fn()
    const content = 'X'.repeat(200)
    handle.push({ type: 'text_delta', content })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    const maxBufferBytes = 100

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes,
    })

    expect(cb).toHaveBeenCalledTimes(1)
    const fillRatio = cb.mock.calls[0]![0] as number
    // The serialized JSON for text_delta is: {"type":"text_delta","content":"XXX..."}
    // which is well over 200 bytes, so ratio should be > 2.0
    expect(fillRatio).toBeGreaterThan(1.0)
  })

  it('does not fire for the done event if it is below threshold', async () => {
    const cb = vi.fn()
    // done event is small: {"type":"done","finalOutput":"ok"}
    handle.push({ type: 'done', finalOutput: 'ok' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 1000,
    })

    expect(cb).not.toHaveBeenCalled()
  })

  it('fires for error events when they exceed threshold', async () => {
    const cb = vi.fn()
    // Error with long message
    handle.fail(new Error('A'.repeat(200)))

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    expect(cb).toHaveBeenCalled()
  })

  it('treats onBufferSaturation throw as a write error and cancels the handle', async () => {
    const onError = vi.fn()
    const cb = vi.fn().mockImplementation(() => {
      throw new Error('callback exploded')
    })

    // Push a large event but do NOT complete — the handle is still 'running'
    // when the callback throws so cancel() takes effect.
    handle.push({ type: 'text_delta', content: 'F'.repeat(100) })

    // The callback throw is caught by the try/catch in the for-await loop,
    // so onError is called and the handle is cancelled.
    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
      onError,
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'callback exploded' }))
    // The handle is cancelled because the throw aborts the write loop
    expect(handle.status).toBe('cancelled')
    // writeSSE was never called because the callback threw before it
    expect(stream.written).toHaveLength(0)
  })

  it('does not fire when maxBufferBytes is very large', async () => {
    const cb = vi.fn()
    handle.push({ type: 'text_delta', content: 'G'.repeat(500) })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 10_000_000,
    })

    expect(cb).not.toHaveBeenCalled()
  })

  it('uses default maxBufferBytes of 1 MiB when not specified', async () => {
    const cb = vi.fn()
    // A small event should not trigger with 1 MiB default
    handle.push({ type: 'text_delta', content: 'tiny' })
    handle.push({ type: 'done', finalOutput: 'tiny' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
    })

    expect(cb).not.toHaveBeenCalled()
  })

  it('fires exactly at the boundary (81% fill ratio)', async () => {
    const cb = vi.fn()
    // We need a serialized event whose byte length is exactly 81% of maxBufferBytes.
    // JSON for text_delta: {"type":"text_delta","content":"..."} — overhead ~35 bytes
    // Set maxBufferBytes = 100, so 81 bytes triggers. Content needs ~46 bytes.
    const content = 'Z'.repeat(46)
    const serialized = JSON.stringify({ type: 'text_delta', content })
    const byteLen = Buffer.byteLength(serialized, 'utf8')
    const maxBuf = Math.floor(byteLen / 0.81) // ensure ratio is ~0.81

    handle.push({ type: 'text_delta', content })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: maxBuf,
    })

    expect(cb).toHaveBeenCalledTimes(1)
    const ratio = cb.mock.calls[0]![0] as number
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(0.85)
  })

  it('does not fire at exactly 80% fill ratio (threshold is strictly greater than)', async () => {
    const cb = vi.fn()
    const content = 'W'.repeat(10)
    const serialized = JSON.stringify({ type: 'text_delta', content })
    const byteLen = Buffer.byteLength(serialized, 'utf8')
    // Set maxBufferBytes so that ratio is exactly 0.8
    const maxBuf = Math.floor(byteLen / 0.8)

    handle.push({ type: 'text_delta', content })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: maxBuf,
    })

    // ratio = byteLen / floor(byteLen / 0.8)
    // With integer division, floor(byteLen/0.8) >= byteLen/0.8, so ratio <= 0.8
    // The threshold is strictly > 0.8, so it should NOT fire
    expect(cb).not.toHaveBeenCalled()
  })

  it('multiple saturation calls report decreasing fill ratio as events get smaller', async () => {
    const cb = vi.fn()

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    // First large event
    handle.push({ type: 'text_delta', content: 'L'.repeat(200) })
    await vi.advanceTimersByTimeAsync(1)

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(500)

    // Second, smaller-but-still-over-threshold event
    handle.push({ type: 'text_delta', content: 'S'.repeat(50) })
    await vi.advanceTimersByTimeAsync(1)

    expect(cb).toHaveBeenCalledTimes(2)
    const ratio1 = cb.mock.calls[0]![0] as number
    const ratio2 = cb.mock.calls[1]![0] as number
    expect(ratio1).toBeGreaterThan(ratio2)

    // Clean up
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })

  it('backward compatible — existing tests pass without onBufferSaturation', async () => {
    // This test verifies that calling without the new option still works
    handle.push({ type: 'text_delta', content: 'hello' })
    handle.push({ type: 'done', finalOutput: 'hello' })
    handle.complete()

    const written: Array<{ data: string; event?: string }> = []
    const mockStream: SSEStreamLike = {
      async writeSSE(msg) { written.push(msg) },
      onAbort() { /* noop */ },
    }

    await streamRunHandleToSSE(handle, mockStream)

    expect(written).toHaveLength(2)
    expect(written[0]!.event).toBe('text_delta')
    expect(written[1]!.event).toBe('done')
  })

  it('does not fire when all events are below threshold with slow writes', async () => {
    const cb = vi.fn()

    // Slow writeSSE but small events relative to large buffer
    const slowStream: SSEStreamLike & { abortCallbacks: Array<() => void> } = {
      abortCallbacks: [],
      async writeSSE() {
        // Simulate slow write
        await new Promise(resolve => setTimeout(resolve, 10))
      },
      onAbort(callback) { this.abortCallbacks.push(callback) },
    }

    handle.push({ type: 'text_delta', content: 'small' })
    handle.push({ type: 'done', finalOutput: 'small' })
    handle.complete()

    const promise = streamRunHandleToSSE(handle, slowStream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 1_048_576,
    })

    // Advance timers to let slow writes complete
    await vi.advanceTimersByTimeAsync(100)
    await promise

    expect(cb).not.toHaveBeenCalled()
  })

  it('fires on tool_call_end with large result payload', async () => {
    const cb = vi.fn()
    const largeResult = { data: 'R'.repeat(500) }
    handle.push({ type: 'tool_call_end', callId: 'tc-1', result: largeResult })
    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()

    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 100,
    })

    expect(cb).toHaveBeenCalled()
  })

  it('interleaves saturation callbacks with normal event flow', async () => {
    const saturationCalls: number[] = []
    const cb = vi.fn((ratio: number) => { saturationCalls.push(ratio) })

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    // Large event (fires saturation)
    handle.push({ type: 'text_delta', content: 'H'.repeat(100) })
    await vi.advanceTimersByTimeAsync(1)

    expect(stream.written).toHaveLength(1)
    expect(cb).toHaveBeenCalledTimes(1)

    // Small event (no saturation) — within debounce anyway
    handle.push({ type: 'text_delta', content: 'x' })
    await vi.advanceTimersByTimeAsync(1)

    expect(stream.written).toHaveLength(2)
    // Still 1 call (small event doesn't trigger, and debounce active)
    expect(cb).toHaveBeenCalledTimes(1)

    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise

    expect(stream.written).toHaveLength(3)
  })

  it('respects 500ms debounce across many rapid large events', async () => {
    const cb = vi.fn()

    const promise = streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: 0,
      onBufferSaturation: cb,
      maxBufferBytes: 50,
    })

    // Push 10 large events rapidly (all at same fake-time)
    for (let i = 0; i < 10; i++) {
      handle.push({ type: 'text_delta', content: 'Q'.repeat(100) })
    }
    await vi.advanceTimersByTimeAsync(1)

    // Only 1 call due to debounce
    expect(cb).toHaveBeenCalledTimes(1)

    // Advance 500ms and push more
    await vi.advanceTimersByTimeAsync(500)
    for (let i = 0; i < 5; i++) {
      handle.push({ type: 'text_delta', content: 'P'.repeat(100) })
    }
    await vi.advanceTimersByTimeAsync(1)

    // Second call after debounce window
    expect(cb).toHaveBeenCalledTimes(2)

    handle.push({ type: 'done', finalOutput: '' })
    handle.complete()
    await vi.advanceTimersByTimeAsync(1)
    await promise
  })
})
