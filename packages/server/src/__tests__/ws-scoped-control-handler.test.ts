import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { createScopedWsControlHandler } from '../ws/scoped-control-handler.js'

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

describe('createScopedWsControlHandler', () => {
  it('rejects subscribe when scope disallows run', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws)
    registry.set(ws, { runIds: ['r-allowed'] })

    const onControl = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
    })

    await onControl(JSON.stringify({ type: 'subscribe', filter: { runId: 'r-denied' } }))

    const msg = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('FORBIDDEN_FILTER')
  })

  it('accepts subscribe when scope allows run', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws)
    registry.set(ws, { runIds: ['r-allowed'] })

    const onControl = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
    })

    await onControl(JSON.stringify({ type: 'subscribe', filter: { runId: 'r-allowed' } }))

    const msg = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; filter?: { runId?: string } }
    expect(msg.type).toBe('subscribed')
    expect(msg.filter?.runId).toBe('r-allowed')
  })
})
