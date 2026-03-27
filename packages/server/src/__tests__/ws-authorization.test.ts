import { describe, it, expect } from 'vitest'
import { createScopedAuthorizeFilter } from '../ws/authorization.js'
import type { WSClient } from '../ws/event-bridge.js'

class MockWsClient implements WSClient {
  readyState = 1
  send(_data: string): void {}
  close(): void {
    this.readyState = 3
  }
}

describe('createScopedAuthorizeFilter', () => {
  it('rejects unscoped filter by default', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
    })

    const ok = await authorize({ client, filter: {} })
    expect(ok).toBe(false)
  })

  it('allows run-scoped subscriptions when run is in scope', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
    })

    const ok = await authorize({ client, filter: { runId: 'r1' } })
    expect(ok).toBe(true)
  })

  it('rejects event types outside scope', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ eventTypes: ['agent:started', 'agent:completed'] }),
    })

    const ok = await authorize({
      client,
      filter: { eventTypes: ['agent:started', 'tool:called'] },
    })
    expect(ok).toBe(false)
  })

  it('supports custom access callbacks', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ tenantId: 't1' }),
      canAccessRun: ({ runId }) => runId.startsWith('t1-'),
    })

    expect(await authorize({ client, filter: { runId: 't1-123' } })).toBe(true)
    expect(await authorize({ client, filter: { runId: 't2-123' } })).toBe(false)
  })

  it('can allow unscoped filters explicitly', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ canSubscribeAll: true }),
      allowUnscoped: true,
    })

    const ok = await authorize({ client, filter: {} })
    expect(ok).toBe(true)
  })
})
