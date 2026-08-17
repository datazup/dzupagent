import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'

describe('DzupEventBus', () => {
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
    const events: DzupEvent[] = []

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

  // ── Handler return values ──────────────────────────────────────────────────
  //
  // These four tests pin the duck-typing guard in `runHandlers`
  // (`../events/event-bus.ts`) — the guard that decides whether what a handler
  // returned is a promise worth attaching a `.catch` to.
  //
  // They are also the type-level lock on the handler signature: each subscribes
  // with an *expression-bodied* arrow that returns a non-void value. Those only
  // compile because handlers are declared `=> void`. Restoring the former
  // `=> void | Promise<void>` union makes this file fail `check-test-typecheck`
  // with TS2322, because TypeScript's void-return leniency does not survive a
  // union.

  it('accepts expression-bodied handlers that return a value', () => {
    const bus = createEventBus()
    const seen: DzupEvent[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `Array.push` returns a number — non-void on all three subscribe methods.
    bus.on('agent:started', (event) => seen.push(event))
    bus.once('agent:started', (event) => seen.push(event))
    bus.onAny((event) => seen.push(event))

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(seen).toHaveLength(3)
    // A number must not be mistaken for a promise: calling `.catch` on it would
    // throw, and the surrounding try/catch would log that as a handler error.
    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('does not treat a non-promise object return as a promise', () => {
    const bus = createEventBus()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()

    // Truthy and `typeof === 'object'`, but no `catch` — the case the
    // `'catch' in result` half of the guard exists for.
    bus.on('agent:started', () => ({ handled: true }))
    bus.on('agent:started', later)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(consoleSpy).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledTimes(1)

    consoleSpy.mockRestore()
  })

  it('does not probe a null return for promise-ness', () => {
    const bus = createEventBus()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `typeof null === 'object'`, so without the leading truthiness check
    // `'catch' in result` throws "Cannot use 'in' operator ... in null".
    bus.on('agent:started', () => null)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('still attaches a catch to a promise returned by an async handler', async () => {
    const bus = createEventBus()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The positive control for the three tests above: narrowing the guard must
    // not cost us the async rejection it was written to catch.
    bus.on('agent:started', async () => { throw new Error('async boom') })

    expect(() =>
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' }),
    ).not.toThrow()

    await Promise.resolve()
    await Promise.resolve()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('async boom'),
    )

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
