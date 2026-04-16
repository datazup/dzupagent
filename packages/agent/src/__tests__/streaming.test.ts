import { describe, it, expect } from 'vitest'
import { TextDeltaBuffer } from '../streaming/text-delta-buffer.js'
import { StreamingRunHandle } from '../streaming/streaming-run-handle.js'
import type { StreamEvent } from '../streaming/streaming-types.js'

// ---------------------------------------------------------------------------
// TextDeltaBuffer
// ---------------------------------------------------------------------------

describe('TextDeltaBuffer', () => {
  it('accumulates partial words and emits complete ones', () => {
    const buffer = new TextDeltaBuffer()

    // "Hel" is a partial word — nothing emitted yet
    expect(buffer.push('Hel')).toEqual([])

    // "lo " completes the word "Hello " — emitted
    const chunks = buffer.push('lo ')
    expect(chunks).toEqual(['Hello '])
  })

  it('emits multiple complete words at once', () => {
    const buffer = new TextDeltaBuffer()
    const chunks = buffer.push('hello world ')
    expect(chunks).toEqual(['hello ', 'world '])
  })

  it('buffers the last partial word when no trailing whitespace', () => {
    const buffer = new TextDeltaBuffer()
    const chunks = buffer.push('hello world')
    // "hello " is complete, "world" is still partial
    expect(chunks).toEqual(['hello '])
    expect(buffer.peek()).toBe('world')
  })

  it('flush() returns remaining buffered content', () => {
    const buffer = new TextDeltaBuffer()
    buffer.push('partial')
    expect(buffer.flush()).toBe('partial')
    // After flush, buffer is empty
    expect(buffer.flush()).toBe('')
  })

  it('flush() returns empty string when buffer is empty', () => {
    const buffer = new TextDeltaBuffer()
    expect(buffer.flush()).toBe('')
  })

  it('reset() clears the buffer', () => {
    const buffer = new TextDeltaBuffer()
    buffer.push('some content')
    buffer.reset()
    expect(buffer.peek()).toBe('')
    expect(buffer.flush()).toBe('')
  })

  it('handles empty delta gracefully', () => {
    const buffer = new TextDeltaBuffer()
    expect(buffer.push('')).toEqual([])
  })

  it('handles newline as word boundary', () => {
    const buffer = new TextDeltaBuffer()
    const chunks = buffer.push('line1\nline2')
    expect(chunks).toEqual(['line1\n'])
    expect(buffer.peek()).toBe('line2')
  })

  it('handles consecutive whitespace correctly', () => {
    const buffer = new TextDeltaBuffer()
    const chunks = buffer.push('a  b  ')
    // The regex match groups: "a  ", "b  "
    expect(chunks).toEqual(['a  ', 'b  '])
  })

  it('accumulates across multiple pushes then flushes', () => {
    const buffer = new TextDeltaBuffer()
    buffer.push('The ')
    const c1 = buffer.push('quick ')
    expect(c1).toEqual(['quick '])

    buffer.push('brown')
    // "brown" is partial
    expect(buffer.flush()).toBe('brown')
  })
})

// ---------------------------------------------------------------------------
// StreamingRunHandle
// ---------------------------------------------------------------------------

describe('StreamingRunHandle', () => {
  it('starts in running status', () => {
    const handle = new StreamingRunHandle()
    expect(handle.status).toBe('running')
  })

  it('yields pushed events via async iterable', async () => {
    const handle = new StreamingRunHandle()
    const collected: StreamEvent[] = []

    handle.push({ type: 'text_delta', content: 'Hello' })
    handle.push({ type: 'text_delta', content: ' world' })
    handle.push({ type: 'done', finalOutput: 'Hello world' })
    handle.complete()

    for await (const event of handle.events()) {
      collected.push(event)
    }

    expect(collected).toHaveLength(3)
    expect(collected[0]).toEqual({ type: 'text_delta', content: 'Hello' })
    expect(collected[1]).toEqual({ type: 'text_delta', content: ' world' })
    expect(collected[2]).toEqual({ type: 'done', finalOutput: 'Hello world' })
  })

  it('transitions to completed status after complete()', () => {
    const handle = new StreamingRunHandle()
    handle.complete()
    expect(handle.status).toBe('completed')
  })

  it('transitions to failed status after fail()', () => {
    const handle = new StreamingRunHandle()
    handle.fail(new Error('boom'))
    expect(handle.status).toBe('failed')
  })

  it('transitions to cancelled status after cancel()', () => {
    const handle = new StreamingRunHandle()
    handle.cancel()
    expect(handle.status).toBe('cancelled')
  })

  it('throws when pushing to a completed stream', () => {
    const handle = new StreamingRunHandle()
    handle.complete()
    expect(() => {
      handle.push({ type: 'text_delta', content: 'late' })
    }).toThrow('Cannot push events to a completed stream')
  })

  it('delivers events to a waiting consumer', async () => {
    const handle = new StreamingRunHandle()

    // Start consuming (will wait for events)
    const iter = handle.events()[Symbol.asyncIterator]()
    const nextPromise = iter.next()

    // Push an event after the consumer is waiting
    handle.push({ type: 'text_delta', content: 'async hello' })

    const result = await nextPromise
    expect(result.done).toBe(false)
    expect(result.value).toEqual({ type: 'text_delta', content: 'async hello' })

    handle.complete()
  })

  it('fail() pushes an error event before terminating', async () => {
    const handle = new StreamingRunHandle()
    const collected: StreamEvent[] = []

    handle.push({ type: 'text_delta', content: 'partial' })
    handle.fail(new Error('something broke'))

    for await (const event of handle.events()) {
      collected.push(event)
    }

    expect(collected).toHaveLength(2)
    expect(collected[0]).toEqual({ type: 'text_delta', content: 'partial' })
    expect(collected[1]!.type).toBe('error')
    if (collected[1]!.type === 'error') {
      expect(collected[1]!.error.message).toBe('something broke')
    }
  })

  it('tool call events carry correct data', async () => {
    const handle = new StreamingRunHandle()

    handle.push({ type: 'tool_call_start', toolName: 'search', callId: 'c1' })
    handle.push({ type: 'tool_call_end', callId: 'c1', result: { hits: 42 } })
    handle.complete()

    const events: StreamEvent[] = []
    for await (const event of handle.events()) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    const start = events[0]!
    const end = events[1]!

    if (start.type === 'tool_call_start') {
      expect(start.toolName).toBe('search')
      expect(start.callId).toBe('c1')
    }
    if (end.type === 'tool_call_end') {
      expect(end.callId).toBe('c1')
      expect(end.result).toEqual({ hits: 42 })
    }
  })
})

// ---------------------------------------------------------------------------
// StreamEvent type narrowing (compile-time check)
// ---------------------------------------------------------------------------

describe('StreamEvent type narrowing', () => {
  it('narrows text_delta correctly', () => {
    const event: StreamEvent = { type: 'text_delta', content: 'hi' }
    if (event.type === 'text_delta') {
      // TypeScript narrows to TextDeltaEvent — content is accessible
      expect(event.content).toBe('hi')
    }
  })

  it('narrows tool_call_start correctly', () => {
    const event: StreamEvent = { type: 'tool_call_start', toolName: 'read', callId: 'x' }
    if (event.type === 'tool_call_start') {
      expect(event.toolName).toBe('read')
      expect(event.callId).toBe('x')
    }
  })

  it('narrows tool_call_end correctly', () => {
    const event: StreamEvent = { type: 'tool_call_end', callId: 'x', result: 'ok' }
    if (event.type === 'tool_call_end') {
      expect(event.callId).toBe('x')
      expect(event.result).toBe('ok')
    }
  })

  it('narrows done correctly', () => {
    const event: StreamEvent = { type: 'done', finalOutput: 'result' }
    if (event.type === 'done') {
      expect(event.finalOutput).toBe('result')
    }
  })

  it('narrows error correctly', () => {
    const err = new Error('fail')
    const event: StreamEvent = { type: 'error', error: err }
    if (event.type === 'error') {
      expect(event.error).toBe(err)
    }
  })
})
