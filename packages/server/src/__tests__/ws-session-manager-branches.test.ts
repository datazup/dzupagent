/**
 * Branch coverage tests for WSSessionManager.
 *
 * Covers: handleMessage with unknown client, detach of unknown client,
 * attach without scope and without resolver, resolveScope returning null,
 * explicit scope overrides resolver scope, multiple attach/detach cycles.
 */
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

describe('WSSessionManager branch coverage', () => {
  it('handleMessage on unattached client is a no-op', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const ws = new MockWsClient()

    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe' }))
    expect(ws.sent).toHaveLength(0)
  })

  it('detach on unattached client is a no-op', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const ws = new MockWsClient()

    expect(() => manager.detach(ws)).not.toThrow()
  })

  it('attach without scope or resolver leaves no scope set', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const ws = new MockWsClient()

    await manager.attach(ws)
    expect(scopeRegistry.get(ws)).toBeUndefined()
    expect(bridge.clientCount).toBe(1)
  })

  it('attach with resolveScope returning null leaves no scope', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      resolveScope: () => null,
    })
    const ws = new MockWsClient()

    await manager.attach(ws)
    expect(scopeRegistry.get(ws)).toBeUndefined()
  })

  it('attach with async resolveScope resolves correctly', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      resolveScope: async () => {
        await new Promise((r) => setTimeout(r, 1))
        return { runIds: ['async-r1'] }
      },
    })
    const ws = new MockWsClient()

    await manager.attach(ws)
    expect(scopeRegistry.get(ws)?.runIds).toEqual(['async-r1'])
  })

  it('explicit scope overrides resolver scope', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      resolveScope: () => ({ runIds: ['resolver-run'] }),
    })
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['explicit-run'] })
    expect(scopeRegistry.get(ws)?.runIds).toEqual(['explicit-run'])
  })

  it('re-attaching same client increments registry correctly', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['r1'] })
    await manager.attach(ws, { runIds: ['r2'] })

    expect(scopeRegistry.get(ws)?.runIds).toEqual(['r2'])
  })

  it('detach clears scope registry entry', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const scopeRegistry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['r1'] })
    expect(scopeRegistry.get(ws)?.runIds).toEqual(['r1'])

    manager.detach(ws)
    expect(scopeRegistry.get(ws)).toBeUndefined()
  })

  it('attach sets deny-all baseline until subscribe is received', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const ws = new MockWsClient()

    await manager.attach(ws)

    // Emit an event — with deny-all baseline, client receives nothing
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(ws.sent).toHaveLength(0)
  })
})
