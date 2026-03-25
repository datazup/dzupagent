import { describe, it, expect } from 'vitest'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import type { WSClient } from '../ws/event-bridge.js'

class MockWsClient implements WSClient {
  readyState = 1
  send(_data: string): void {}
  close(): void {
    this.readyState = 3
  }
}

describe('WSClientScopeRegistry', () => {
  it('stores and retrieves client scope', () => {
    const registry = new WSClientScopeRegistry()
    const client = new MockWsClient()

    registry.set(client, { tenantId: 't1', runIds: ['r1'] })
    expect(registry.get(client)?.tenantId).toBe('t1')
    expect(registry.get(client)?.runIds).toEqual(['r1'])
  })

  it('authorizes via created authorize filter', async () => {
    const registry = new WSClientScopeRegistry()
    const client = new MockWsClient()
    registry.set(client, { runIds: ['r1'] })

    const authorize = registry.createAuthorizeFilter()
    expect(await authorize({ client, filter: { runId: 'r1' } })).toBe(true)
    expect(await authorize({ client, filter: { runId: 'r2' } })).toBe(false)
  })
})
