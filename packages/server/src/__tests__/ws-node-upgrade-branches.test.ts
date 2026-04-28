/**
 * Branch coverage tests for createNodeWsUpgradeHandler and createPathUpgradeGuard.
 *
 * Covers: destroySocketOnReject false path, shouldHandleRequest async returning true,
 * explicit unsafe dev mode, attach error triggering onAttachError, missing
 * req.url, query strings, path with trailing slash.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createEventBus } from '@dzupagent/core'
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

describe('createNodeWsUpgradeHandler branch coverage', () => {
  it('does NOT destroy socket on reject when destroySocketOnReject=false', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const handleUpgrade = vi.fn()

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      shouldHandleRequest: () => false,
      destroySocketOnReject: false,
    })

    const socket = new MockSocket()
    handler({ url: '/x' } as never, socket as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 0))

    expect(socket.destroyed).toBe(false)
  })

  it('async shouldHandleRequest returning true proceeds to upgrade', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      shouldHandleRequest: async () => {
        await new Promise((r) => setTimeout(r, 1))
        return true
      },
    })

    handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))

    expect(handleUpgrade).toHaveBeenCalledOnce()
  })

  it('calls onAttachError when attachNodeWsSession throws', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    vi.spyOn(manager, 'attach').mockRejectedValue(new Error('attach failed'))

    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const errors: unknown[] = []
    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      allowUnsafeUnauthenticated: true,
      onAttachError: ({ error }) => { errors.push(error) },
    })

    handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('attach failed')
  })

  it('swallows attach error without onAttachError', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    vi.spyOn(manager, 'attach').mockRejectedValue(new Error('silent attach fail'))

    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      allowUnsafeUnauthenticated: true,
    })

    expect(() => handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })

  it('handles resolveScopeFromRequest returning null', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      resolveScopeFromRequest: () => null,
    })

    handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))

    expect(bridge.clientCount).toBe(1)
  })

  it('async resolveScopeFromRequest is awaited', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry)

    const ws = new MockWs()
    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(ws as never, req)
    })

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      resolveScopeFromRequest: async () => {
        await new Promise((r) => setTimeout(r, 1))
        return { runIds: ['async-resolved'] }
      },
    })

    handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 20))

    expect(registry.get(ws)?.runIds).toEqual(['async-resolved'])
  })

  it('explicit unsafe dev mode proceeds without shouldHandleRequest or scope resolver', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const handleUpgrade = vi.fn((req, _socket, _head, cb) => {
      cb(new MockWs() as never, req)
    })

    const handler = createNodeWsUpgradeHandler({
      wss: { handleUpgrade },
      manager,
      allowUnsafeUnauthenticated: true,
    })

    handler({ url: '/ws' } as never, new MockSocket() as never, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))

    expect(handleUpgrade).toHaveBeenCalledOnce()
  })
})

describe('createPathUpgradeGuard branch coverage', () => {
  it('handles missing req.url (falls back to "/")', () => {
    const guard = createPathUpgradeGuard('/')
    expect(guard({} as never)).toBe(true)
  })

  it('strips query params', () => {
    const guard = createPathUpgradeGuard('/ws')
    expect(guard({ url: '/ws?token=xyz' } as never)).toBe(true)
    expect(guard({ url: '/events?x=1' } as never)).toBe(false)
  })

  it('strips hash fragment', () => {
    const guard = createPathUpgradeGuard('/ws')
    expect(guard({ url: '/ws#section' } as never)).toBe(true)
  })

  it('is case-sensitive for paths', () => {
    const guard = createPathUpgradeGuard('/ws')
    expect(guard({ url: '/WS' } as never)).toBe(false)
  })
})
