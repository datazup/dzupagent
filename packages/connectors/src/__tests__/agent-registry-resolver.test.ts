/**
 * Tests for AgentRegistryAsyncToolResolver — verifies the AsyncToolResolver
 * contract against a mocked fetch implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AgentRegistryAsyncToolResolver,
  type FetchLike,
} from '../agent-registry-resolver.js'

function makeFetchStub(
  handlers: Array<{
    match: (url: string, init: Parameters<FetchLike>[1]) => boolean
    response:
      | {
          ok: boolean
          status: number
          statusText?: string
          body: unknown
        }
      | ((url: string) => never)
  }>,
): { fetch: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    for (const h of handlers) {
      if (h.match(url, init)) {
        if (typeof h.response === 'function') {
          h.response(url)
          throw new Error('unreachable')
        }
        return {
          ok: h.response.ok,
          status: h.response.status,
          statusText: h.response.statusText ?? 'OK',
          json: async () => h.response.body as unknown,
        } as Awaited<ReturnType<FetchLike>>
      }
    }
    return {
      ok: false,
      status: 500,
      statusText: 'unhandled',
      json: async () => ({}),
    } as Awaited<ReturnType<FetchLike>>
  }
  return { fetch, calls }
}

describe('AgentRegistryAsyncToolResolver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches the catalogue on first refresh and lists refs synchronously', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.endsWith('/agents'),
        response: {
          ok: true,
          status: 200,
          body: {
            agents: [
              { id: 'planner', displayName: 'Planner' },
              { id: 'researcher', name: 'Researcher' },
            ],
          },
        },
      },
    ])
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local/',
      fetch: stub.fetch,
    })

    expect(resolver.listAvailable()).toEqual([])
    await resolver.refreshCatalogue()
    expect(resolver.listAvailable()).toEqual(['planner', 'researcher'])
    // listAvailable is synchronous — no await, same result on re-entry.
    expect(resolver.listAvailable()).toEqual(['planner', 'researcher'])
  })

  it('resolve() returns a ResolvedTool with an agent handle', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.endsWith('/agents'),
        response: {
          ok: true,
          status: 200,
          body: [{ id: 'planner', displayName: 'Planner', inputSchema: { type: 'object' } }],
        },
      },
      {
        match: (url, init) =>
          url.endsWith('/agents/planner/invoke') && init?.method === 'POST',
        response: {
          ok: true,
          status: 200,
          body: { output: { plan: 'ok' }, runId: 'run-1', durationMs: 42 },
        },
      },
    ])
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch: stub.fetch,
    })
    await resolver.refreshCatalogue()

    const resolved = await resolver.resolve('planner')
    expect(resolved).not.toBeNull()
    expect(resolved?.kind).toBe('agent')
    expect(resolved?.ref).toBe('planner')
    expect(resolved?.handle).toMatchObject({
      kind: 'agent',
      id: 'planner',
      displayName: 'Planner',
    })

    interface InvokableHandle {
      invoke: (input: { prompt: string }) => Promise<{
        output: unknown
        runId: string
        durationMs: number
      }>
    }
    const handle = resolved!.handle as InvokableHandle
    const result = await handle.invoke({ prompt: 'plan me a quest' })
    expect(result).toEqual({ output: { plan: 'ok' }, runId: 'run-1', durationMs: 42 })
  })

  it('resolve() returns null for unknown refs (404 falls back to null)', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.endsWith('/agents'),
        response: { ok: true, status: 200, body: { agents: [] } },
      },
      {
        match: (url) => url.includes('/agents/unknown'),
        response: { ok: false, status: 404, statusText: 'Not Found', body: {} },
      },
    ])
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch: stub.fetch,
    })
    await resolver.refreshCatalogue()

    await expect(resolver.resolve('unknown')).resolves.toBeNull()
    await expect(resolver.resolve('')).resolves.toBeNull()
  })

  it('resolve() throws on infra failure (network error)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch,
      ttlMs: 10_000,
    })

    await expect(resolver.resolve('planner')).rejects.toThrow(/AgentRegistry request failed/)
  })

  it('resolve() throws on non-404 HTTP errors', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.endsWith('/agents'),
        response: { ok: false, status: 503, statusText: 'Service Unavailable', body: {} },
      },
    ])
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch: stub.fetch,
    })

    await expect(resolver.resolve('planner')).rejects.toThrow(/503/)
  })

  it('refreshes the catalogue after TTL expiry', async () => {
    let agents: Array<{ id: string }> = [{ id: 'planner' }]
    const fetch: FetchLike = vi.fn(async (url) => {
      const urlStr = url.toString()
      if (urlStr.endsWith('/agents')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ agents }),
        } as Awaited<ReturnType<FetchLike>>
      }
      return {
        ok: false,
        status: 500,
        statusText: 'x',
        json: async () => ({}),
      } as Awaited<ReturnType<FetchLike>>
    })

    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch,
      ttlMs: 1_000,
    })
    await resolver.refreshCatalogue()
    expect(resolver.listAvailable()).toEqual(['planner'])
    expect(fetch).toHaveBeenCalledTimes(1)

    agents = [{ id: 'planner' }, { id: 'researcher' }]
    vi.setSystemTime(new Date('2026-04-19T00:00:05Z'))

    // TTL expired — next resolve() triggers a refresh.
    await resolver.resolve('planner')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(resolver.listAvailable()).toEqual(['planner', 'researcher'])
  })

  it('coalesces concurrent refreshCatalogue() calls', async () => {
    const fetch: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ agents: [{ id: 'a' }] }),
    } as Awaited<ReturnType<FetchLike>>))

    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch,
    })
    await Promise.all([
      resolver.refreshCatalogue(),
      resolver.refreshCatalogue(),
      resolver.refreshCatalogue(),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes auth headers on every request', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.endsWith('/agents'),
        response: { ok: true, status: 200, body: [{ id: 'planner' }] },
      },
    ])
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: 'https://registry.local',
      fetch: stub.fetch,
      headers: { authorization: 'Bearer token-123' },
    })
    await resolver.refreshCatalogue()
    expect(stub.calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer token-123',
    })
  })
})
