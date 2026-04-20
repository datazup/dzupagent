/**
 * Tests for MCPAsyncToolResolver — verifies the AsyncToolResolver contract
 * against a mocked MCPClient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MCPClient } from '@dzupagent/core'
import { MCPAsyncToolResolver } from '../mcp-tool-resolver.js'

type EagerTool = ReturnType<MCPClient['getEagerTools']>[number]
type DeferredName = ReturnType<MCPClient['getDeferredToolNames']>[number]

function makeEager(name: string, serverId: string): EagerTool {
  return {
    name,
    description: `${name} tool`,
    serverId,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }
}

function makeClientStub(options: {
  eager?: EagerTool[]
  deferred?: DeferredName[]
  findTool?: (name: string) => EagerTool | null
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}): MCPClient {
  const eager = options.eager ?? []
  const deferred = options.deferred ?? []
  const find = options.findTool ?? ((name) => eager.find((t) => t.name === name) ?? null)
  const invoke = options.invokeTool
    ?? (async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }))
  return {
    getEagerTools: vi.fn(() => eager),
    getDeferredToolNames: vi.fn(() => deferred),
    findTool: vi.fn((name: string) => find(name)),
    invokeTool: vi.fn((name: string, args: Record<string, unknown>) => invoke(name, args)),
  } as unknown as MCPClient
}

describe('MCPAsyncToolResolver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caches the catalogue synchronously from the client', () => {
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a'), makeEager('read_file', 'srv-b')],
      deferred: [{ name: 'deferred_tool', serverId: 'srv-b' }],
    })
    const resolver = new MCPAsyncToolResolver(client)

    const refs = resolver.listAvailable()
    expect(refs).toEqual(['srv-a/search', 'srv-b/deferred_tool', 'srv-b/read_file'])
  })

  it('resolve() returns a ResolvedTool for a known fully-qualified ref', async () => {
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a')],
    })
    const resolver = new MCPAsyncToolResolver(client)

    const resolved = await resolver.resolve('srv-a/search')
    expect(resolved).not.toBeNull()
    expect(resolved?.kind).toBe('mcp-tool')
    expect(resolved?.ref).toBe('srv-a/search')
    expect(resolved?.handle).toMatchObject({
      kind: 'mcp-tool',
      id: 'srv-a/search',
      serverId: 'srv-a',
      toolName: 'search',
    })
  })

  it('resolve() returns null for unknown refs (never throws)', async () => {
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a')],
    })
    const resolver = new MCPAsyncToolResolver(client)

    await expect(resolver.resolve('unknown_tool')).resolves.toBeNull()
    await expect(resolver.resolve('srv-a/missing')).resolves.toBeNull()
    await expect(resolver.resolve('')).resolves.toBeNull()
  })

  it('resolve() returns null when server qualifier does not match', async () => {
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a')],
    })
    const resolver = new MCPAsyncToolResolver(client)

    const resolved = await resolver.resolve('srv-b/search')
    expect(resolved).toBeNull()
  })

  it('handle.invoke() maps MCP content parts to McpInvocationResult', async () => {
    const invokeSpy = vi.fn(async () => ({
      content: [
        { type: 'text' as const, text: 'hello' },
        { type: 'image' as const, data: 'base64', mimeType: 'image/png' },
      ],
      isError: false,
    }))
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a')],
      invokeTool: invokeSpy,
    })
    const resolver = new MCPAsyncToolResolver(client)
    const resolved = await resolver.resolve('srv-a/search')
    expect(resolved).not.toBeNull()

    interface InvokableHandle {
      invoke: (input: unknown) => Promise<{
        content: ReadonlyArray<{ type: string; value: unknown }>
        isError: boolean
      }>
    }
    const handle = resolved!.handle as InvokableHandle
    const result = await handle.invoke({ query: 'hi' })
    expect(invokeSpy).toHaveBeenCalledWith('search', { query: 'hi' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      { type: 'text', value: 'hello' },
      { type: 'image', value: 'base64' },
    ])
  })

  it('handle.invoke() surfaces infra failure from the client', async () => {
    const client = makeClientStub({
      eager: [makeEager('search', 'srv-a')],
      invokeTool: async () => {
        throw new Error('network down')
      },
    })
    const resolver = new MCPAsyncToolResolver(client)
    const resolved = await resolver.resolve('srv-a/search')
    interface InvokableHandle {
      invoke: (input: unknown) => Promise<unknown>
    }
    const handle = resolved!.handle as InvokableHandle

    await expect(handle.invoke({})).rejects.toThrow(/MCP tool invocation failed.*network down/)
  })

  it('refreshes the catalogue after TTL expiry', async () => {
    const eager: EagerTool[] = [makeEager('search', 'srv-a')]
    const client = makeClientStub({ eager })
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 1_000 })

    expect(resolver.listAvailable()).toEqual(['srv-a/search'])
    expect(client.getEagerTools).toHaveBeenCalledTimes(1)

    // Mutate the backing store and advance past TTL.
    eager.push(makeEager('read_file', 'srv-b'))
    vi.setSystemTime(new Date('2026-04-19T00:00:05Z'))

    // A resolve() after TTL triggers refresh.
    await resolver.resolve('srv-a/search')
    expect(client.getEagerTools).toHaveBeenCalledTimes(2)
    expect(resolver.listAvailable()).toEqual(['srv-a/search', 'srv-b/read_file'])
  })

  it('refreshCatalogue() can be called explicitly', () => {
    const eager: EagerTool[] = [makeEager('search', 'srv-a')]
    const client = makeClientStub({ eager })
    const resolver = new MCPAsyncToolResolver(client)

    expect(resolver.listAvailable()).toEqual(['srv-a/search'])

    eager.push(makeEager('write_file', 'srv-a'))
    resolver.refreshCatalogue()
    expect(resolver.listAvailable()).toEqual(['srv-a/search', 'srv-a/write_file'])
  })
})
