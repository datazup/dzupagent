import { describe, expect, it, vi } from 'vitest'
import { collectEvents } from './test-helpers.js'
import {
  OllamaAdapter,
  createOllamaAdapter,
  resolveLocalModelEndpoint,
} from '../ollama/ollama-adapter.js'

const encoder = new TextEncoder()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function streamResponse(records: readonly string[], contentType = 'application/x-ndjson'): Response {
  return new Response(`${records.join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
}

function ollamaInventory(...models: string[]): Response {
  return jsonResponse({
    models: models.map((name) => ({
      name,
      model: name,
      digest: `digest-${name}`,
      size: 42,
      details: { family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' },
    })),
  })
}

function ollamaShow(capabilities: string[] = ['completion']): Response {
  return jsonResponse({
    capabilities,
    model_info: { 'qwen3.context_length': 32_768 },
  })
}

function nativeFetch(options: {
  models?: string[]
  capabilities?: string[]
  chunks?: Record<string, unknown>[]
  capture?: (url: string, init: RequestInit) => void
} = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    options.capture?.(url, requestInit)
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/api/tags')) return ollamaInventory(...(options.models ?? ['qwen3:latest']))
    if (pathname.endsWith('/api/show')) return ollamaShow(options.capabilities)
    if (pathname.endsWith('/api/chat')) {
      return streamResponse((options.chunks ?? [
        { message: { content: 'local ' }, done: false },
        { message: { content: 'answer' }, done: true, prompt_eval_count: 7, eval_count: 2 },
      ]).map((chunk) => JSON.stringify(chunk)))
    }
    return jsonResponse({ error: 'not found' }, 404)
  }) as typeof fetch
}

function rejectionCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { context?: { rejectionCode?: string } }).context?.rejectionCode
  }
}

describe('direct Ollama local-model backend', () => {
  it('exports an explicit factory and capability profile', () => {
    const adapter = createOllamaAdapter({ fetchImpl: nativeFetch() })
    expect(adapter).toBeInstanceOf(OllamaAdapter)
    expect(adapter.providerId).toBe('ollama')
    expect(adapter.backend).toBe('local-model')
    expect(adapter.getCapabilities()).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    })
  })

  it('emitsToolCalls but does NOT execute an autonomous tool loop (AGENT-H-04)', () => {
    const caps = new OllamaAdapter().getCapabilities()
    expect(caps.emitsToolCalls).toBe(true)
    expect(caps.executesToolLoop).toBe(false)
  })

  it('accepts loopback and exact approved-local endpoints', () => {
    expect(resolveLocalModelEndpoint({}).baseUrl).toBe('http://127.0.0.1:11434')
    expect(resolveLocalModelEndpoint({ baseURL: 'http://localhost:11434/' }).baseUrl)
      .toBe('http://localhost:11434')
    expect(resolveLocalModelEndpoint({ baseURL: 'http://127.9.8.7:11434' }).baseUrl)
      .toBe('http://127.9.8.7:11434')
    expect(resolveLocalModelEndpoint({
      baseURL: 'http://ollama.lan:11434/v1',
      protocol: 'openai-compatible',
      approvedLocalHosts: ['ollama.lan:11434'],
    }).baseUrl).toBe('http://ollama.lan:11434/v1')
  })

  it('rejects arbitrary remote, embedded credentials, query state, and unsupported protocols', () => {
    expect(rejectionCode(() => resolveLocalModelEndpoint({ baseURL: 'https://example.com' })))
      .toBe('LOCAL_MODEL_ENDPOINT_NOT_LOCAL')
    expect(rejectionCode(() => resolveLocalModelEndpoint({ baseURL: 'https://example.com', localOnly: false })))
      .toBe('LOCAL_MODEL_ENDPOINT_NOT_APPROVED')
    expect(rejectionCode(() => resolveLocalModelEndpoint({ baseURL: 'http://user:secret@127.0.0.1:11434' })))
      .toBe('LOCAL_MODEL_ENDPOINT_HAS_CREDENTIALS')
    expect(rejectionCode(() => resolveLocalModelEndpoint({ baseURL: 'http://127.0.0.1:11434?model=x' })))
      .toBe('LOCAL_MODEL_ENDPOINT_HAS_QUERY')
    expect(rejectionCode(() => resolveLocalModelEndpoint({ baseURL: 'file:///tmp/ollama.sock' })))
      .toBe('LOCAL_MODEL_PROTOCOL_UNSUPPORTED')
  })

  it('lists installed models and maps model-specific capabilities', async () => {
    const adapter = new OllamaAdapter({
      fetchImpl: nativeFetch({ capabilities: ['completion', 'vision', 'tools', 'thinking'] }),
    })
    const models = await adapter.listModels()
    expect(models[0]).toMatchObject({
      id: 'qwen3:latest',
      family: 'qwen3',
      parameterSize: '8B',
      quantizationLevel: 'Q4_K_M',
    })
    const inspection = await adapter.inspectModel('qwen3')
    expect(inspection.capabilities).toEqual({
      text: true,
      vision: true,
      tools: true,
      structuredOutput: true,
      thinking: true,
      embedding: false,
      contextTokens: 32_768,
      evidence: 'ollama-show',
    })
  })

  it('streams normalized text, tool, completion, usage, and correlation events', async () => {
    let chatBody: Record<string, unknown> | undefined
    const adapter = new OllamaAdapter({
      fetchImpl: nativeFetch({
        capabilities: ['completion', 'vision', 'tools'],
        chunks: [
          { message: { content: 'A', tool_calls: [{ function: { name: 'lookup', arguments: { id: 7 } } }] }, done: false },
          { message: { content: 'B' }, done: true, prompt_eval_count: 11, eval_count: 3 },
        ],
        capture(url, init) {
          if (new URL(url).pathname.endsWith('/api/chat')) chatBody = JSON.parse(String(init.body)) as Record<string, unknown>
        },
      }),
    })
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    const events = await collectEvents(adapter.execute({
      prompt: 'inspect',
      systemPrompt: 'Return only evidence.',
      correlationId: 'corr-local',
      outputSchema: schema,
      options: {
        model: 'qwen3',
        images: ['base64-image'],
        tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      },
    }))
    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:tool_call',
      'adapter:stream_delta',
      'adapter:completed',
    ])
    expect(events.every((event) => event.correlationId === 'corr-local')).toBe(true)
    expect(events.find((event) => event.type === 'adapter:tool_call')).toMatchObject({ toolName: 'lookup', input: { id: 7 } })
    expect(events.at(-1)).toMatchObject({
      type: 'adapter:completed',
      result: 'AB',
      usage: { inputTokens: 11, outputTokens: 3 },
    })
    expect(chatBody).toMatchObject({ model: 'qwen3', stream: true, format: schema })
    expect(chatBody?.['messages']).toEqual([
      { role: 'system', content: 'Return only evidence.' },
      { role: 'user', content: 'inspect', images: ['base64-image'] },
    ])
    expect(chatBody?.['tools']).toHaveLength(1)
  })

  it('rejects unavailable models before opening a chat stream', async () => {
    const adapter = new OllamaAdapter({ fetchImpl: nativeFetch({ models: ['other:latest'] }) })
    await expect(adapter.execute({ prompt: 'hello', options: { model: 'missing' } }).next())
      .rejects.toMatchObject({ code: 'PROVIDER_REJECTED_REQUEST', context: { rejectionCode: 'MODEL_UNAVAILABLE' } })
  })

  it('gates vision, tools, structured output, budgets, turns, and resume on proven effects', async () => {
    const adapter = new OllamaAdapter({ fetchImpl: nativeFetch({ capabilities: ['completion'] }) })
    await expect(adapter.execute({ prompt: 'x', options: { images: ['image'] } }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(adapter.execute({ prompt: 'x', options: { tools: [{ name: 'run' }] } }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const embeddingOnly = new OllamaAdapter({ fetchImpl: nativeFetch({ capabilities: ['embedding'] }) })
    await expect(embeddingOnly.execute({ prompt: 'x', outputSchema: { type: 'object' } }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(adapter.execute({ prompt: 'x', maxBudgetUsd: 1 }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(adapter.execute({ prompt: 'x', maxTurns: 2 }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(adapter.execute({ prompt: 'x', resumeSessionId: 'session' }).next())
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })

  it('blocks redirects instead of following endpoint transitions', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { Location: 'http://127.0.0.1:9999/api/tags' },
    })) as typeof fetch
    const adapter = new OllamaAdapter({ fetchImpl })
    await expect(adapter.listModels()).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds malformed, oversized, and excessive stream records', async () => {
    const malformedAdapter = new OllamaAdapter({
      fetchImpl: nativeFetch({ chunks: [] }),
      maxRecordBytes: 32,
    })
    const malformedFetch = nativeFetch()
    malformedAdapter.configure({
      fetchImpl: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/api/chat')) return streamResponse(['not-json'])
        return malformedFetch(input, init)
      }) as typeof fetch,
    })
    const malformedEvents = await collectEvents(malformedAdapter.execute({ prompt: 'x' }))
    expect(malformedEvents.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_EXECUTION_FAILED' })

    const boundedAdapter = new OllamaAdapter({ fetchImpl: nativeFetch(), maxRecordBytes: 20 })
    const boundedEvents = await collectEvents(boundedAdapter.execute({ prompt: 'x' }))
    expect(boundedEvents.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_EXECUTION_FAILED' })

    const recordsAdapter = new OllamaAdapter({ fetchImpl: nativeFetch(), maxRecords: 1 })
    const recordEvents = await collectEvents(recordsAdapter.execute({ prompt: 'x' }))
    expect(recordEvents.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_EXECUTION_FAILED' })
  })

  it('supports cancellation and emits one terminal abort event', async () => {
    const baseFetch = nativeFetch()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!new URL(String(input)).pathname.endsWith('/api/chat')) return baseFetch(input, init)
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal?.aborted) rejectAbort()
        else signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    }) as typeof fetch
    const adapter = new OllamaAdapter({ fetchImpl })
    const stream = adapter.execute({ prompt: 'wait' })
    expect((await stream.next()).value).toMatchObject({ type: 'adapter:started' })
    const pending = stream.next()
    adapter.interrupt()
    expect((await pending).value).toMatchObject({ type: 'adapter:failed', code: 'AGENT_ABORTED' })
    expect((await stream.next()).done).toBe(true)
  })

  it('classifies bounded request timeouts', async () => {
    const baseFetch = nativeFetch()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!new URL(String(input)).pathname.endsWith('/api/chat')) return baseFetch(input, init)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch
    const adapter = new OllamaAdapter({ fetchImpl, timeoutMs: 5 })
    const events = await collectEvents(adapter.execute({ prompt: 'wait' }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_TIMEOUT' })
  })

  it('keeps concurrent execution state isolated', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/api/tags')) return ollamaInventory('alpha:latest', 'beta:latest')
      if (path.endsWith('/api/show')) return ollamaShow()
      const body = JSON.parse(String(init?.body)) as { model: string }
      await Promise.resolve()
      return streamResponse([
        JSON.stringify({ message: { content: body.model }, done: true, prompt_eval_count: 1, eval_count: 1 }),
      ])
    }) as typeof fetch
    const adapter = new OllamaAdapter({ fetchImpl })
    const [alpha, beta] = await Promise.all([
      collectEvents(adapter.execute({ prompt: 'a', options: { model: 'alpha' } })),
      collectEvents(adapter.execute({ prompt: 'b', options: { model: 'beta' } })),
    ])
    expect(alpha.at(-1)).toMatchObject({ type: 'adapter:completed', result: 'alpha' })
    expect(beta.at(-1)).toMatchObject({ type: 'adapter:completed', result: 'beta' })
  })

  it('supports explicitly approved local OpenAI-compatible endpoints with declared capabilities', async () => {
    let chatBody: Record<string, unknown> | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'local-chat' }] })
      chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"json"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}',
        'data: [DONE]',
      ], 'text/event-stream')
    }) as typeof fetch
    const adapter = new OllamaAdapter({
      baseURL: 'http://gateway.lan:8080/v1',
      approvedLocalHosts: ['gateway.lan:8080'],
      protocol: 'openai-compatible',
      model: 'local-chat',
      apiKey: 'local-secret',
      declaredModelCapabilities: {
        'local-chat': { text: true, tools: true, structuredOutput: true, contextTokens: 16_384 },
      },
      fetchImpl,
    })
    const schema = { type: 'object', properties: { value: { type: 'string' } } }
    const events = await collectEvents(adapter.execute({ prompt: 'x', outputSchema: schema }))
    expect(events.at(-1)).toMatchObject({
      type: 'adapter:completed',
      result: 'json',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    expect(chatBody?.['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'dzupagent_output', strict: true, schema },
    })
    const chatCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'))
    expect((chatCall?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer local-secret')
  })

  it('refuses compatibility-model capability invention and reports health truthfully', async () => {
    const healthyFetch = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'unknown' }] })
      return jsonResponse({})
    }) as typeof fetch
    const adapter = new OllamaAdapter({
      baseURL: 'http://127.0.0.1:8000/v1',
      protocol: 'openai-compatible',
      model: 'unknown',
      fetchImpl: healthyFetch,
    })
    await expect(adapter.inspectModel('unknown')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(adapter.execute({ prompt: 'x' }).next()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const healthy = new OllamaAdapter({ fetchImpl: nativeFetch() })
    expect(await healthy.healthSnapshot()).toMatchObject({
      healthy: true,
      endpoint: 'http://127.0.0.1:11434',
      protocol: 'ollama',
      modelCount: 1,
    })
    const unhealthy = new OllamaAdapter({
      fetchImpl: vi.fn(async () => { throw new Error('offline') }) as typeof fetch,
    })
    expect(await unhealthy.healthSnapshot()).toMatchObject({ healthy: false, errorCode: 'PROVIDER_UNAVAILABLE' })
    expect(await unhealthy.healthCheck()).toMatchObject({
      healthy: false,
      providerId: 'ollama',
      sdkInstalled: true,
      cliAvailable: false,
    })
  })
})
