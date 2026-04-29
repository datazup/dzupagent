import { describe, expect, it } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { createWsControlHandler } from '../control-protocol.js'
import { EventBridge, type WSClient } from '../event-bridge.js'

class MockWsClient implements WSClient {
  readyState = 1
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  get lastMessage(): { type?: string; code?: string; filter?: { runId?: string } } {
    return JSON.parse(this.sent.at(-1) ?? '{}') as {
      type?: string
      code?: string
      filter?: { runId?: string }
    }
  }
}

function createHarness(): { bridge: EventBridge; ws: MockWsClient } {
  const bridge = new EventBridge(createEventBus())
  const ws = new MockWsClient()
  bridge.addClient(ws, { eventTypes: [] })
  return { bridge, ws }
}

describe('createWsControlHandler subscription scoping defaults', () => {
  it('rejects omitted subscribe filters by default', async () => {
    const { bridge, ws } = createHarness()
    const handler = createWsControlHandler(bridge, ws)

    await handler(JSON.stringify({ type: 'subscribe' }))

    expect(ws.lastMessage.type).toBe('error')
    expect(ws.lastMessage.code).toBe('UNSCOPED_SUBSCRIPTION')
  })

  it('accepts scoped subscribe filters by default', async () => {
    const { bridge, ws } = createHarness()
    const handler = createWsControlHandler(bridge, ws)

    await handler(JSON.stringify({ type: 'subscribe', filter: { runId: 'run-1' } }))

    expect(ws.lastMessage.type).toBe('subscribed')
    expect(ws.lastMessage.filter?.runId).toBe('run-1')
  })

  it('allows omitted subscribe filters only with explicit unsafe opt-in', async () => {
    const { bridge, ws } = createHarness()
    const handler = createWsControlHandler(bridge, ws, {
      allowUnscopedSubscriptions: true,
    })

    await handler(JSON.stringify({ type: 'subscribe' }))

    expect(ws.lastMessage.type).toBe('subscribed')
    expect(ws.lastMessage.filter).toEqual({})
  })
})
