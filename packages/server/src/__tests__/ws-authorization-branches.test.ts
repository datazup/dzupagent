/**
 * Branch coverage tests for createScopedAuthorizeFilter.
 *
 * Exercises: agentId checks (with/without custom callback), canAccessAgent,
 * eventTypes with empty scope, canSubscribeAll bypass, null scope, allowUnscoped.
 */
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

describe('createScopedAuthorizeFilter branch coverage', () => {
  it('rejects when resolveClientScope returns null', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => null,
    })

    const ok = await authorize({ client, filter: { runId: 'r1' } })
    expect(ok).toBe(false)
  })

  it('canSubscribeAll bypasses per-resource checks', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ canSubscribeAll: true }),
    })

    expect(await authorize({ client, filter: { runId: 'any-run' } })).toBe(true)
    expect(await authorize({ client, filter: { agentId: 'any-agent' } })).toBe(true)
    expect(await authorize({ client, filter: { eventTypes: ['tool:called'] } })).toBe(true)
  })

  it('allows agentId when scope includes it', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ agentIds: ['a1', 'a2'] }),
    })

    expect(await authorize({ client, filter: { agentId: 'a1' } })).toBe(true)
    expect(await authorize({ client, filter: { agentId: 'a3' } })).toBe(false)
  })

  it('uses custom canAccessAgent when provided', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ tenantId: 't1' }),
      canAccessAgent: ({ agentId }) => agentId.startsWith('t1-'),
    })

    expect(await authorize({ client, filter: { agentId: 't1-x' } })).toBe(true)
    expect(await authorize({ client, filter: { agentId: 't2-x' } })).toBe(false)
  })

  it('async canAccessAgent is supported', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({}),
      canAccessAgent: async ({ agentId }) => {
        await new Promise((r) => setTimeout(r, 1))
        return agentId === 'allowed'
      },
    })

    expect(await authorize({ client, filter: { agentId: 'allowed' } })).toBe(true)
    expect(await authorize({ client, filter: { agentId: 'blocked' } })).toBe(false)
  })

  it('rejects eventTypes when scope has no eventTypes', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({}),
    })

    expect(await authorize({ client, filter: { eventTypes: ['agent:started'] } })).toBe(false)
  })

  it('rejects eventTypes when scope eventTypes is empty array', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ eventTypes: [] }),
    })

    expect(await authorize({ client, filter: { eventTypes: ['agent:started'] } })).toBe(false)
  })

  it('accepts eventTypes fully covered by scope', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ eventTypes: ['agent:started', 'agent:completed', 'tool:called'] }),
    })

    expect(await authorize({ client, filter: { eventTypes: ['agent:started'] } })).toBe(true)
    expect(await authorize({ client, filter: { eventTypes: ['agent:started', 'tool:called'] } })).toBe(true)
  })

  it('combines runId + agentId + eventTypes checks', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({
        runIds: ['r1'],
        agentIds: ['a1'],
        eventTypes: ['agent:started'],
      }),
    })

    expect(await authorize({ client, filter: { runId: 'r1', agentId: 'a1', eventTypes: ['agent:started'] } })).toBe(true)
    expect(await authorize({ client, filter: { runId: 'r2', agentId: 'a1', eventTypes: ['agent:started'] } })).toBe(false)
    expect(await authorize({ client, filter: { runId: 'r1', agentId: 'a2', eventTypes: ['agent:started'] } })).toBe(false)
    expect(await authorize({ client, filter: { runId: 'r1', agentId: 'a1', eventTypes: ['tool:called'] } })).toBe(false)
  })

  it('allows unscoped filter when allowUnscoped is true and scope valid', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
      allowUnscoped: true,
    })

    expect(await authorize({ client, filter: {} })).toBe(true)
  })

  it('rejects unscoped filter when allowUnscoped is true but scope is null', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => null,
      allowUnscoped: true,
    })

    expect(await authorize({ client, filter: {} })).toBe(false)
  })

  it('uses canAccessRun when provided and fails agentId via default check', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ agentIds: ['a1'] }),
      canAccessRun: () => true,
    })

    // run is allowed by custom callback, but agentId fails default scope check
    expect(await authorize({ client, filter: { runId: 'x', agentId: 'a2' } })).toBe(false)
    expect(await authorize({ client, filter: { runId: 'x', agentId: 'a1' } })).toBe(true)
  })

  it('treats empty string runId as unscoped (ignored by isUnscoped)', async () => {
    const client = new MockWsClient()
    const authorize = createScopedAuthorizeFilter({
      resolveClientScope: () => ({ runIds: ['r1'] }),
    })

    // runId is falsy/empty → effectively unscoped → rejected
    expect(await authorize({ client, filter: { runId: '' } })).toBe(false)
  })
})
