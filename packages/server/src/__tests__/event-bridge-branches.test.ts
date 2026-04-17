/**
 * Branch coverage tests for EventBridge.
 *
 * Covers: disconnect on closed socket, send failure path, destroy semantics,
 * filter update on non-existent client, duplicate addClient replacing existing,
 * ownership flags for DzupEventBus vs EventGateway inputs.
 */
import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { InMemoryEventGateway } from '../events/event-gateway.js'

class MockWsClient implements WSClient {
  readyState = 1
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
}

class ExplodingWsClient implements WSClient {
  readyState = 1
  sendCount = 0
  send(_data: string): void {
    this.sendCount++
    throw new Error('send failed')
  }
  close(): void {
    this.readyState = 3
  }
}

class ExplodingCloseClient implements WSClient {
  readyState = 1
  send(_data: string): void {}
  close(): void {
    throw new Error('close failed')
  }
}

describe('EventBridge branch coverage', () => {
  it('accepts pre-built EventGateway and does not own it', () => {
    const gateway = new InMemoryEventGateway()
    const destroySpy = vi.spyOn(gateway, 'destroy')

    const bridge = new EventBridge(gateway)
    bridge.destroy()

    expect(destroySpy).not.toHaveBeenCalled()
  })

  it('constructs and owns gateway when given an event bus', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    expect(bridge.clientCount).toBe(0)
    bridge.destroy()
  })

  it('respects custom maxQueueSize config', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus, { maxQueueSize: 10 })
    const ws = new MockWsClient()
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 0))

    expect(ws.sent.length).toBeGreaterThan(0)
    bridge.destroy()
  })

  it('addClient replaces existing subscription for same client', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()

    bridge.addClient(ws, { runId: 'r1' })
    expect(bridge.clientCount).toBe(1)

    bridge.addClient(ws, { runId: 'r2' })
    expect(bridge.clientCount).toBe(1)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await new Promise((r) => setTimeout(r, 0))

    expect(ws.sent.length).toBe(1)
    const payload = JSON.parse(ws.sent[0] ?? '{}') as { runId?: string }
    expect(payload.runId).toBe('r2')
  })

  it('removeClient is a no-op for unknown clients', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const unknown = new MockWsClient()
    expect(() => bridge.removeClient(unknown)).not.toThrow()
    expect(bridge.clientCount).toBe(0)
  })

  it('setClientFilter is a no-op when client not registered', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()

    bridge.setClientFilter(ws, { runId: 'r1' })
    expect(bridge.clientCount).toBe(0)
  })

  it('drops events and removes client when readyState is not OPEN', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    ws.readyState = 3 // CLOSED

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 0))

    expect(ws.sent).toHaveLength(0)
    expect(bridge.clientCount).toBe(0)
  })

  it('removes client when send throws', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new ExplodingWsClient()
    bridge.addClient(ws)
    expect(bridge.clientCount).toBe(1)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 0))

    expect(bridge.clientCount).toBe(0)
  })

  it('disconnectAll handles close() throwing gracefully', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new ExplodingCloseClient()
    bridge.addClient(ws)

    expect(() => bridge.disconnectAll()).not.toThrow()
    expect(bridge.clientCount).toBe(0)
  })

  it('destroy is idempotent across multiple calls', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    expect(() => {
      bridge.destroy()
      bridge.destroy()
    }).not.toThrow()
  })

  it('disconnectAll clears clients and closes owned gateway', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const a = new MockWsClient()
    const b = new MockWsClient()
    bridge.addClient(a)
    bridge.addClient(b)
    expect(bridge.clientCount).toBe(2)

    bridge.disconnectAll()
    expect(bridge.clientCount).toBe(0)
    expect(a.readyState).toBe(3)
    expect(b.readyState).toBe(3)
  })

  it('disconnectAll does not destroy externally-owned gateway', () => {
    const gateway = new InMemoryEventGateway()
    const destroySpy = vi.spyOn(gateway, 'destroy')

    const bridge = new EventBridge(gateway)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    bridge.disconnectAll()
    expect(destroySpy).not.toHaveBeenCalled()
  })
})
