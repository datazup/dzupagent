import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { ForgeError, type LlmInvocationRecord } from '@dzupagent/core'

import { OpenAIAdapter } from '../openai/openai-adapter.js'
import { collectEvents } from './test-helpers.js'

/** SSE byte stream from an array of `data: …` lines (terminator `\n` per line). */
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
    json: () => Promise.resolve({}),
    headers: new Headers(),
  } as unknown as Response
}

describe('OpenAIAdapter', () => {
  const originalEnv = process.env['OPENAI_API_KEY']

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env['OPENAI_API_KEY']
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['OPENAI_API_KEY'] = originalEnv
    } else {
      delete process.env['OPENAI_API_KEY']
    }
  })

  it('getCapabilities returns correct profile', () => {
    const adapter = new OpenAIAdapter()
    expect(adapter.getCapabilities()).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    })
  })

  it('throws when no API key is configured', async () => {
    const adapter = new OpenAIAdapter()
    await expect(adapter.execute({ prompt: 'hello' }).next()).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('execute yields started -> stream_delta -> completed for a mock SSE response', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'test-key' })
    const events = await collectEvents(adapter.execute({ prompt: 'Hi' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:stream_delta',
      'adapter:completed',
    ])

    const started = events[0]
    if (started?.type === 'adapter:started') {
      expect(started.prompt).toBe('Hi')
      expect(started.isResume).toBe(false)
      expect(started.model).toBe('gpt-4o-mini')
    }

    const completed = events[3]
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('Hello world')
      expect(completed.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('emits adapter:completed without usage when stream omits usage chunk', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(adapter.execute({ prompt: 'p' }))

    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('x')
      expect(completed.usage).toBeUndefined()
    }
  })

  it('reads API key from OPENAI_API_KEY env var when config absent', async () => {
    process.env['OPENAI_API_KEY'] = 'env-key'
    const sseLines = ['data: {"choices":[{"delta":{"content":"k"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter()
    await collectEvents(adapter.execute({ prompt: 'hi' }))

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer env-key')
  })

  it('uses model from input options over config default', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k', model: 'gpt-4o' })
    const events = await collectEvents(
      adapter.execute({ prompt: 'hi', options: { model: 'gpt-4o-mini' } }),
    )

    const started = events[0]
    if (started?.type === 'adapter:started') {
      expect(started.model).toBe('gpt-4o-mini')
    }
  })

  it('includes system prompt in messages when provided', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"y"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await collectEvents(adapter.execute({ prompt: 'hi', systemPrompt: 'You are helpful.' }))

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { messages: Array<{ role: string; content: string }>; stream: boolean; stream_options?: unknown }

    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('honours custom baseURL for OpenAI-compatible endpoints', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"k"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k', baseURL: 'https://my-proxy.example.com/v1' })
    await collectEvents(adapter.execute({ prompt: 'p' }))

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://my-proxy.example.com/v1/chat/completions')
  })

  it('yields adapter:failed for non-200 responses with status + body in error', async () => {
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ...mockFetchResponse(errorBody, 429, false),
        text: () => Promise.resolve('Rate limit exceeded'),
      }),
    )

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toContain('429')
      expect(failed.error).toContain('Rate limit exceeded')
      expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
    }
  })

  it('yields adapter:failed when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('Network error')
    }
  })

  it('interrupt aborts the in-flight request', async () => {
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

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      (async function* () {
        const gen = adapter.execute({ prompt: 'test' })
        const started = await gen.next()
        if (started.value) yield started.value
        queueMicrotask(() => adapter.interrupt())
        for await (const event of { [Symbol.asyncIterator]: () => gen }) {
          yield event
        }
      })(),
    )

    expect(capturedSignal?.aborted).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    if (failed?.type === 'adapter:failed') {
      expect(failed.code).toBe('AGENT_ABORTED')
    }
  })

  it('resumeSession throws ForgeError (capability declares supportsResume=false)', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await expect(
      adapter.resumeSession('sess-1', { prompt: 'hi' }).next(),
    ).rejects.toBeInstanceOf(ForgeError)
  })

  it('healthCheck returns healthy when API key configured', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const status = await adapter.healthCheck()
    expect(status.healthy).toBe(true)
    expect(status.lastError).toBeUndefined()
  })

  it('healthCheck returns unhealthy when no API key', async () => {
    const adapter = new OpenAIAdapter()
    const status = await adapter.healthCheck()
    expect(status.healthy).toBe(false)
    expect(status.lastError).toBe('No API key configured')
  })

  it('configure merges new options into existing config', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'old', model: 'gpt-4o' })
    adapter.configure({ apiKey: 'new', baseURL: 'https://x.example.com/v1' })

    const sseLines = ['data: {"choices":[{"delta":{"content":"z"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    await collectEvents(adapter.execute({ prompt: 'p' }))

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://x.example.com/v1/chat/completions')
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer new')
  })

  it('run() non-streaming method returns content + usage from JSON response', async () => {
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello back' } }],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        }),
        text: () => Promise.resolve(''),
        body: null,
        headers: new Headers(),
      }),
    )

    const adapter = new OpenAIAdapter({
      apiKey: 'k',
      auditSink,
      auditRunId: 'run-1',
      auditTenantId: 'tenant-1',
    })
    const result = await adapter.run('Hello', { systemPrompt: 'be brief' })

    expect(result.content).toBe('Hello back')
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3 })
    expect(auditSink).toHaveBeenCalledTimes(1)
    expect(auditSink.mock.calls[0]![0]).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4o-mini',
      runId: 'run-1',
      tenantId: 'tenant-1',
      promptCharCount: 'Hello'.length,
      systemPromptCharCount: 'be brief'.length,
      status: 'completed',
      usage: {
        promptTokens: 8,
        completionTokens: 3,
        totalTokens: 11,
      },
    })
  })

  it('run() omits usage when JSON response has no usage block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
        text: () => Promise.resolve(''),
        body: null,
        headers: new Headers(),
      }),
    )

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const result = await adapter.run('Hello')
    expect(result.content).toBe('ok')
    expect(result.usage).toBeUndefined()
  })

  it('run() emits failed audit records and preserves thrown errors', async () => {
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const adapter = new OpenAIAdapter({ apiKey: 'k', auditSink, model: 'gpt-4o' })
    await expect(adapter.run('Hello')).rejects.toThrow('network down')

    expect(auditSink).toHaveBeenCalledTimes(1)
    expect(auditSink.mock.calls[0]![0]).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4o',
      promptCharCount: 'Hello'.length,
      status: 'failed',
      errorCode: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('run() swallows audit sink errors so audit failures do not break calls', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auditSink = vi.fn<(record: LlmInvocationRecord) => void>(() => {
      throw new Error('sink down')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
        text: () => Promise.resolve(''),
        body: null,
        headers: new Headers(),
      }),
    )

    const adapter = new OpenAIAdapter({ apiKey: 'k', auditSink })
    const result = await adapter.run('Hello')

    expect(result.content).toBe('ok')
    expect(auditSink).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[OpenAIAdapter] audit sink failed:', 'sink down')
  })
})
