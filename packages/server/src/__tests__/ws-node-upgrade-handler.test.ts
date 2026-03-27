import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createEventBus } from '@dzipagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { WSSessionManager } from '../ws/session-manager.js'
import { createNodeWsUpgradeHandler, createPathUpgradeGuard } from '../ws/node-upgrade-handler.js'

class MockWs extends EventEmitter implements WSClient {
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

class MockSocket extends EventEmitter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

describe('createNodeWsUpgradeHandler', () => {
  it('rejects disallowed requests and destroys socket', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const handleUpgrade = vi.fn()
    const onRejected = vi.fn()

    const upgradeHandler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      shouldHandleRequest: () => false,
      onRejected,
    })

    const socket = new MockSocket()
    upgradeHandler({ url: '/not-ws' } as never, socket as never, Buffer.alloc(0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handleUpgrade).not.toHaveBeenCalled()
    expect(onRejected).toHaveBeenCalledOnce()
    expect(socket.destroyed).toBe(true)
  })

  it('upgrades and attaches ws session', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry(), {
      requireScopedSubscription: true,
    })

    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const upgradeHandler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      resolveScopeFromRequest: () => ({ runIds: ['r1'] }),
    })

    upgradeHandler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handleUpgrade).toHaveBeenCalledOnce()
    expect(bridge.clientCount).toBe(1)
  })
})

describe('createPathUpgradeGuard', () => {
  it('matches exact path', () => {
    const guard = createPathUpgradeGuard('/ws')
    expect(guard({ url: '/ws?x=1' } as never)).toBe(true)
    expect(guard({ url: '/events' } as never)).toBe(false)
  })
})
