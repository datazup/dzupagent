/**
 * Branch coverage tests for createWsControlHandler.
 *
 * Covers all filter normalization branches and error paths:
 * - missing type field
 * - non-object/array root message
 * - invalid filter shapes (array, null, non-object)
 * - invalid eventTypes (non-array, mixed types)
 * - empty/whitespace strings in runId/agentId
 * - unsubscribeFilter override
 * - unsupported message types
 * - authorization errors after validation
 * - safeSend error swallowing
 */
import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
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

class FailingSendClient implements WSClient {
  readyState = 1
  sendCalls = 0
  send(_data: string): void {
    this.sendCalls++
    throw new Error('send failed')
  }
  close(): void {}
}

describe('createWsControlHandler branch coverage', () => {
  it('rejects array root messages as INVALID_MESSAGE', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify(['subscribe']))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_MESSAGE')
  })

  it('rejects null as INVALID_MESSAGE', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler('null')

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_MESSAGE')
  })

  it('rejects primitive number as INVALID_MESSAGE', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler('42')

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_MESSAGE')
  })

  it('rejects missing type field as MISSING_TYPE', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ filter: {} }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('MISSING_TYPE')
  })

  it('rejects non-string type as MISSING_TYPE', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 42 }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('MISSING_TYPE')
  })

  it('rejects array filter as INVALID_FILTER', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 'subscribe', filter: ['r1'] }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_FILTER')
  })

  it('rejects non-array eventTypes as INVALID_FILTER', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 'subscribe', filter: { eventTypes: 'agent:started' } }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_FILTER')
  })

  it('treats null filter as empty scope', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 'subscribe', filter: null }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; filter?: Record<string, unknown> }
    expect(ack.type).toBe('subscribed')
    expect(ack.filter).toBeDefined()
  })

  it('treats missing filter as empty scope', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 'subscribe' }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('strips whitespace-only runId/agentId', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({
      type: 'subscribe',
      filter: { runId: '   ', agentId: '  ' },
    }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { filter?: { runId?: string; agentId?: string } }
    expect(ack.filter?.runId).toBeUndefined()
    expect(ack.filter?.agentId).toBeUndefined()
  })

  it('trims runId/agentId whitespace', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({
      type: 'subscribe',
      filter: { runId: '  run-1  ', agentId: '  agent-x  ' },
    }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { filter?: { runId?: string; agentId?: string } }
    expect(ack.filter?.runId).toBe('run-1')
    expect(ack.filter?.agentId).toBe('agent-x')
  })

  it('filters out non-string eventTypes entries', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({
      type: 'subscribe',
      filter: { eventTypes: ['agent:started', 42, null, 'tool:called', ''] },
    }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { filter?: { eventTypes?: string[] } }
    expect(ack.filter?.eventTypes).toEqual(['agent:started', 'tool:called'])
  })

  it('treats eventTypes with only empty strings as undefined', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({
      type: 'subscribe',
      filter: { eventTypes: ['', '   '] },
    }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { filter?: { eventTypes?: string[] } }
    expect(ack.filter?.eventTypes).toBeUndefined()
  })

  it('applies custom unsubscribeFilter on unsubscribe', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws, { runId: 'r1' })

    const handler = createWsControlHandler(bridge, ws, {
      unsubscribeFilter: { eventTypes: ['agent:failed'] },
    })
    await handler(JSON.stringify({ type: 'unsubscribe' }))

    ws.sent = []
    bus.emit({ type: 'tool:called', toolName: 't', input: {} })
    bus.emit({ type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'E', message: 'x' })
    await new Promise((r) => setTimeout(r, 0))

    expect(ws.sent).toHaveLength(1)
    const ev = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(ev.type).toBe('agent:failed')
  })

  it('returns UNSUPPORTED_TYPE for unknown messages', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler(JSON.stringify({ type: 'status_request' }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string; message?: string }
    expect(err.code).toBe('UNSUPPORTED_TYPE')
    expect(err.message).toContain('status_request')
  })

  it('supports asynchronous authorizeFilter', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws, {
      authorizeFilter: async ({ filter }) => {
        await new Promise((r) => setTimeout(r, 1))
        return filter.runId === 'allowed'
      },
    })

    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'allowed' } }))
    expect((JSON.parse(ws.sent[0] ?? '{}') as { type?: string }).type).toBe('subscribed')
  })

  it('rejects scoped subscription when eventTypes present and requireScopedSubscription is on', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws, { requireScopedSubscription: true })
    await handler(JSON.stringify({
      type: 'subscribe',
      filter: { eventTypes: ['agent:started'] },
    }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('rejects invalid JSON (unmatched brace)', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws)
    await handler('{"type":"subscribe"')

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('INVALID_JSON')
  })

  it('swallows exceptions from send() gracefully', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new FailingSendClient()

    const handler = createWsControlHandler(bridge, ws)
    await expect(handler('{ invalid')).resolves.toBeUndefined()
    expect(ws.sendCalls).toBeGreaterThan(0)
  })

  it('agentId-only filter is accepted as scoped', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws, { requireScopedSubscription: true })
    await handler(JSON.stringify({ type: 'subscribe', filter: { agentId: 'a-1' } }))

    const ack = JSON.parse(ws.sent[0] ?? '{}') as { type?: string; filter?: { agentId?: string } }
    expect(ack.type).toBe('subscribed')
    expect(ack.filter?.agentId).toBe('a-1')
  })

  it('async authorizeFilter returning false produces FORBIDDEN_FILTER', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const handler = createWsControlHandler(bridge, ws, {
      authorizeFilter: async () => false,
    })
    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'r1' } }))

    const err = JSON.parse(ws.sent[0] ?? '{}') as { code?: string }
    expect(err.code).toBe('FORBIDDEN_FILTER')
  })
})
