import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '../events/event-bus.js'
import type { DzipEvent } from '../events/event-types.js'

describe('DzipEventBus', () => {
  it('emits events to typed listeners', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    bus.on('agent:started', handler)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(handler).toHaveBeenCalledWith({
      type: 'agent:started',
      agentId: 'a1',
      runId: 'r1',
    })
  })

  it('does not call handler for different event types', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    bus.on('agent:started', handler)
    bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribe stops future events', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    const unsub = bus.on('tool:called', handler)
    bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
    expect(handler).toHaveBeenCalledTimes(1)

    unsub()
    bus.emit({ type: 'tool:called', toolName: 'git_diff', input: {} })
    expect(handler).toHaveBeenCalledTimes(1) // not called again
  })

  it('once() fires only once', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    bus.once('mcp:connected', handler)
    bus.emit({ type: 'mcp:connected', serverName: 'fs', toolCount: 3 })
    bus.emit({ type: 'mcp:connected', serverName: 'gh', toolCount: 5 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'fs' }),
    )
  })

  it('onAny() receives all event types', () => {
    const bus = createEventBus()
    const events: DzipEvent[] = []

    bus.onAny((event) => { events.push(event) })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'tool:called', toolName: 'test', input: {} })

    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('agent:started')
    expect(events[1]!.type).toBe('tool:called')
  })

  it('handler errors do not break emit', () => {
    const bus = createEventBus()
    const good = vi.fn()
    const bad = vi.fn(() => { throw new Error('boom') })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    bus.on('agent:started', bad)
    bus.on('agent:started', good)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(bad).toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('supports multiple handlers per event type', () => {
    const bus = createEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    const h3 = vi.fn()

    bus.on('plugin:registered', h1)
    bus.on('plugin:registered', h2)
    bus.on('plugin:registered', h3)

    bus.emit({ type: 'plugin:registered', pluginName: 'sentry' })

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h3).toHaveBeenCalledTimes(1)
  })
})
