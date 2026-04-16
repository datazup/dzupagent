import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentBus } from '../events/agent-bus.js'

describe('AgentBus', () => {
  let bus: AgentBus

  beforeEach(() => {
    bus = new AgentBus()
  })

  // ---------------------------------------------------------------------------
  // publish / subscribe
  // ---------------------------------------------------------------------------

  describe('publish and subscribe', () => {
    it('delivers messages to subscribers on the correct channel', () => {
      const handler = vi.fn()
      bus.subscribe('code-changes', 'agent-b', handler)

      bus.publish('agent-a', 'code-changes', { files: ['auth.ts'] })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'agent-a',
          channel: 'code-changes',
          payload: { files: ['auth.ts'] },
        }),
      )
    })

    it('does not deliver messages to subscribers on other channels', () => {
      const handler = vi.fn()
      bus.subscribe('other-channel', 'agent-b', handler)

      bus.publish('agent-a', 'code-changes', { files: ['auth.ts'] })

      expect(handler).not.toHaveBeenCalled()
    })

    it('delivers to multiple subscribers on the same channel', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.subscribe('updates', 'agent-1', h1)
      bus.subscribe('updates', 'agent-2', h2)

      bus.publish('sender', 'updates', { msg: 'hello' })

      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })

    it('includes timestamp in messages', () => {
      const handler = vi.fn()
      bus.subscribe('ch', 'agent-1', handler)

      const before = Date.now()
      bus.publish('sender', 'ch', {})
      const after = Date.now()

      const msg = handler.mock.calls[0]![0]
      expect(msg.timestamp).toBeGreaterThanOrEqual(before)
      expect(msg.timestamp).toBeLessThanOrEqual(after)
    })

    it('catches synchronous handler errors without breaking other handlers', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const bad = vi.fn(() => { throw new Error('handler boom') })
      const good = vi.fn()

      bus.subscribe('ch', 'bad-agent', bad)
      bus.subscribe('ch', 'good-agent', good)

      bus.publish('sender', 'ch', {})

      expect(bad).toHaveBeenCalled()
      expect(good).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('catches async handler errors without breaking', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const asyncBad = vi.fn(async () => { throw new Error('async boom') })
      const good = vi.fn()

      bus.subscribe('ch', 'bad-agent', asyncBad)
      bus.subscribe('ch', 'good-agent', good)

      bus.publish('sender', 'ch', {})

      expect(asyncBad).toHaveBeenCalled()
      expect(good).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('does nothing when publishing to a channel with no subscribers', () => {
      // Should not throw
      bus.publish('agent', 'empty-channel', { data: 'test' })
    })
  })

  // ---------------------------------------------------------------------------
  // unsubscribe
  // ---------------------------------------------------------------------------

  describe('unsubscribe', () => {
    it('stops delivering messages after unsubscribe', () => {
      const handler = vi.fn()
      bus.subscribe('ch', 'agent-1', handler)

      bus.publish('sender', 'ch', { n: 1 })
      expect(handler).toHaveBeenCalledTimes(1)

      bus.unsubscribe('ch', 'agent-1')
      bus.publish('sender', 'ch', { n: 2 })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('subscribe returns unsubscribe function', () => {
      const handler = vi.fn()
      const unsub = bus.subscribe('ch', 'agent-1', handler)

      bus.publish('sender', 'ch', {})
      expect(handler).toHaveBeenCalledTimes(1)

      unsub()
      bus.publish('sender', 'ch', {})
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('cleans up channel when last subscriber unsubscribes', () => {
      bus.subscribe('temp', 'agent-1', vi.fn())
      bus.unsubscribe('temp', 'agent-1')

      expect(bus.listChannels()).not.toContain('temp')
    })

    it('does nothing when unsubscribing from non-existent channel', () => {
      // Should not throw
      bus.unsubscribe('nonexistent', 'agent-1')
    })
  })

  // ---------------------------------------------------------------------------
  // unsubscribeAll
  // ---------------------------------------------------------------------------

  describe('unsubscribeAll', () => {
    it('removes agent from all channels', () => {
      const handler = vi.fn()
      bus.subscribe('ch1', 'agent-1', handler)
      bus.subscribe('ch2', 'agent-1', handler)
      bus.subscribe('ch3', 'agent-1', handler)

      bus.unsubscribeAll('agent-1')

      bus.publish('sender', 'ch1', {})
      bus.publish('sender', 'ch2', {})
      bus.publish('sender', 'ch3', {})
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not affect other agents', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.subscribe('ch', 'agent-1', h1)
      bus.subscribe('ch', 'agent-2', h2)

      bus.unsubscribeAll('agent-1')

      bus.publish('sender', 'ch', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledTimes(1)
    })

    it('cleans up empty channels', () => {
      bus.subscribe('solo', 'agent-1', vi.fn())
      bus.unsubscribeAll('agent-1')

      expect(bus.listChannels()).not.toContain('solo')
    })
  })

  // ---------------------------------------------------------------------------
  // getHistory
  // ---------------------------------------------------------------------------

  describe('getHistory', () => {
    it('returns messages for a specific channel', () => {
      bus.publish('a', 'ch1', { n: 1 })
      bus.publish('a', 'ch2', { n: 2 })
      bus.publish('a', 'ch1', { n: 3 })

      const history = bus.getHistory('ch1')
      expect(history).toHaveLength(2)
      expect(history[0]!.payload).toEqual({ n: 1 })
      expect(history[1]!.payload).toEqual({ n: 3 })
    })

    it('returns empty array for channel with no messages', () => {
      expect(bus.getHistory('empty')).toEqual([])
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        bus.publish('a', 'ch', { n: i })
      }

      const history = bus.getHistory('ch', 3)
      expect(history).toHaveLength(3)
      // Returns the last 3
      expect(history[0]!.payload).toEqual({ n: 7 })
      expect(history[2]!.payload).toEqual({ n: 9 })
    })

    it('enforces maxHistory limit', () => {
      const smallBus = new AgentBus({ maxHistory: 5 })

      for (let i = 0; i < 10; i++) {
        smallBus.publish('a', 'ch', { n: i })
      }

      const history = smallBus.getHistory('ch')
      expect(history).toHaveLength(5)
      expect(history[0]!.payload).toEqual({ n: 5 })
    })
  })

  // ---------------------------------------------------------------------------
  // listChannels / listSubscribers
  // ---------------------------------------------------------------------------

  describe('listChannels', () => {
    it('returns all active channels', () => {
      bus.subscribe('ch1', 'a1', vi.fn())
      bus.subscribe('ch2', 'a2', vi.fn())

      const channels = bus.listChannels()
      expect(channels).toContain('ch1')
      expect(channels).toContain('ch2')
    })

    it('returns empty array when no subscriptions', () => {
      expect(bus.listChannels()).toEqual([])
    })
  })

  describe('listSubscribers', () => {
    it('returns subscriber IDs for a channel', () => {
      bus.subscribe('ch', 'agent-1', vi.fn())
      bus.subscribe('ch', 'agent-2', vi.fn())

      const subs = bus.listSubscribers('ch')
      expect(subs).toContain('agent-1')
      expect(subs).toContain('agent-2')
    })

    it('returns empty array for non-existent channel', () => {
      expect(bus.listSubscribers('nonexistent')).toEqual([])
    })
  })
})
