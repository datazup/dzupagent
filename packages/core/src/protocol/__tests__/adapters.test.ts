import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentBus } from '../../events/agent-bus.js'
import { InternalAdapter, extractAgentId } from '../internal-adapter.js'
import { ProtocolRouter } from '../protocol-router.js'
import { A2AClientAdapter } from '../a2a-client-adapter.js'
import { createForgeMessage, createMessageId } from '../message-factory.js'
import type { ForgeMessage } from '../message-types.js'
import type { ProtocolAdapter, SendOptions } from '../adapter.js'
import { ForgeError } from '../../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<ForgeMessage>): ForgeMessage {
  return createForgeMessage({
    type: 'request',
    from: 'forge://acme/sender',
    to: 'forge://acme/receiver',
    payload: { type: 'text', content: 'hello' },
    ...overrides,
  })
}

function makeResponse(original: ForgeMessage, content = 'pong'): ForgeMessage {
  return createForgeMessage({
    type: 'response',
    from: original.to,
    to: original.from,
    protocol: original.protocol,
    payload: { type: 'text', content },
    correlationId: original.id,
  })
}

/**
 * Create a stub ProtocolAdapter for testing ProtocolRouter.
 */
function createStubAdapter(protocol: string): ProtocolAdapter & { lastMessage: ForgeMessage | undefined } {
  const stub: ProtocolAdapter & { lastMessage: ForgeMessage | undefined } = {
    protocol,
    state: 'connected' as const,
    lastMessage: undefined,
    async connect() { /* no-op */ },
    async disconnect() { /* no-op */ },
    async send(message: ForgeMessage) {
      stub.lastMessage = message
      return makeResponse(message, `response from ${protocol}`)
    },
    async *stream(message: ForgeMessage) {
      stub.lastMessage = message
      yield makeResponse(message, `streamed from ${protocol}`)
    },
    subscribe() {
      return { unsubscribe: () => { /* no-op */ } }
    },
    health() {
      return { state: 'connected' as const, latencyMs: 0 }
    },
  }
  return stub
}

// ===========================================================================
// extractAgentId
// ===========================================================================

describe('extractAgentId', () => {
  it('extracts agent name from forge:// URI', () => {
    expect(extractAgentId('forge://acme/code-reviewer')).toBe('code-reviewer')
  })

  it('strips @version suffix (S5 fix)', () => {
    expect(extractAgentId('forge://acme/code-reviewer@1.2.0')).toBe('code-reviewer')
  })

  it('strips version from a2a:// URI', () => {
    expect(extractAgentId('a2a://host/agent-name@2.0.0')).toBe('agent-name')
  })

  it('handles URI without version', () => {
    expect(extractAgentId('forge://org/my-agent')).toBe('my-agent')
  })

  it('handles multi-segment path', () => {
    expect(extractAgentId('http://example.com/agents/my-agent')).toBe('my-agent')
  })

  it('handles URI with @ in version only (not in name)', () => {
    expect(extractAgentId('forge://acme/test@0.0.1')).toBe('test')
  })
})

// ===========================================================================
// InternalAdapter
// ===========================================================================

describe('InternalAdapter', () => {
  let agentBus: AgentBus
  let adapter: InternalAdapter

  beforeEach(() => {
    agentBus = new AgentBus()
    adapter = new InternalAdapter({ agentBus, defaultTimeoutMs: 500 })
  })

  it('has protocol "internal"', () => {
    expect(adapter.protocol).toBe('internal')
  })

  it('state is always "connected"', () => {
    expect(adapter.state).toBe('connected')
  })

  it('connect() is a no-op that resolves', async () => {
    await expect(adapter.connect()).resolves.toBeUndefined()
  })

  it('disconnect() is a no-op that resolves', async () => {
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('health() returns connected state with 0 latency', () => {
    const h = adapter.health()
    expect(h.state).toBe('connected')
    expect(h.latencyMs).toBe(0)
  })

  it('send() routes message to correct agent via AgentBus', async () => {
    const message = makeRequest({ to: 'forge://acme/target-agent' })
    const response = makeResponse(message, 'got it')

    // Simulate a handler on the target agent channel
    agentBus.subscribe('target-agent', 'handler', (agentMsg) => {
      const payload = agentMsg.payload
      const responseChannel = payload['responseChannel'] as string
      // Send response back
      agentBus.publish('target-agent', responseChannel, response as unknown as Record<string, unknown>)
    })

    const result = await adapter.send(message)
    expect(result.type).toBe('response')
    expect(result.correlationId).toBe(message.id)
  })

  it('send() strips @version from URI when extracting agent ID (S5)', async () => {
    const message = makeRequest({ to: 'forge://acme/code-reviewer@1.2.0' })
    const response = makeResponse(message)

    let receivedOnChannel = ''
    agentBus.subscribe('code-reviewer', 'handler', (agentMsg) => {
      receivedOnChannel = agentMsg.channel
      const payload = agentMsg.payload
      const responseChannel = payload['responseChannel'] as string
      agentBus.publish('code-reviewer', responseChannel, response as unknown as Record<string, unknown>)
    })

    await adapter.send(message)
    // The message was routed to 'code-reviewer', NOT 'code-reviewer@1.2.0'
    expect(receivedOnChannel).toBe('code-reviewer')
  })

  it('send() times out if no response', async () => {
    const message = makeRequest()
    // No handler registered — will timeout

    await expect(adapter.send(message, { timeoutMs: 50 })).rejects.toThrow('No response from')
    await expect(adapter.send(message, { timeoutMs: 50 })).rejects.toSatisfy((err: unknown) => {
      return ForgeError.is(err) && err.code === 'PROTOCOL_TIMEOUT'
    })
  })

  it('subscribe() receives messages on channel', async () => {
    const received: ForgeMessage[] = []

    adapter.subscribe('test-channel', async (msg) => {
      received.push(msg)
    })

    const message = makeRequest()
    agentBus.publish('test-sender', 'test-channel', {
      __forgeMessage: true,
      message: message as unknown as Record<string, unknown>,
    })

    // Allow microtask to run
    await new Promise((r) => setTimeout(r, 10))
    expect(received.length).toBe(1)
  })

  it('subscribe().unsubscribe() stops delivery', async () => {
    const received: ForgeMessage[] = []

    const sub = adapter.subscribe('test-channel', async (msg) => {
      received.push(msg)
    })

    const message = makeRequest()
    agentBus.publish('test-sender', 'test-channel', {
      __forgeMessage: true,
      message: message as unknown as Record<string, unknown>,
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(received.length).toBe(1)

    // Unsubscribe
    sub.unsubscribe()

    agentBus.publish('test-sender', 'test-channel', {
      __forgeMessage: true,
      message: message as unknown as Record<string, unknown>,
    })

    await new Promise((r) => setTimeout(r, 10))
    // Should still be 1
    expect(received.length).toBe(1)
  })
})

// ===========================================================================
// ProtocolRouter
// ===========================================================================

describe('ProtocolRouter', () => {
  it('registerAdapter() adds adapter for scheme', () => {
    const router = new ProtocolRouter()
    const adapter = createStubAdapter('internal')
    router.registerAdapter('forge', adapter)
    expect(router.getRegisteredSchemes()).toContain('forge')
  })

  it('route() selects correct adapter by URI scheme', async () => {
    const router = new ProtocolRouter()
    const forgeAdapter = createStubAdapter('internal')
    const a2aAdapter = createStubAdapter('a2a')
    router.registerAdapter('forge', forgeAdapter)
    router.registerAdapter('a2a', a2aAdapter)

    const forgeMsg = makeRequest({ to: 'forge://acme/agent' })
    await router.route(forgeMsg)
    expect(forgeAdapter.lastMessage).toBe(forgeMsg)
    expect(a2aAdapter.lastMessage).toBeUndefined()

    const a2aMsg = makeRequest({ to: 'a2a://remote/agent' })
    await router.route(a2aMsg)
    expect(a2aAdapter.lastMessage).toBe(a2aMsg)
  })

  it('route() throws MESSAGE_ROUTING_FAILED for unknown scheme', async () => {
    const router = new ProtocolRouter()

    const msg = makeRequest({ to: 'forge://acme/agent' })
    await expect(router.route(msg)).rejects.toSatisfy((err: unknown) => {
      return ForgeError.is(err) && err.code === 'MESSAGE_ROUTING_FAILED'
    })
  })

  it('route() uses defaultAdapter when set and no scheme match', async () => {
    const defaultAdapter = createStubAdapter('fallback')
    const router = new ProtocolRouter({ defaultAdapter })

    const msg = makeRequest({ to: 'forge://acme/agent' })
    const result = await router.route(msg)
    expect(defaultAdapter.lastMessage).toBe(msg)
    expect(result.payload.type).toBe('text')
    if (result.payload.type === 'text') {
      expect(result.payload.content).toBe('response from fallback')
    }
  })

  it('getRegisteredSchemes() returns all registered schemes', () => {
    const router = new ProtocolRouter()
    router.registerAdapter('forge', createStubAdapter('internal'))
    router.registerAdapter('a2a', createStubAdapter('a2a'))
    router.registerAdapter('mcp', createStubAdapter('mcp'))

    const schemes = router.getRegisteredSchemes()
    expect(schemes).toContain('forge')
    expect(schemes).toContain('a2a')
    expect(schemes).toContain('mcp')
    expect(schemes.length).toBe(3)
  })

  it('removeAdapter() removes adapter', async () => {
    const router = new ProtocolRouter()
    router.registerAdapter('forge', createStubAdapter('internal'))
    expect(router.getRegisteredSchemes()).toContain('forge')

    router.removeAdapter('forge')
    expect(router.getRegisteredSchemes()).not.toContain('forge')

    const msg = makeRequest({ to: 'forge://acme/agent' })
    await expect(router.route(msg)).rejects.toThrow()
  })

  it('routeStream() delegates to correct adapter', async () => {
    const router = new ProtocolRouter()
    const adapter = createStubAdapter('internal')
    router.registerAdapter('forge', adapter)

    const msg = makeRequest({ to: 'forge://acme/agent' })
    const chunks: ForgeMessage[] = []
    for await (const chunk of router.routeStream(msg)) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBe(1)
    expect(adapter.lastMessage).toBe(msg)
  })

  it('getAdapterForUri() returns the matching adapter', () => {
    const router = new ProtocolRouter()
    const adapter = createStubAdapter('internal')
    router.registerAdapter('forge', adapter)

    expect(router.getAdapterForUri('forge://acme/agent')).toBe(adapter)
    expect(router.getAdapterForUri('a2a://remote/agent')).toBeUndefined()
  })

  it('getAdapterForUri() returns defaultAdapter as fallback', () => {
    const defaultAdapter = createStubAdapter('fallback')
    const router = new ProtocolRouter({ defaultAdapter })

    expect(router.getAdapterForUri('unknown://host/path')).toBe(defaultAdapter)
  })

  it('scheme matching is case-insensitive', async () => {
    const router = new ProtocolRouter()
    const adapter = createStubAdapter('internal')
    router.registerAdapter('FORGE', adapter)

    // Registered as 'forge' (lowercased)
    expect(router.getRegisteredSchemes()).toContain('forge')
  })
})

// ===========================================================================
// A2AClientAdapter
// ===========================================================================

describe('A2AClientAdapter', () => {
  function createMockFetch(responses: Array<{ status: number; body: unknown }>): typeof globalThis.fetch {
    let callIdx = 0
    return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const resp = responses[callIdx]
      callIdx++
      if (!resp) {
        throw new Error('Mock fetch: no more responses')
      }
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
        headers: new Headers(),
      } as Response
    })
  }

  function makeA2ASuccessResponse(taskId: string, text = 'done'): unknown {
    return {
      jsonrpc: '2.0',
      id: taskId,
      result: {
        id: taskId,
        status: {
          state: 'completed',
          message: {
            role: 'agent',
            parts: [{ type: 'text', text }],
          },
        },
      },
    }
  }

  it('has protocol "a2a"', () => {
    const adapter = new A2AClientAdapter()
    expect(adapter.protocol).toBe('a2a')
  })

  it('initial state is "disconnected"', () => {
    const adapter = new A2AClientAdapter()
    expect(adapter.state).toBe('disconnected')
  })

  // -- connect() --

  it('connect() validates endpoint (mock fetch 200 OK)', async () => {
    const mockFetch = createMockFetch([{ status: 200, body: { name: 'TestAgent' } }])
    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    await adapter.connect()
    expect(adapter.state).toBe('connected')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('connect() throws on unreachable endpoint (mock fetch error)', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('Network error')
    }) as unknown as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    await expect(adapter.connect()).rejects.toThrow('Failed to connect')
    expect(adapter.state).toBe('error')
  })

  it('connect() throws on non-OK status', async () => {
    const mockFetch = createMockFetch([{ status: 404, body: 'Not Found' }])
    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    await expect(adapter.connect()).rejects.toThrow('returned 404')
    expect(adapter.state).toBe('error')
  })

  it('state transitions: disconnected -> connecting -> connected', async () => {
    const states: string[] = []
    const mockFetch = vi.fn(async () => {
      // Capture state during fetch (should be 'connecting')
      states.push(adapter.state)
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'Agent' }),
        text: async () => '{}',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    states.push(adapter.state) // 'disconnected'
    await adapter.connect()
    states.push(adapter.state) // 'connected'

    expect(states).toEqual(['disconnected', 'connecting', 'connected'])
  })

  // -- send() --

  it('send() translates ForgeMessage to A2A format and back', async () => {
    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      expect(body.method).toBe('tasks/send')
      expect(body.params.message.role).toBe('user')
      expect(body.params.message.parts[0].type).toBe('text')
      expect(body.params.message.parts[0].text).toBe('hello')

      return {
        ok: true,
        status: 200,
        json: async () => makeA2ASuccessResponse(body.id, 'world'),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    const msg = makeRequest({
      to: 'a2a://agent.example.com/agent',
      protocol: 'a2a',
    })
    const result = await adapter.send(msg)

    expect(result.type).toBe('response')
    expect(result.protocol).toBe('a2a')
    expect(result.correlationId).toBe(msg.id)
    expect(result.payload.type).toBe('text')
    if (result.payload.type === 'text') {
      expect(result.payload.content).toBe('world')
    }
  })

  it('send() translates A2A data response back to json ForgePayload', async () => {
    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            id: body.id,
            status: {
              state: 'completed',
              message: {
                role: 'agent',
                parts: [{ type: 'data', data: { key: 'value' } }],
              },
            },
          },
        }),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    const result = await adapter.send(msg)
    expect(result.payload.type).toBe('json')
    if (result.payload.type === 'json') {
      expect(result.payload.data).toEqual({ key: 'value' })
    }
  })

  it('send() retries on 500 with exponential backoff', async () => {
    const callTimes: number[] = []
    let callCount = 0

    const mockFetch = vi.fn(async () => {
      callTimes.push(Date.now())
      callCount++
      if (callCount <= 2) {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'Internal Server Error',
          headers: new Headers(),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => makeA2ASuccessResponse('task-1'),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
      retryDelayMs: 50,
      maxRetries: 3,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    const result = await adapter.send(msg)

    expect(result.type).toBe('response')
    expect(mockFetch).toHaveBeenCalledTimes(3) // 2 failures + 1 success
    // Verify delays between calls (exponential backoff)
    if (callTimes.length >= 3 && callTimes[0] !== undefined && callTimes[1] !== undefined && callTimes[2] !== undefined) {
      const delay1 = callTimes[1] - callTimes[0]
      const delay2 = callTimes[2] - callTimes[1]
      expect(delay1).toBeGreaterThanOrEqual(40) // ~50ms (with tolerance)
      expect(delay2).toBeGreaterThanOrEqual(80) // ~100ms (with tolerance)
    }
  })

  it('send() does not retry on 4xx errors', async () => {
    const mockFetch = createMockFetch([
      { status: 400, body: { error: 'Bad Request' } },
    ])

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
      maxRetries: 3,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await expect(adapter.send(msg)).rejects.toSatisfy((err: unknown) => {
      return ForgeError.is(err) && err.code === 'PROTOCOL_SEND_FAILED'
    })
    expect(mockFetch).toHaveBeenCalledTimes(1) // No retries
  })

  it('send() respects abort signal', async () => {
    const controller = new AbortController()
    controller.abort()

    const mockFetch = createMockFetch([])
    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await expect(adapter.send(msg, { signal: controller.signal })).rejects.toSatisfy((err: unknown) => {
      return ForgeError.is(err) && err.code === 'PROTOCOL_SEND_FAILED'
    })
    // Fetch should never have been called
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  it('send() times out after configured timeout', async () => {
    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      // Simulate slow response — wait for abort
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        }
      })
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
      defaultTimeoutMs: 100,
      maxRetries: 0,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await expect(adapter.send(msg)).rejects.toThrow()
  })

  it('send() handles JSON-RPC error in response', async () => {
    const mockFetch = createMockFetch([
      {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: '1',
          error: { code: -32600, message: 'Invalid Request' },
        },
      },
    ])

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
      maxRetries: 0,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await expect(adapter.send(msg)).rejects.toSatisfy((err: unknown) => {
      return ForgeError.is(err) && err.message.includes('Invalid Request')
    })
  })

  // -- stream() --

  it('stream() yields single response (stub)', async () => {
    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      return {
        ok: true,
        status: 200,
        json: async () => makeA2ASuccessResponse(body.id, 'streamed'),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    const chunks: ForgeMessage[] = []
    for await (const chunk of adapter.stream(msg)) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBe(1)
    if (chunks[0]?.payload.type === 'text') {
      expect(chunks[0].payload.content).toBe('streamed')
    }
  })

  // -- health() --

  it('health() reflects adapter state', async () => {
    const adapter = new A2AClientAdapter()
    expect(adapter.health().state).toBe('disconnected')
  })

  // -- disconnect() --

  it('disconnect() sets state to disconnected', async () => {
    const mockFetch = createMockFetch([{ status: 200, body: {} }])
    const adapter = new A2AClientAdapter({
      baseUrl: 'https://agent.example.com',
      fetch: mockFetch,
    })

    await adapter.connect()
    expect(adapter.state).toBe('connected')

    await adapter.disconnect()
    expect(adapter.state).toBe('disconnected')
  })

  // -- subscribe() --

  it('subscribe() returns no-op subscription', () => {
    const adapter = new A2AClientAdapter()
    const sub = adapter.subscribe('test', async () => { /* no-op */ })
    expect(sub.unsubscribe).toBeInstanceOf(Function)
    // Should not throw
    sub.unsubscribe()
  })

  // -- URL resolution --

  it('send() resolves a2a:// URI to https://', async () => {
    let calledUrl = ''
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      calledUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return {
        ok: true,
        status: 200,
        json: async () => makeA2ASuccessResponse('t1'),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({ fetch: mockFetch, maxRetries: 0 })
    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await adapter.send(msg)
    expect(calledUrl).toBe('https://agent.example.com/agent')
  })

  it('send() uses configBaseUrl when provided', async () => {
    let calledUrl = ''
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      calledUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return {
        ok: true,
        status: 200,
        json: async () => makeA2ASuccessResponse('t1'),
        text: async () => '',
        headers: new Headers(),
      } as Response
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://custom-base.example.com/a2a',
      fetch: mockFetch,
      maxRetries: 0,
    })
    const msg = makeRequest({ to: 'a2a://agent.example.com/agent', protocol: 'a2a' })
    await adapter.send(msg)
    expect(calledUrl).toBe('https://custom-base.example.com/a2a')
  })
})
