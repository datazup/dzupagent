import { describe, it, expect } from 'vitest'
import { StreamingRunHandle } from '../streaming/streaming-run-handle.js'
import type { StreamEvent } from '../streaming/streaming-types.js'

async function collectEvents(handle: StreamingRunHandle): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of handle.events()) events.push(event)
  return events
}

describe('StreamingRunHandle', () => {
  describe('push and events', () => {
    it('yields pushed events in order', async () => {
      const handle = new StreamingRunHandle()
      handle.push({ type: 'text_delta', content: 'hello' })
      handle.push({ type: 'text_delta', content: ' world' })
      handle.complete()

      const events: StreamEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ type: 'text_delta', content: 'hello' })
      expect(events[1]).toEqual({ type: 'text_delta', content: ' world' })
    })

    it('yields events pushed after iteration starts', async () => {
      const handle = new StreamingRunHandle()

      const events: StreamEvent[] = []
      const consumePromise = (async () => {
        for await (const event of handle.events()) {
          events.push(event)
        }
      })()

      // Push after consumer started waiting
      handle.push({ type: 'text_delta', content: 'async' })
      handle.complete()

      await consumePromise

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('text_delta')
    })
  })

  describe('status transitions', () => {
    it('starts as running', () => {
      const handle = new StreamingRunHandle()
      expect(handle.status).toBe('running')
    })

    it('transitions to completed', () => {
      const handle = new StreamingRunHandle()
      handle.complete()
      expect(handle.status).toBe('completed')
    })

    it('transitions to failed', () => {
      const handle = new StreamingRunHandle()
      handle.fail(new Error('boom'))
      expect(handle.status).toBe('failed')
    })

    it('transitions to cancelled', () => {
      const handle = new StreamingRunHandle()
      handle.cancel()
      expect(handle.status).toBe('cancelled')
    })

    it('complete is idempotent', () => {
      const handle = new StreamingRunHandle()
      handle.complete()
      handle.complete() // Should not throw
      expect(handle.status).toBe('completed')
    })

    it('fail is idempotent after complete', () => {
      const handle = new StreamingRunHandle()
      handle.complete()
      handle.fail(new Error('after complete'))
      expect(handle.status).toBe('completed')
    })

    it('cancel is idempotent after complete', () => {
      const handle = new StreamingRunHandle()
      handle.complete()
      handle.cancel()
      expect(handle.status).toBe('completed')
    })
  })

  describe('push errors', () => {
    it('throws when pushing to completed stream', () => {
      const handle = new StreamingRunHandle()
      handle.complete()
      expect(() => handle.push({ type: 'text_delta', content: 'late' }))
        .toThrow('Cannot push events to a completed stream')
    })

    it('throws when pushing to failed stream', () => {
      const handle = new StreamingRunHandle()
      handle.fail(new Error('failed'))
      expect(() => handle.push({ type: 'text_delta', content: 'late' }))
        .toThrow('Cannot push events to a failed stream')
    })

    it('throws when pushing to cancelled stream', () => {
      const handle = new StreamingRunHandle()
      handle.cancel()
      expect(() => handle.push({ type: 'text_delta', content: 'late' }))
        .toThrow('Cannot push events to a cancelled stream')
    })
  })

  describe('fail with error event', () => {
    it('delivers error event to waiting consumer', async () => {
      const handle = new StreamingRunHandle()

      const events: StreamEvent[] = []
      const consumePromise = (async () => {
        for await (const event of handle.events()) {
          events.push(event)
        }
      })()

      handle.fail(new Error('stream error'))

      await consumePromise

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('error')
      expect((events[0] as { type: 'error'; error: Error }).error.message).toBe('stream error')
    })

    it('buffers error event when no consumer is waiting', async () => {
      const handle = new StreamingRunHandle()
      handle.fail(new Error('buffered error'))

      const events: StreamEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('error')
    })
  })

  describe('buffer overflow', () => {
    it('preserves the original failure after a full ordinary buffer', async () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 2 })
      const upstreamError = new TypeError('upstream failed')

      handle.push({ type: 'text_delta', content: '1' })
      handle.push({ type: 'text_delta', content: '2' })
      handle.fail(upstreamError)

      const events = await collectEvents(handle)
      expect(handle.status).toBe('failed')
      expect(events.map(event => event.type)).toEqual(['text_delta', 'text_delta', 'error'])
      expect(events[2]).toEqual({ type: 'error', error: upstreamError })
    })

    it('fails closed with one stable overflow error at exact capacity', async () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 2 })

      handle.push({ type: 'text_delta', content: '1' })
      handle.push({ type: 'text_delta', content: '2' })
      handle.push({ type: 'text_delta', content: 'overflow' })

      expect(handle.status).toBe('failed')
      const events = await collectEvents(handle)
      expect(events.map(event => event.type)).toEqual(['text_delta', 'text_delta', 'error'])
      const terminal = events[2]
      expect(terminal).toMatchObject({
        type: 'error',
        error: {
          name: 'StreamBufferOverflowError',
          message: 'stream_buffer_overflow',
        },
      })
    })

    it('retains one done event outside a full ordinary buffer', async () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 2 })

      handle.push({ type: 'text_delta', content: '1' })
      handle.push({ type: 'text_delta', content: '2' })
      handle.push({ type: 'done', finalOutput: '12' })
      handle.complete()

      const events = await collectEvents(handle)
      expect(handle.status).toBe('completed')
      expect(events).toEqual([
        { type: 'text_delta', content: '1' },
        { type: 'text_delta', content: '2' },
        { type: 'done', finalOutput: '12' },
      ])
    })

    it('retains no synthetic terminal event when a full buffer is cancelled', async () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 2 })

      handle.push({ type: 'text_delta', content: '1' })
      handle.push({ type: 'text_delta', content: '2' })
      handle.cancel()

      const events = await collectEvents(handle)
      expect(handle.status).toBe('cancelled')
      expect(events).toEqual([
        { type: 'text_delta', content: '1' },
        { type: 'text_delta', content: '2' },
      ])
    })

    it('delivers only the first terminal event across duplicate attempts', async () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 1 })

      handle.push({ type: 'text_delta', content: 'accepted' })
      handle.push({ type: 'done', finalOutput: 'first' })
      expect(() => handle.push({ type: 'done', finalOutput: 'second' }))
        .toThrow('Cannot push events to a completed stream')
      handle.complete()
      handle.fail(new Error('late failure'))

      const events = await collectEvents(handle)
      expect(events).toEqual([
        { type: 'text_delta', content: 'accepted' },
        { type: 'done', finalOutput: 'first' },
      ])
    })
  })

  describe('cancel terminates consumer', () => {
    it('terminates async iterator on cancel', async () => {
      const handle = new StreamingRunHandle()

      const events: StreamEvent[] = []
      const consumePromise = (async () => {
        for await (const event of handle.events()) {
          events.push(event)
        }
      })()

      handle.push({ type: 'text_delta', content: 'before cancel' })
      // Small delay to let the consumer read
      await new Promise(resolve => setTimeout(resolve, 5))
      handle.cancel()

      await consumePromise

      // Should have received the event before cancellation
      expect(events.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('default options', () => {
    it('uses default ordinary capacity of exactly 1000', async () => {
      const handle = new StreamingRunHandle()
      for (let i = 0; i < 1001; i++) {
        handle.push({ type: 'text_delta', content: `event-${i}` })
      }

      expect(handle.status).toBe('failed')
      const events = await collectEvents(handle)
      expect(events).toHaveLength(1001)
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: { name: 'StreamBufferOverflowError' },
      })
    })
  })
})
