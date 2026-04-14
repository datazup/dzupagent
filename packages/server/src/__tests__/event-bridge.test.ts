import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'

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

describe('EventBridge', () => {
  it('broadcasts events to unfiltered clients', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ws.sent).toHaveLength(1)
    const payload = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(payload.type).toBe('agent:started')
  })

  it('does not send runless events to run-filtered clients', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })

    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ws.sent).toHaveLength(0)
  })

  it('sends only matching runId events to run-filtered clients', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ws.sent).toHaveLength(1)
    const payload = JSON.parse(ws.sent[0] ?? '{}') as { runId?: string }
    expect(payload.runId).toBe('r1')
  })

  it('updates client filter without reconnecting', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })

    bridge.setClientFilter(ws, { runId: 'r2' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ws.sent).toHaveLength(1)
    const payload = JSON.parse(ws.sent[0] ?? '{}') as { runId?: string }
    expect(payload.runId).toBe('r2')
  })
})
