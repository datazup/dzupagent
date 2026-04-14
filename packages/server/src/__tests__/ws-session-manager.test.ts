import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { WSSessionManager } from '../ws/session-manager.js'

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

describe('WSSessionManager', () => {
  it('attaches, authorizes subscribe, and detaches client', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      requireScopedSubscription: true,
    })
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['r1'] })
    expect(bridge.clientCount).toBe(1)

    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r2' } }))
    let msg = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('FORBIDDEN_FILTER')

    ws.sent = []
    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    msg = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(msg.type).toBe('subscribed')

    manager.detach(ws)
    expect(bridge.clientCount).toBe(0)
  })

  it('can resolve scope on attach via callback', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      resolveScope: () => ({ runIds: ['r1'] }),
      requireScopedSubscription: true,
    })
    const ws = new MockWsClient()

    await manager.attach(ws)
    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))

    const msg = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(msg.type).toBe('subscribed')
  })
})
