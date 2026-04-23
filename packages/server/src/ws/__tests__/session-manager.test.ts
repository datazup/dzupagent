import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus, type DzupEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../event-bridge.js'
import { WSClientScopeRegistry } from '../scope-registry.js'
import { WSSessionManager } from '../session-manager.js'
import type { WSClientScope } from '../authorization.js'

/**
 * Build a mock WebSocket client with vi.fn() send/close and OPEN readyState.
 *
 * Note: The actual WSSessionManager exposes attach()/handleMessage()/detach()
 * rather than addSession/getSession/removeSession. Registration state is
 * observable via (a) the WSClientScopeRegistry for scope, and (b) the
 * EventBridge clientCount for delivery lifecycle — we assert through both.
 */
function createMockClient(): WSClient & {
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  readyState: number
} {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  }
}

describe('WSSessionManager', () => {
  let bus: DzupEventBus
  let bridge: EventBridge
  let scopeRegistry: WSClientScopeRegistry

  beforeEach(() => {
    bus = createEventBus()
    bridge = new EventBridge(bus)
    scopeRegistry = new WSClientScopeRegistry()
  })

  it('attach registers a session — scope is stored and bridge tracks the client', async () => {
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const ws = createMockClient()
    const scope: WSClientScope = { runIds: ['r1'], tenantId: 't1' }

    await manager.attach(ws, scope)

    expect(bridge.clientCount).toBe(1)
    expect(scopeRegistry.get(ws)).toEqual(scope)
  })

  it('detach removes the session — scope cleared and bridge no longer tracks the client', async () => {
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const ws = createMockClient()
    const scope: WSClientScope = { runIds: ['r1'] }

    await manager.attach(ws, scope)
    expect(scopeRegistry.get(ws)).toBeDefined()
    expect(bridge.clientCount).toBe(1)

    manager.detach(ws)

    expect(scopeRegistry.get(ws)).toBeUndefined()
    expect(bridge.clientCount).toBe(0)
  })

  it('tracks multiple sessions independently — each run scope is isolated', async () => {
    const manager = new WSSessionManager(bridge, scopeRegistry)
    const wsR1a = createMockClient()
    const wsR1b = createMockClient()
    const wsR2 = createMockClient()

    await manager.attach(wsR1a, { runIds: ['r1'] })
    await manager.attach(wsR1b, { runIds: ['r1'] })
    await manager.attach(wsR2, { runIds: ['r2'] })

    expect(bridge.clientCount).toBe(3)
    expect(scopeRegistry.get(wsR1a)?.runIds).toEqual(['r1'])
    expect(scopeRegistry.get(wsR1b)?.runIds).toEqual(['r1'])
    expect(scopeRegistry.get(wsR2)?.runIds).toEqual(['r2'])

    // Detaching one r1 session leaves the others intact.
    manager.detach(wsR1a)

    expect(bridge.clientCount).toBe(2)
    expect(scopeRegistry.get(wsR1a)).toBeUndefined()
    expect(scopeRegistry.get(wsR1b)?.runIds).toEqual(['r1'])
    expect(scopeRegistry.get(wsR2)?.runIds).toEqual(['r2'])
  })

  it('resolveScope callback supplies the scope when attach() is called without an explicit scope', async () => {
    const resolveScope = vi.fn((): WSClientScope => ({ runIds: ['r9'], tenantId: 't9' }))
    const manager = new WSSessionManager(bridge, scopeRegistry, { resolveScope })
    const ws = createMockClient()

    await manager.attach(ws)

    expect(resolveScope).toHaveBeenCalledTimes(1)
    expect(scopeRegistry.get(ws)).toEqual({ runIds: ['r9'], tenantId: 't9' })
  })

  it('handleMessage routes control messages through the registered control handler', async () => {
    const manager = new WSSessionManager(bridge, scopeRegistry, {
      requireScopedSubscription: true,
    })
    const ws = createMockClient()

    await manager.attach(ws, { runIds: ['r1'] })

    // Authorized subscribe should yield a 'subscribed' ack.
    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    expect(ws.send).toHaveBeenCalledTimes(1)
    const ack = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { type: string }
    expect(ack.type).toBe('subscribed')

    // After detach, handleMessage is a no-op (handler removed).
    ws.send.mockClear()
    manager.detach(ws)
    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    expect(ws.send).not.toHaveBeenCalled()
  })
})
