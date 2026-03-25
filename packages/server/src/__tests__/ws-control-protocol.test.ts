import { describe, it, expect } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { createWsControlHandler } from '../ws/control-protocol.js'

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

describe('ws-control-protocol', () => {
  it('subscribes with a run filter and emits ack', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createWsControlHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; filter?: { runId?: string } }
    expect(ack.type).toBe('subscribed')
    expect(ack.filter?.runId).toBe('r1')

    ws.sent = []
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ws.sent).toHaveLength(1)
    const event = JSON.parse(ws.sent[0] ?? '{}') as { runId?: string }
    expect(event.runId).toBe('r1')
  })

  it('unsubscribe clears filters and emits ack', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })

    const onMessage = createWsControlHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'unsubscribe' }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('unsubscribed')

    ws.sent = []
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ws.sent).toHaveLength(1)
  })

  it('returns structured error for invalid json', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createWsControlHandler(bridge, ws)
    void onMessage('{ bad')

    const err = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(err.type).toBe('error')
    expect(err.code).toBe('INVALID_JSON')
  })

  it('rejects unscoped subscriptions when required', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createWsControlHandler(bridge, ws, { requireScopedSubscription: true })
    await onMessage(JSON.stringify({ type: 'subscribe', filter: {} }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(err.type).toBe('error')
    expect(err.code).toBe('UNSCOPED_SUBSCRIPTION')
  })

  it('rejects unauthorized subscriptions', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createWsControlHandler(bridge, ws, {
      authorizeFilter: ({ filter }) => filter.runId === 'allowed-run',
    })

    await onMessage(JSON.stringify({ type: 'subscribe', filter: { runId: 'forbidden-run' } }))
    const err = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(err.type).toBe('error')
    expect(err.code).toBe('FORBIDDEN_FILTER')
  })
})
