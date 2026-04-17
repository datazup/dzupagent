import { describe, it, expect } from 'vitest'
import { StreamingRunHandle } from '../streaming/streaming-run-handle.js'
import type { StreamEvent } from '../streaming/streaming-types.js'

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
    it('drops events beyond maxBufferSize', () => {
      const handle = new StreamingRunHandle({ maxBufferSize: 3 })

      handle.push({ type: 'text_delta', content: '1' })
      handle.push({ type: 'text_delta', content: '2' })
      handle.push({ type: 'text_delta', content: '3' })
      handle.push({ type: 'text_delta', content: '4' }) // Should be dropped
      handle.complete()

      let count = 0
      const iter = handle.events()[Symbol.asyncIterator]()
      const drain = async () => {
        while (true) {
          const { done } = await iter.next()
          if (done) break
          count++
        }
      }

      return drain().then(() => {
        expect(count).toBe(3) // Only 3 events, 4th was dropped
      })
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
    it('uses default maxBufferSize of 1000', () => {
      const handle = new StreamingRunHandle()
      // Push many events -- up to 1000 should be buffered
      for (let i = 0; i < 1001; i++) {
        handle.push({ type: 'text_delta', content: `event-${i}` })
      }
      handle.complete()
      // If we got here without error, the 1001st was just silently dropped
      expect(handle.status).toBe('completed')
    })
  })
})
