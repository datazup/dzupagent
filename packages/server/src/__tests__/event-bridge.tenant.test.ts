/**
 * Tenant-scoping tests for EventBridge (DZUPAGENT-SEC-M-WS-01).
 *
 * Verifies that a WS client's authenticated tenant — resolved via the bridge
 * `tenantResolver` config — is lifted into the gateway subscription filter so
 * the gateway's fail-closed `matchesFilter` enforces strict per-tenant
 * isolation. Mirrors the SSE wiring tested in `event-gateway.tenant.test.ts`.
 */
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

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('EventBridge tenant scoping (SEC-M-WS-01)', () => {
  it('delivers only same-tenant envelopes to a tenant-scoped WS client', async () => {
    const bus = createEventBus()
    const tenantsByClient = new WeakMap<WSClient, string>()
    const bridge = new EventBridge(bus, {
      tenantResolver: (ws) => tenantsByClient.get(ws),
    })

    const ws = new MockWsClient()
    tenantsByClient.set(ws, 'tenant-A')
    bridge.addClient(ws, { eventTypes: ['agent:started'] })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-A' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(1)
    const env = JSON.parse(ws.sent[0] ?? '{}') as { tenantId?: string }
    expect(env.tenantId).toBe('tenant-A')
  })

  it('drops cross-tenant envelopes destined for a different tenant', async () => {
    const bus = createEventBus()
    const tenantsByClient = new WeakMap<WSClient, string>()
    const bridge = new EventBridge(bus, {
      tenantResolver: (ws) => tenantsByClient.get(ws),
    })

    const ws = new MockWsClient()
    tenantsByClient.set(ws, 'tenant-A')
    bridge.addClient(ws, { eventTypes: ['agent:started'] })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-B' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(0)
  })

  it('drops unstamped envelopes for a tenant-scoped WS client (fail-closed via DEFAULT_TENANT_ID)', async () => {
    const bus = createEventBus()
    const tenantsByClient = new WeakMap<WSClient, string>()
    const bridge = new EventBridge(bus, {
      tenantResolver: (ws) => tenantsByClient.get(ws),
    })

    const ws = new MockWsClient()
    tenantsByClient.set(ws, 'tenant-A')
    bridge.addClient(ws, { eventTypes: ['tool:called'] })

    // tool:called has no tenantId field → envelope tenantId falls back to
    // DEFAULT_TENANT_ID ('default'), which strict-equality mismatches with
    // 'tenant-A' inside matchesFilter — the envelope is dropped.
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(0)
  })

  it('preserves legacy wildcard fan-out when no tenant resolves (single-tenant mode)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus, {
      // Resolver returns undefined for every client (anonymous WS).
      tenantResolver: () => undefined,
    })

    const ws = new MockWsClient()
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-A' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2', tenantId: 'tenant-B' })
    bus.emit({ type: 'tool:called', toolName: 'search', input: {} })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(3)
  })

  it('preserves prior behaviour when no tenantResolver is configured at all', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)

    const ws = new MockWsClient()
    bridge.addClient(ws)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-A' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2', tenantId: 'tenant-B' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(2)
  })

  it('honours an explicit filter.tenantId over the resolver (caller-set precedence)', async () => {
    const bus = createEventBus()
    const tenantsByClient = new WeakMap<WSClient, string>()
    const bridge = new EventBridge(bus, {
      tenantResolver: (ws) => tenantsByClient.get(ws),
    })

    const ws = new MockWsClient()
    // Resolver would say tenant-A, but caller pins tenant-B explicitly.
    tenantsByClient.set(ws, 'tenant-A')
    bridge.addClient(ws, { tenantId: 'tenant-B', eventTypes: ['agent:started'] })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-A' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2', tenantId: 'tenant-B' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(1)
    const env = JSON.parse(ws.sent[0] ?? '{}') as { tenantId?: string }
    expect(env.tenantId).toBe('tenant-B')
  })

  it('setClientFilter retains tenant scoping when the filter is updated', async () => {
    const bus = createEventBus()
    const tenantsByClient = new WeakMap<WSClient, string>()
    const bridge = new EventBridge(bus, {
      tenantResolver: (ws) => tenantsByClient.get(ws),
    })

    const ws = new MockWsClient()
    tenantsByClient.set(ws, 'tenant-A')
    bridge.addClient(ws, { eventTypes: ['agent:started'] })

    // Client switches to a runId-scoped filter — tenantResolver should still
    // be honoured so tenant isolation isn't lost on filter swap.
    bridge.setClientFilter(ws, { runId: 'r1' })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-A' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1', tenantId: 'tenant-B' })
    await flushMicrotasks()

    expect(ws.sent).toHaveLength(1)
    const env = JSON.parse(ws.sent[0] ?? '{}') as { tenantId?: string }
    expect(env.tenantId).toBe('tenant-A')
  })
})
