import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { WSSessionManager } from '../ws/session-manager.js'
import { attachNodeWsSession } from '../ws/node-adapter.js'

class MockNodeSocket extends EventEmitter implements WSClient {
  readyState = 1
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

describe('attachNodeWsSession', () => {
  it('attaches socket and processes subscribe control messages', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      requireScopedSubscription: true,
    })
    const socket = new MockNodeSocket()

    await attachNodeWsSession({
      manager,
      socket,
      scope: { runIds: ['run-1'] },
    })

    socket.emit('message', JSON.stringify({ type: 'subscribe', filter: { runId: 'run-1' } }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const ack = JSON.parse(socket.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('detaches socket on close', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const socket = new MockNodeSocket()

    await attachNodeWsSession({ manager, socket })
    expect(bridge.clientCount).toBe(1)

    socket.close()
    expect(bridge.clientCount).toBe(0)
  })
})
