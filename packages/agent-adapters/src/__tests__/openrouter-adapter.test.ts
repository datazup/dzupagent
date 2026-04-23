import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

import { ForgeError } from '@dzupagent/core'

import { OpenRouterAdapter } from '../openrouter/openrouter-adapter.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import {
  JsonOutputSchema,
  StructuredOutputAdapter,
} from '../output/structured-output.js'
import { collectEvents } from './test-helpers.js'

/**
 * Build a mock ReadableStream that emits the given SSE lines.
 */
function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload = lines.join('\n') + '\n'
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function mockFetchResponse(
  body: ReadableStream<Uint8Array>,
  status = 200,
  ok = true,
): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    body,
    text: () => Promise.resolve(''),
    headers: new Headers(),
  } as unknown as Response
}

describe('OpenRouterAdapter', () => {
  const originalEnv = process.env['OPENROUTER_API_KEY']

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env['OPENROUTER_API_KEY']
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['OPENROUTER_API_KEY'] = originalEnv
    } else {
      delete process.env['OPENROUTER_API_KEY']
    }
  })

  it('getCapabilities returns correct profile', () => {
    const adapter = new OpenRouterAdapter()
    const caps = adapter.getCapabilities()
    expect(caps).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    })
  })

  it('throws when no API key is configured', async () => {
    const adapter = new OpenRouterAdapter()
    await expect(adapter.execute({ prompt: 'hello' }).next()).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('execute yields started -> stream_delta -> completed for a mock SSE response', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
    ]

    const mockResponse = mockFetchResponse(createSSEStream(sseLines))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse))

    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'test-key' })
    const events = await collectEvents(adapter.execute({ prompt: 'Hi' }))

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:stream_delta',
      'adapter:completed',
    ])

    const started = events[0]
    expect(started.type).toBe('adapter:started')
    if (started.type === 'adapter:started') {
      expect(started.prompt).toBe('Hi')
      expect(started.isResume).toBe(false)
      expect(started.model).toBe('anthropic/claude-sonnet-4-5-20250514')
    }

    const deltas = events.filter((e) => e.type === 'adapter:stream_delta')
    expect(deltas).toHaveLength(2)
    if (deltas[0]?.type === 'adapter:stream_delta') {
      expect(deltas[0].content).toBe('Hello')
    }
    if (deltas[1]?.type === 'adapter:stream_delta') {
      expect(deltas[1].content).toBe(' world')
    }

    const completed = events[3]
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('Hello world')
      expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('healthCheck returns healthy when API key is present', async () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key-123' })
    const status = await adapter.healthCheck()
    expect(status.healthy).toBe(true)
    expect(status.lastError).toBeUndefined()
  })

  it('healthCheck returns unhealthy when API key is missing', async () => {
    const adapter = new OpenRouterAdapter()
    const status = await adapter.healthCheck()
    expect(status.healthy).toBe(false)
    expect(status.lastError).toBe('No API key configured')
  })

  it('healthCheck reads from OPENROUTER_API_KEY env var', async () => {
    process.env['OPENROUTER_API_KEY'] = 'env-key'
    const adapter = new OpenRouterAdapter()
    const status = await adapter.healthCheck()
    expect(status.healthy).toBe(true)
  })

  it('configure merges config', () => {
    const adapter = new OpenRouterAdapter({ defaultModel: 'openai/gpt-4' })
    adapter.configure({ siteUrl: 'https://example.com' })
    // Verify by running healthCheck with a key set via configure
    adapter.configure({ openRouterApiKey: 'merged-key' })
    return adapter.healthCheck().then((status) => {
      expect(status.healthy).toBe(true)
    })
  })

  it('resumeSession throws', async () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key' })
    await expect(
      adapter.resumeSession('sess-1', { prompt: 'hi' }).next(),
    ).rejects.toBeInstanceOf(ForgeError)
  })

  it('interrupt aborts the current execution', async () => {
    // Mock fetch to reject with an AbortError when signal is aborted
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal ?? undefined
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        })
      }),
    )

    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key' })
    const events = await collectEvents(
      (async function* () {
        const gen = adapter.execute({ prompt: 'test' })
        // Yield started event
        const started = await gen.next()
        if (started.value) yield started.value

        // Schedule interrupt on next microtask so fetch is already waiting
        queueMicrotask(() => adapter.interrupt())

        // This will resume the generator which is waiting on fetch
        for await (const event of { [Symbol.asyncIterator]: () => gen }) {
          yield event
        }
      })(),
    )

    expect(capturedSignal?.aborted).toBe(true)
    const types = events.map((e) => e.type)
    expect(types).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.code).toBe('AGENT_ABORTED')
    }
  })

  it('yields failed event for non-200 responses', async () => {
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const mockResponse = mockFetchResponse(errorBody, 429, false)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ...mockResponse,
        text: () => Promise.resolve('Rate limit exceeded'),
      }),
    )

    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key' })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    const types = events.map((e) => e.type)
    expect(types).toEqual(['adapter:started', 'adapter:failed'])

    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toContain('429')
      expect(failed.error).toContain('Rate limit exceeded')
      expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
    }
  })

  it('yields failed event when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key' })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    const types = events.map((e) => e.type)
    expect(types).toEqual(['adapter:started', 'adapter:failed'])

    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('Network error')
    }
  })

  it('sends provider preferences and custom headers when configured', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: [DONE]',
    ]
    const mockResponse = mockFetchResponse(createSSEStream(sseLines))
    const fetchMock = vi.fn().mockResolvedValue(mockResponse)
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenRouterAdapter({
      openRouterApiKey: 'key',
      siteUrl: 'https://mysite.com',
      siteName: 'MySite',
      providerPreferences: { order: ['anthropic'], allow_fallbacks: false },
    })
    await collectEvents(adapter.execute({ prompt: 'test' }))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')

    const headers = opts.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://mysite.com')
    expect(headers['X-Title']).toBe('MySite')

    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body['provider']).toEqual({ order: ['anthropic'], allow_fallbacks: false })
  })

  it('uses model from input options over config default', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))),
    )

    const adapter = new OpenRouterAdapter({
      openRouterApiKey: 'key',
      defaultModel: 'openai/gpt-4',
    })
    const events = await collectEvents(
      adapter.execute({ prompt: 'hi', options: { model: 'meta-llama/llama-3-70b' } }),
    )

    const started = events[0]
    if (started?.type === 'adapter:started') {
      expect(started.model).toBe('meta-llama/llama-3-70b')
    }
  })

  it('includes system prompt in messages when provided', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"y"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(createSSEStream(sseLines)),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'key' })
    await collectEvents(
      adapter.execute({ prompt: 'hi', systemPrompt: 'You are helpful.' }),
    )

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>
    const messages = body['messages'] as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('works with StructuredOutputAdapter over the OpenRouter fetch seam', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"```json\\n{\\"answer\\":42}\\n```"}}]}',
      'data: [DONE]',
    ]
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(createSSEStream(sseLines)),
    )
    vi.stubGlobal('fetch', fetchMock)

    const registry = new AdapterRegistry()
    registry.register(new OpenRouterAdapter({ openRouterApiKey: 'key' }))

    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return the numeric answer as JSON.' },
      JsonOutputSchema.fromZod(
        z.object({ answer: z.number() }),
        {
          agentId: 'openrouter-adapter',
          intent: 'generation:qa-answer',
        },
      ),
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ answer: 42 })
    expect(result.result.providerId).toBe('openrouter')
    expect(result.result.parseAttempts).toBe(1)
    expect(result.fallbackUsed).toBe(false)

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>
    expect(body).not.toHaveProperty('response_format')
    expect(body).not.toHaveProperty('json_schema')
  })

  it('retries structured parsing over the OpenRouter fetch seam and succeeds on correction', async () => {
    const firstResponse = mockFetchResponse(createSSEStream([
      'data: {"choices":[{"delta":{"content":"not valid json"}}]}',
      'data: [DONE]',
    ]))
    const secondResponse = mockFetchResponse(createSSEStream([
      'data: {"choices":[{"delta":{"content":"{\\"answer\\":7}"}}]}',
      'data: [DONE]',
    ]))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse)
    vi.stubGlobal('fetch', fetchMock)

    const registry = new AdapterRegistry()
    registry.register(new OpenRouterAdapter({ openRouterApiKey: 'key' }))

    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return the numeric answer as JSON.' },
      JsonOutputSchema.fromZod(
        z.object({ answer: z.number() }),
        {
          agentId: 'openrouter-adapter',
          intent: 'generation:qa-answer',
        },
      ),
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ answer: 7 })
    expect(result.result.providerId).toBe('openrouter')
    expect(result.result.parseAttempts).toBe(2)
    expect(result.fallbackUsed).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
