import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus, type DzupEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../event-bridge.js'

/**
 * Build a mock WebSocket client with vi.fn() for send/close and a configurable readyState.
 * Default readyState is 1 (OPEN) matching the WS_OPEN constant used by EventBridge.
 */
function createMockClient(readyState = 1): WSClient & {
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  readyState: number
} {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState,
  }
}

/** Yield a microtask so the InMemoryEventGateway drain loop flushes queued envelopes. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('EventBridge', () => {
  let bus: DzupEventBus
  let bridge: EventBridge

  beforeEach(() => {
    bus = createEventBus()
    bridge = new EventBridge(bus)
  })

  it('addClient registers a client and forwards events to it', async () => {
    const ws = createMockClient()
    bridge.addClient(ws)

    expect(bridge.clientCount).toBe(1)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flush()

    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = ws.send.mock.calls[0]?.[0] as string
    const payload = JSON.parse(sent) as { type: string; runId?: string }
    expect(payload.type).toBe('agent:started')
    expect(payload.runId).toBe('r1')
  })

  it('removeClient unsubscribes the client so no more events are delivered', async () => {
    const ws = createMockClient()
    bridge.addClient(ws)

    bridge.removeClient(ws)
    expect(bridge.clientCount).toBe(0)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flush()

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('filters events by runId — a client only receives events matching its subscribed runId', async () => {
    const wsR1 = createMockClient()
    const wsR2 = createMockClient()
    bridge.addClient(wsR1, { runId: 'r1' })
    bridge.addClient(wsR2, { runId: 'r2' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r2', durationMs: 10 })
    await flush()

    expect(wsR1.send).toHaveBeenCalledTimes(1)
    expect(wsR2.send).toHaveBeenCalledTimes(1)

    const r1Payload = JSON.parse(wsR1.send.mock.calls[0]?.[0] as string) as { runId?: string; type: string }
    const r2Payload = JSON.parse(wsR2.send.mock.calls[0]?.[0] as string) as { runId?: string; type: string }
    expect(r1Payload.runId).toBe('r1')
    expect(r1Payload.type).toBe('agent:started')
    expect(r2Payload.runId).toBe('r2')
    expect(r2Payload.type).toBe('agent:completed')
  })

  it('does not deliver events that lack a runId to run-filtered clients', async () => {
    // A client subscribed with runId='r1' should NOT receive events that have no runId
    // (the filter requires envelope.runId === filter.runId).
    const ws = createMockClient()
    bridge.addClient(ws, { runId: 'r1' })

    // tool:called has no runId field on the envelope
    bus.emit({ type: 'tool:called', toolName: 'search', input: { q: 'hi' } })
    await flush()

    expect(ws.send).not.toHaveBeenCalled()

    // Unfiltered clients DO receive all events including run-less ones
    const wsAll = createMockClient()
    bridge.addClient(wsAll)
    bus.emit({ type: 'tool:called', toolName: 'edit', input: {} })
    await flush()

    expect(wsAll.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(wsAll.send.mock.calls[0]?.[0] as string) as { type: string }
    expect(payload.type).toBe('tool:called')
  })

  it('overflow: with disconnect strategy and small queue, the client is dropped when events exceed capacity', async () => {
    // EventBridge uses overflowStrategy: 'disconnect' with maxQueueSize from config.
    // Force a tiny queue so we can trigger overflow without racing the microtask drainer.
    const smallBridge = new EventBridge(bus, { maxQueueSize: 2 })
    const ws = createMockClient()
    smallBridge.addClient(ws)

    expect(smallBridge.clientCount).toBe(1)

    // Synchronously emit enough events to exceed maxQueueSize before the drainer runs.
    // Once the queue is full, the gateway deletes the subscription (disconnect strategy).
    for (let i = 0; i < 10; i += 1) {
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: `r${i}` })
    }
    await flush()
    await flush()

    // After overflow-triggered disconnect, further events must not reach the client.
    ws.send.mockClear()
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r-after' })
    await flush()

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('drops the client when readyState is not OPEN instead of attempting to send', async () => {
    const ws = createMockClient(3) // CLOSED
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flush()

    expect(ws.send).not.toHaveBeenCalled()
    expect(bridge.clientCount).toBe(0)
  })

  it('setClientFilter updates the subscription without reconnecting', async () => {
    const ws = createMockClient()
    bridge.addClient(ws, { runId: 'r1' })

    bridge.setClientFilter(ws, { runId: 'r2' })
    expect(bridge.clientCount).toBe(1)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await flush()

    expect(ws.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { runId?: string }
    expect(payload.runId).toBe('r2')
  })

  it('disconnectAll closes every client and empties the registry', async () => {
    const ws1 = createMockClient()
    const ws2 = createMockClient()
    bridge.addClient(ws1)
    bridge.addClient(ws2)

    expect(bridge.clientCount).toBe(2)

    bridge.disconnectAll()

    expect(bridge.clientCount).toBe(0)
    expect(ws1.close).toHaveBeenCalledTimes(1)
    expect(ws2.close).toHaveBeenCalledTimes(1)

    // After teardown, no events are forwarded even if the bus keeps emitting.
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flush()
    expect(ws1.send).not.toHaveBeenCalled()
    expect(ws2.send).not.toHaveBeenCalled()
  })
})
