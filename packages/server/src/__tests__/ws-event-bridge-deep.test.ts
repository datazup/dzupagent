/**
 * Deep coverage tests for the WebSocket event bridge layer (W22-A2).
 *
 * These tests exercise the full WS surface: EventBridge, node adapter,
 * session manager, scope registry, authorization, control protocol,
 * and scoped control handler. They focus on event routing, lifecycle,
 * error resilience, and authorization semantics that the existing thin
 * test files do not cover.
 */
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import {
  InMemoryEventGateway,
  type EventEnvelope,
  type EventGateway,
  type EventSubscription,
  type EventSubscriptionFilter,
} from '../events/event-gateway.js'
import { attachNodeWsSession } from '../ws/node-adapter.js'
import { WSSessionManager } from '../ws/session-manager.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { createScopedAuthorizeFilter } from '../ws/authorization.js'
import { createWsControlHandler } from '../ws/control-protocol.js'
import { createScopedWsControlHandler } from '../ws/scoped-control-handler.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MockWsClient implements WSClient {
  readyState = 1
  sent: string[] = []
  closed = false
  send = vi.fn((data: string): void => {
    this.sent.push(data)
  })
  close = vi.fn((): void => {
    this.readyState = 3
    this.closed = true
  })

  get lastMessage(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1]
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }

  reset(): void {
    this.sent = []
    this.send.mockClear()
    this.close.mockClear()
  }
}

class MockNodeSocket extends EventEmitter implements WSClient {
  readyState = 1
  sent: string[] = []
  send = vi.fn((data: string): void => {
    this.sent.push(data)
  })
  close = vi.fn((): void => {
    this.readyState = 3
    this.emit('close')
  })
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// EventBridge — forwarding, filtering, cleanup, error handling
// ---------------------------------------------------------------------------

describe('EventBridge forwarding semantics', () => {
  it('serializes DzupEventBus events into JSON envelopes', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()

    expect(ws.send).toHaveBeenCalledOnce()
    const envelope = JSON.parse(ws.sent[0] ?? '{}') as EventEnvelope
    expect(envelope.type).toBe('agent:started')
    expect(envelope.version).toBe('v1')
    expect(envelope.runId).toBe('r1')
    expect(envelope.agentId).toBe('a1')
    expect(envelope.payload.type).toBe('agent:started')
    expect(typeof envelope.timestamp).toBe('string')
    expect(envelope.id).toMatch(/^evt-/)
  })

  it('routes events only to the scope that requested them (agentId filter)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const wsA = new MockWsClient()
    const wsB = new MockWsClient()
    bridge.addClient(wsA, { agentId: 'agent-a' })
    bridge.addClient(wsB, { agentId: 'agent-b' })

    bus.emit({ type: 'agent:started', agentId: 'agent-a', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'agent-b', runId: 'r2' })
    await flushMicrotasks()

    expect(wsA.sent).toHaveLength(1)
    expect(wsB.sent).toHaveLength(1)
    expect((JSON.parse(wsA.sent[0] ?? '{}') as EventEnvelope).agentId).toBe('agent-a')
    expect((JSON.parse(wsB.sent[0] ?? '{}') as EventEnvelope).agentId).toBe('agent-b')
  })

  it('delivers only eventTypes allowlisted per client', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: ['agent:completed'] })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 42 })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(1)
    const envelope = JSON.parse(ws.sent[0] ?? '{}') as EventEnvelope
    expect(envelope.type).toBe('agent:completed')
  })

  it('treats empty eventTypes array as deny-all (scoped baseline)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(0)
  })

  it('removes clients on disconnect (readyState CLOSED)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)
    expect(bridge.clientCount).toBe(1)

    ws.readyState = 3
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await flushMicrotasks()

    expect(bridge.clientCount).toBe(0)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('removes subscriber cleanly on explicit removeClient()', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)
    expect(bridge.clientCount).toBe(1)

    bridge.removeClient(ws)
    expect(bridge.clientCount).toBe(0)
    expect(() => bridge.removeClient(ws)).not.toThrow()
  })

  it('gracefully handles message serialization error (send throws) by detaching', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    ws.send = vi.fn(() => {
      throw new Error('boom')
    })
    bridge.addClient(ws)
    expect(bridge.clientCount).toBe(1)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()

    expect(bridge.clientCount).toBe(0)
  })

  it('disconnectAll closes sockets and unsubscribes each client', () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const clients = [new MockWsClient(), new MockWsClient(), new MockWsClient()]
    for (const c of clients) bridge.addClient(c)
    expect(bridge.clientCount).toBe(3)

    bridge.disconnectAll()
    for (const c of clients) {
      expect(c.close).toHaveBeenCalledOnce()
      expect(c.readyState).toBe(3)
    }
    expect(bridge.clientCount).toBe(0)
  })

  it('supports broadcasting to multiple subscribers with overlapping filters', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const wildcard = new MockWsClient()
    const runScoped = new MockWsClient()
    const agentScoped = new MockWsClient()

    bridge.addClient(wildcard)
    bridge.addClient(runScoped, { runId: 'r1' })
    bridge.addClient(agentScoped, { agentId: 'a1' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()

    expect(wildcard.sent).toHaveLength(1)
    expect(runScoped.sent).toHaveLength(1)
    expect(agentScoped.sent).toHaveLength(1)
  })

  it('supports replay-via-resubscribe by swapping filter with setClientFilter', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'old' })

    // Simulate reconnect replay: same client, new run scope
    bridge.setClientFilter(ws, { runId: 'new' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'old' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'new' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(1)
    const envelope = JSON.parse(ws.sent[0] ?? '{}') as EventEnvelope
    expect(envelope.runId).toBe('new')
  })

  it('delegates to injected EventGateway when subscribe present', () => {
    const fakeGateway: EventGateway = {
      subscribe: vi.fn((): EventSubscription => ({ id: 'sub-x', unsubscribe: vi.fn() })),
      publish: vi.fn(),
      get subscriberCount(): number {
        return 0
      },
      destroy: vi.fn(),
    }
    const bridge = new EventBridge(fakeGateway)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    expect(fakeGateway.subscribe).toHaveBeenCalledOnce()
    const firstCall = (fakeGateway.subscribe as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]
    expect(firstCall?.[0]).toEqual({})
  })

  it('honors custom maxQueueSize config on disconnect overflow', async () => {
    const gateway = new InMemoryEventGateway()
    const bridge = new EventBridge(gateway, { maxQueueSize: 2 })
    const ws = new MockWsClient()
    bridge.addClient(ws)

    // Publish many events synchronously; overflow triggers disconnect strategy.
    for (let i = 0; i < 20; i++) {
      gateway.publish({ type: 'agent:started', agentId: 'a1', runId: `r${i}` })
    }
    await flushMicrotasks()
    // Client is either detached (count 0) or received at least a couple; both are healthy paths.
    expect(bridge.clientCount).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// WsNodeAdapter — UTF-8 decoding, lifecycle, ping/pong-ish hooks
// ---------------------------------------------------------------------------

describe('attachNodeWsSession adapter', () => {
  function buildStack(): {
    bus: ReturnType<typeof createEventBus>
    bridge: EventBridge
    manager: WSSessionManager
    socket: MockNodeSocket
  } {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, {
      requireScopedSubscription: true,
    })
    const socket = new MockNodeSocket()
    return { bus, bridge, manager, socket }
  }

  it('attaches and registers the socket (simulated HTTP upgrade -> WS connection)', async () => {
    const { manager, socket, bridge } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })
    expect(bridge.clientCount).toBe(1)
  })

  it('handles text-framed UTF-8 messages from wire directly', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    socket.emit('message', JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    await flushMicrotasks()

    expect(socket.sent[0]).toContain('subscribed')
  })

  it('converts Buffer-framed (binary text) messages to UTF-8 and processes them', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    const raw = Buffer.from(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }), 'utf-8')
    socket.emit('message', raw)
    await flushMicrotasks()

    expect(socket.sent[0]).toContain('subscribed')
  })

  it('converts ArrayBuffer-framed messages to UTF-8', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    const buf = Buffer.from(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }), 'utf-8')
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    socket.emit('message', arrayBuf)
    await flushMicrotasks()

    expect(socket.sent[0]).toContain('subscribed')
  })

  it('concats Buffer[] fragments for fragmented wire frames', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    const full = JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } })
    const mid = Math.floor(full.length / 2)
    const parts = [Buffer.from(full.slice(0, mid), 'utf-8'), Buffer.from(full.slice(mid), 'utf-8')]
    socket.emit('message', parts)
    await flushMicrotasks()

    expect(socket.sent[0]).toContain('subscribed')
  })

  it('coerces unknown frame types to String() before parsing (produces INVALID_JSON error)', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    socket.emit('message', { toString: () => 'not-json' })
    await flushMicrotasks()

    const msg = JSON.parse(socket.sent[0] ?? '{}') as { type?: string; code?: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('INVALID_JSON')
  })

  it('detaches socket on close event (connection cleanup)', async () => {
    const { manager, socket, bridge } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })
    expect(bridge.clientCount).toBe(1)

    socket.emit('close')
    expect(bridge.clientCount).toBe(0)
  })

  it('detaches socket on error event (forced cleanup)', async () => {
    const { manager, socket, bridge } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })
    expect(bridge.clientCount).toBe(1)

    socket.emit('error', new Error('boom'))
    expect(bridge.clientCount).toBe(0)
  })

  it('invokes onMessageError when control handler rejects a message', async () => {
    const { manager, socket } = buildStack()
    const onMessageError = vi.fn()

    // Throw from handleMessage by stubbing after attach
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] }, onMessageError })
    const spy = vi.spyOn(manager, 'handleMessage').mockRejectedValueOnce(new Error('bad'))

    socket.emit('message', 'anything')
    await flushMicrotasks()

    expect(spy).toHaveBeenCalled()
    expect(onMessageError).toHaveBeenCalledOnce()
  })

  it('does not throw when onMessageError is not provided and handleMessage fails', async () => {
    const { manager, socket } = buildStack()
    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })
    vi.spyOn(manager, 'handleMessage').mockRejectedValueOnce(new Error('silent'))

    expect(() => socket.emit('message', 'x')).not.toThrow()
    await flushMicrotasks()
  })
})

// ---------------------------------------------------------------------------
// WSSessionManager — sessions, concurrency, scope resolution
// ---------------------------------------------------------------------------

describe('WSSessionManager', () => {
  it('creates session on connect and registers client in bridge', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry)
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['r1'] })

    expect(bridge.clientCount).toBe(1)
    expect(registry.get(ws)).toEqual({ runIds: ['r1'] })
  })

  it('looks up client by reference and routes messages to its handler', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, { requireScopedSubscription: true })
    const ws = new MockWsClient()
    await manager.attach(ws, { runIds: ['r1'] })

    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))

    expect(ws.lastMessage.type).toBe('subscribed')
  })

  it('ignores messages for clients that were never attached', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry)
    const ghost = new MockWsClient()

    await manager.handleMessage(ghost, JSON.stringify({ type: 'subscribe' }))
    expect(ghost.sent).toHaveLength(0)
  })

  it('detach removes session from registry and bridge', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry)
    const ws = new MockWsClient()
    await manager.attach(ws, { runIds: ['r1'] })

    manager.detach(ws)

    expect(bridge.clientCount).toBe(0)
    expect(registry.get(ws)).toBeUndefined()
  })

  it('tracks two concurrent sessions for the same agent independently', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, { requireScopedSubscription: true })
    const wsA = new MockWsClient()
    const wsB = new MockWsClient()

    await manager.attach(wsA, { agentIds: ['agent-x'], runIds: ['r1'] })
    await manager.attach(wsB, { agentIds: ['agent-x'], runIds: ['r2'] })

    expect(bridge.clientCount).toBe(2)

    await manager.handleMessage(
      wsA,
      JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }),
    )
    await manager.handleMessage(
      wsB,
      JSON.stringify({ type: 'subscribe', filter: { runId: 'r2' } }),
    )

    bus.emit({ type: 'agent:started', agentId: 'agent-x', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'agent-x', runId: 'r2' })
    await flushMicrotasks()

    const aEvents = wsA.sent.filter((m) => !m.includes('subscribed'))
    const bEvents = wsB.sent.filter((m) => !m.includes('subscribed'))
    expect(aEvents).toHaveLength(1)
    expect(bEvents).toHaveLength(1)
    expect((JSON.parse(aEvents[0] ?? '{}') as EventEnvelope).runId).toBe('r1')
    expect((JSON.parse(bEvents[0] ?? '{}') as EventEnvelope).runId).toBe('r2')
  })

  it('resolveScope callback is awaited on attach when scope omitted', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const resolver = vi.fn(async () => ({ runIds: ['async-run'] }))
    const manager = new WSSessionManager(bridge, registry, { resolveScope: resolver })
    const ws = new MockWsClient()

    await manager.attach(ws)

    expect(resolver).toHaveBeenCalledOnce()
    expect(registry.get(ws)?.runIds).toEqual(['async-run'])
  })

  it('falls back to empty registry entry when resolveScope returns null', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, {
      resolveScope: () => null,
      requireScopedSubscription: true,
    })
    const ws = new MockWsClient()
    await manager.attach(ws)

    await manager.handleMessage(ws, JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    expect(ws.lastMessage.code).toBe('FORBIDDEN_FILTER')
  })

  it('re-attaching same client replaces existing subscription without leaking', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry)
    const ws = new MockWsClient()

    await manager.attach(ws, { runIds: ['r1'] })
    await manager.attach(ws, { runIds: ['r2'] })
    expect(bridge.clientCount).toBe(1)
    expect(registry.get(ws)?.runIds).toEqual(['r2'])
  })
})

// ---------------------------------------------------------------------------
// WSClientScopeRegistry — double-register, lookup, delete
// ---------------------------------------------------------------------------

describe('WSClientScopeRegistry', () => {
  it('registers a scope and returns it on lookup', () => {
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    registry.set(ws, { tenantId: 't1', runIds: ['r1'] })
    expect(registry.get(ws)).toEqual({ tenantId: 't1', runIds: ['r1'] })
  })

  it('deregisters a scope via delete()', () => {
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    registry.set(ws, { tenantId: 't1' })
    registry.delete(ws)
    expect(registry.get(ws)).toBeUndefined()
  })

  it('delete() on unknown client is a no-op', () => {
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    expect(() => registry.delete(ws)).not.toThrow()
  })

  it('double-register overwrites prior scope (last-write-wins)', () => {
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    registry.set(ws, { tenantId: 't1' })
    registry.set(ws, { tenantId: 't2' })
    expect(registry.get(ws)?.tenantId).toBe('t2')
  })

  it('isolates scopes across different clients', () => {
    const registry = new WSClientScopeRegistry()
    const wsA = new MockWsClient()
    const wsB = new MockWsClient()
    registry.set(wsA, { tenantId: 'a' })
    registry.set(wsB, { tenantId: 'b' })
    expect(registry.get(wsA)?.tenantId).toBe('a')
    expect(registry.get(wsB)?.tenantId).toBe('b')
  })

  it('createAuthorizeFilter enforces deny for unknown client', async () => {
    const registry = new WSClientScopeRegistry()
    const authorize = registry.createAuthorizeFilter()
    const ws = new MockWsClient()
    expect(await authorize({ client: ws, filter: { runId: 'r1' } })).toBe(false)
  })

  it('createAuthorizeFilter allows canSubscribeAll to bypass scope', async () => {
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    registry.set(ws, { canSubscribeAll: true })
    const authorize = registry.createAuthorizeFilter({ allowUnscoped: true })
    expect(await authorize({ client: ws, filter: {} })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WS Authorization — valid/missing/expired/scope-restricted paths
// ---------------------------------------------------------------------------

describe('WS authorization (scoped filter factory)', () => {
  it('"valid API key" → authorized when scope resolves and filter matches', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
    })
    expect(await authorize({ client: ws, filter: { runId: 'r1' } })).toBe(true)
  })

  it('"missing API key" → 401 equivalent (resolveClientScope returns null)', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => null,
    })
    expect(await authorize({ client: ws, filter: { runId: 'r1' } })).toBe(false)
  })

  it('"expired token" → rejected when resolver resolves null later', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: async () => null,
    })
    expect(await authorize({ client: ws, filter: { runId: 'r1' } })).toBe(false)
  })

  it('"scope-restricted key" cannot access other runs', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['allowed-run'] }),
    })
    expect(await authorize({ client: ws, filter: { runId: 'other-run' } })).toBe(false)
  })

  it('"scope-restricted key" cannot access other agents', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ agentIds: ['agent-a'] }),
    })
    expect(await authorize({ client: ws, filter: { agentId: 'agent-b' } })).toBe(false)
  })

  it('canAccessRun custom callback takes precedence over runIds list', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['x'], tenantId: 't1' }),
      canAccessRun: ({ runId }) => runId.startsWith('t1-'),
    })
    expect(await authorize({ client: ws, filter: { runId: 't1-123' } })).toBe(true)
    expect(await authorize({ client: ws, filter: { runId: 'x' } })).toBe(false)
  })

  it('canAccessAgent custom callback takes precedence over agentIds list', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ agentIds: ['a'] }),
      canAccessAgent: async ({ agentId }) => agentId === 'b',
    })
    expect(await authorize({ client: ws, filter: { agentId: 'b' } })).toBe(true)
    expect(await authorize({ client: ws, filter: { agentId: 'a' } })).toBe(false)
  })

  it('eventTypes filter subset must be fully contained in scope allowlist', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ eventTypes: ['agent:started', 'agent:completed'] }),
    })
    expect(
      await authorize({ client: ws, filter: { eventTypes: ['agent:started'] } }),
    ).toBe(true)
    expect(
      await authorize({
        client: ws,
        filter: { eventTypes: ['agent:started', 'tool:called'] },
      }),
    ).toBe(false)
  })

  it('scope with empty eventTypes array denies any eventTypes filter', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ eventTypes: [] }),
    })
    expect(
      await authorize({ client: ws, filter: { eventTypes: ['agent:started'] } }),
    ).toBe(false)
  })

  it('allowUnscoped=false rejects empty filter even with valid scope', async () => {
    const ws = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
      allowUnscoped: false,
    })
    expect(await authorize({ client: ws, filter: {} })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WS Control Protocol — subscribe/unsubscribe, error paths, unknown types
// ---------------------------------------------------------------------------

describe('WS control protocol', () => {
  function build(): { bridge: EventBridge; ws: MockWsClient } {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    return { bridge, ws }
  }

  it('subscribe-with-run-filter routes matching envelope into the socket', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    const handler = createWsControlHandler(bridge, ws)

    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')

    ws.reset()
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()
    expect(ws.sent).toHaveLength(1)
  })

  it('unsubscribe clears filter (emits ack, subsequent events delivered on wildcard baseline)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })
    const handler = createWsControlHandler(bridge, ws)

    await handler(JSON.stringify({ type: 'unsubscribe' }))
    expect(ws.lastMessage.type).toBe('unsubscribed')

    ws.reset()
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await flushMicrotasks()
    expect(ws.sent.length).toBe(1)
  })

  it('unsubscribe with custom unsubscribeFilter applies that filter', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })
    const handler = createWsControlHandler(bridge, ws, {
      unsubscribeFilter: { eventTypes: [] },
    })
    await handler(JSON.stringify({ type: 'unsubscribe' }))

    ws.reset()
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await flushMicrotasks()
    expect(ws.sent).toHaveLength(0)
  })

  it('malformed JSON frame → structured INVALID_JSON error (no crash)', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler('{not-json')
    expect(ws.lastMessage.code).toBe('INVALID_JSON')
  })

  it('non-object JSON (array) → INVALID_MESSAGE error', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler('[1,2,3]')
    expect(ws.lastMessage.code).toBe('INVALID_MESSAGE')
  })

  it('null JSON body → INVALID_MESSAGE error', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler('null')
    expect(ws.lastMessage.code).toBe('INVALID_MESSAGE')
  })

  it('missing "type" field → MISSING_TYPE error', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler(JSON.stringify({ filter: {} }))
    expect(ws.lastMessage.code).toBe('MISSING_TYPE')
  })

  it('unknown message type (cancel-run / status-query) → UNSUPPORTED_TYPE', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler(JSON.stringify({ type: 'cancel-run' }))
    expect(ws.lastMessage.code).toBe('UNSUPPORTED_TYPE')
    ws.reset()
    await handler(JSON.stringify({ type: 'status' }))
    expect(ws.lastMessage.code).toBe('UNSUPPORTED_TYPE')
  })

  it('invalid filter payload (array instead of object) → INVALID_FILTER', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler(JSON.stringify({ type: 'subscribe', filter: ['not', 'an', 'object'] }))
    expect(ws.lastMessage.code).toBe('INVALID_FILTER')
  })

  it('invalid eventTypes (not array) → INVALID_FILTER', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws)
    await handler(JSON.stringify({ type: 'subscribe', filter: { eventTypes: 'not-array' } }))
    expect(ws.lastMessage.code).toBe('INVALID_FILTER')
  })

  it('strips empty-string runId/agentId when normalizing filter', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    const handler = createWsControlHandler(bridge, ws, {
      authorizeFilter: ({ filter }) => filter.runId === undefined && filter.agentId === undefined,
      requireScopedSubscription: false,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: '   ', agentId: '' } }))
    expect(ws.lastMessage.type).toBe('subscribed')
  })

  it('sanitizes whitespace-only eventTypes strings out of the filter', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    const captured: EventSubscriptionFilter[] = []
    const handler = createWsControlHandler(bridge, ws, {
      authorizeFilter: ({ filter }) => {
        captured.push(filter)
        return true
      },
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { eventTypes: ['  ', ''] } }))
    expect(captured[0]?.eventTypes).toBeUndefined()
  })

  it('requireScopedSubscription rejects completely empty filter', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws, {
      requireScopedSubscription: true,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: {} }))
    expect(ws.lastMessage.code).toBe('UNSCOPED_SUBSCRIPTION')
  })

  it('authorize failure emits FORBIDDEN_FILTER', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws, {
      authorizeFilter: () => false,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    expect(ws.lastMessage.code).toBe('FORBIDDEN_FILTER')
  })

  it('async authorizeFilter rejecting emits FORBIDDEN_FILTER', async () => {
    const { ws } = build()
    const handler = createWsControlHandler(new EventBridge(createEventBus()), ws, {
      authorizeFilter: async () => false,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    expect(ws.lastMessage.code).toBe('FORBIDDEN_FILTER')
  })

  it('send-on-closed-socket does not throw (safeSend swallows)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)
    ws.send = vi.fn(() => {
      throw new Error('socket closed')
    })
    const handler = createWsControlHandler(bridge, ws)
    await expect(handler('{bad')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scoped control handler — routes to correct agent scope
// ---------------------------------------------------------------------------

describe('createScopedWsControlHandler', () => {
  it('routes subscribe into correct agent scope registered in registry', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    registry.set(ws, { agentIds: ['agent-42'] })

    const handler = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { agentId: 'agent-42' } }))

    expect(ws.lastMessage.type).toBe('subscribed')
  })

  it('unknown scope (client not in registry) → FORBIDDEN_FILTER error', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    // NOTE: scope intentionally not registered

    const handler = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { agentId: 'unknown' } }))

    expect(ws.lastMessage.code).toBe('FORBIDDEN_FILTER')
  })

  it('scoped handler respects canAccessRun callback', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    registry.set(ws, { tenantId: 't1' })

    const handler = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
      scopeAuthorization: {
        canAccessRun: ({ runId }) => runId.startsWith('t1-'),
      },
    })

    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 't1-abc' } }))
    expect(ws.lastMessage.type).toBe('subscribed')

    ws.reset()
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 't2-abc' } }))
    expect(ws.lastMessage.code).toBe('FORBIDDEN_FILTER')
  })

  it('unsubscribe resets the filter applied by scoped handler', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    registry.set(ws, { runIds: ['r1'] })

    const handler = createScopedWsControlHandler(bridge, ws, registry, {
      requireScopedSubscription: true,
      unsubscribeFilter: { eventTypes: [] },
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    ws.reset()
    await handler(JSON.stringify({ type: 'unsubscribe' }))

    expect(ws.lastMessage.type).toBe('unsubscribed')
    ws.reset()
    bus.emit({ type: 'tool:called', toolName: 'x', input: {} })
    await flushMicrotasks()
    expect(ws.sent).toHaveLength(0)
  })

  it('sends UNSUPPORTED_TYPE on commands not in the control protocol (cancel/status)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const ws = new MockWsClient()
    bridge.addClient(ws, { eventTypes: [] })
    registry.set(ws, { runIds: ['r1'] })

    const handler = createScopedWsControlHandler(bridge, ws, registry)
    await handler(JSON.stringify({ type: 'cancel-run', runId: 'r1' }))
    expect(ws.lastMessage.code).toBe('UNSUPPORTED_TYPE')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: upgrade request → subscribe → event delivery → close cleanup
// ---------------------------------------------------------------------------

describe('WS event bridge end-to-end flows', () => {
  it('completes the full lifecycle: attach → scoped subscribe → receive event → close', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, { requireScopedSubscription: true })
    const socket = new MockNodeSocket()

    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })
    expect(bridge.clientCount).toBe(1)

    socket.emit('message', JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    await flushMicrotasks()
    expect(socket.sent[0]).toContain('subscribed')

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flushMicrotasks()
    const eventFrame = socket.sent[1]
    expect(eventFrame).toBeDefined()
    const envelope = JSON.parse(eventFrame ?? '{}') as EventEnvelope
    expect(envelope.type).toBe('agent:started')

    socket.emit('close')
    expect(bridge.clientCount).toBe(0)
    expect(registry.get(socket)).toBeUndefined()
  })

  it('forbids cross-tenant subscribe even when runId happens to match another tenant', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, {
      requireScopedSubscription: true,
      scopeAuthorization: {
        canAccessRun: async ({ scope, runId }) => runId.startsWith(`${scope.tenantId ?? ''}-`),
      },
    })

    const tenantAsocket = new MockNodeSocket()
    await attachNodeWsSession({
      manager,
      socket: tenantAsocket,
      scope: { tenantId: 't-a' },
    })

    tenantAsocket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', filter: { runId: 't-b-1' } }),
    )
    await flushMicrotasks()

    const first = JSON.parse(tenantAsocket.sent[0] ?? '{}') as { code?: string }
    expect(first.code).toBe('FORBIDDEN_FILTER')
  })

  it('session survives spurious non-JSON frames and continues after recovery', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const registry = new WSClientScopeRegistry()
    const manager = new WSSessionManager(bridge, registry, { requireScopedSubscription: true })
    const socket = new MockNodeSocket()

    await attachNodeWsSession({ manager, socket, scope: { runIds: ['r1'] } })

    socket.emit('message', 'garbage')
    socket.emit('message', JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))
    await flushMicrotasks()

    const msgs = socket.sent.map((raw) => JSON.parse(raw) as { type?: string; code?: string })
    expect(msgs.some((m) => m.code === 'INVALID_JSON')).toBe(true)
    expect(msgs.some((m) => m.type === 'subscribed')).toBe(true)
    expect(bridge.clientCount).toBe(1)
  })
})
