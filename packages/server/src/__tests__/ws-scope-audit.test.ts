import { it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core/events'
import { createScopedAuthorizeFilter } from '../ws/authorization.js'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { createWsControlHandler } from '../ws/control-protocol.js'
it.each([false, true])('unsubscribe stops authorized and unauthorized delivery (tenant scoped: %s)', async tenantScoped => {
  const bus = createEventBus()
  const sent: string[] = []
  const client: WSClient = { readyState: 1, send: data => { sent.push(data) }, close() {} }
  const bridge = new EventBridge(bus, tenantScoped ? { tenantResolver: () => 'tenant', requireTenantScope: true } : {})
  bridge.addClient(client, { runId: 'allowed' })
  const control = createWsControlHandler(bridge, client, { unsubscribeFilter: {} })
  await control(JSON.stringify({ type: 'unsubscribe' }))
  sent.length = 0
  for (const runId of ['allowed', 'forbidden']) bus.emit({ type: 'agent:started', agentId: 'agent', runId, tenantId: 'tenant' })
  await Promise.resolve()
  expect(sent).toEqual([])
  bridge.removeClient(client)
})
it('rejects every omitted permission axis in a subscription', async () => {
  const client: WSClient = { readyState: 1, send() {}, close() {} }
  const authorize = createScopedAuthorizeFilter({ resolveClientScope: () => ({ runIds: ['r'], agentIds: ['a'], eventTypes: ['agent:started'] }) })
  expect(await authorize({ client, filter: { eventTypes: ['agent:started'] } })).toBe(false)
  expect(await authorize({ client, filter: { agentId: 'a', eventTypes: ['agent:started'] } })).toBe(false)
  expect(await authorize({ client, filter: { runId: 'r', eventTypes: ['agent:started'] } })).toBe(false)
  expect(await authorize({ client, filter: { runId: 'r', agentId: 'a', eventTypes: ['agent:started'] } })).toBe(true)
})
