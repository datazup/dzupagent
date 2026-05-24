/**
 * Integration tests for OpenAI Chat Completions tool-calling support.
 *
 * Covers:
 *   - Capability flag (`supportsToolCalls: true`)
 *   - Mapping `AgentTool[]` → OpenAI `tools[]` request param
 *   - Accumulating `tool_calls` argument fragments across stream deltas
 *   - Emitting `adapter:tool_call` events on `finish_reason: 'tool_calls'`
 *   - Multi-tool fan-out within a single turn
 *   - Pre-wrapped wire-shape tool definitions
 *   - Flushing pending tool calls on stream end (no explicit finish_reason)
 *   - Tool-call argument JSON parsing (object + malformed fallback)
 *   - Mixed content + tool_calls in the same stream
 *   - Per-execution tool-call state isolation
 *   - `tool_choice` propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { OpenAIAdapter } from '../openai/openai-adapter.js'
import type { AgentEvent, AgentToolCallEvent } from '../types.js'
import { collectEvents } from './test-helpers.js'

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

function readBody(call: unknown): Record<string, unknown> {
  const [, opts] = call as [string, RequestInit]
  return JSON.parse(opts.body as string) as Record<string, unknown>
}

function toolCallEvents(events: AgentEvent[]): AgentToolCallEvent[] {
  return events.filter((e): e is AgentToolCallEvent => e.type === 'adapter:tool_call')
}

describe('OpenAIAdapter — tool calling', () => {
  const originalEnv = process.env['OPENAI_API_KEY']

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env['OPENAI_API_KEY'] = 'k'
  })

  afterEach(() => {
    if (originalEnv !== undefined) process.env['OPENAI_API_KEY'] = originalEnv
    else delete process.env['OPENAI_API_KEY']
  })

  it('declares supportsToolCalls=true in its capability profile', () => {
    const adapter = new OpenAIAdapter()
    expect(adapter.getCapabilities().supportsToolCalls).toBe(true)
  })

  it('maps flat AgentTool[] from input.options.tools to OpenAI tools wire shape', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await collectEvents(
      adapter.execute({
        prompt: 'Use the tool',
        options: {
          tools: [
            {
              name: 'get_weather',
              description: 'Get current weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        },
      }),
    )

    const body = readBody(fetchMock.mock.calls[0])
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ])
  })

  it('accepts pre-wrapped {type:function,function:{...}} tool entries unchanged', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await collectEvents(
      adapter.execute({
        prompt: 'p',
        options: {
          tools: [
            {
              type: 'function',
              function: {
                name: 'lookup',
                description: 'lookup something',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        },
      }),
    )

    const body = readBody(fetchMock.mock.calls[0])
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'lookup something',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
  })

  it('omits the tools field entirely when no tools are configured', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await collectEvents(adapter.execute({ prompt: 'hi' }))

    const body = readBody(fetchMock.mock.calls[0])
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it('forwards tool_choice from input options when provided', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"x"}}]}', 'data: [DONE]']
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    await collectEvents(
      adapter.execute({
        prompt: 'p',
        options: {
          tools: [{ name: 't', parameters: {} }],
          tool_choice: { type: 'function', function: { name: 't' } },
        },
      }),
    )

    const body = readBody(fetchMock.mock.calls[0])
    expect(body['tool_choice']).toEqual({ type: 'function', function: { name: 't' } })
  })

  it('accumulates tool_call argument fragments across deltas and emits a single adapter:tool_call', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":7}}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'weather please',
        options: { tools: [{ name: 'get_weather', parameters: {} }] },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.toolName).toBe('get_weather')
    expect(toolCalls[0]!.toolCallId).toBe('call_1')
    expect(toolCalls[0]!.input).toEqual({ city: 'Paris' })

    // adapter:tool_call must precede adapter:completed in the event stream.
    const types = events.map((e) => e.type)
    expect(types.indexOf('adapter:tool_call')).toBeLessThan(types.indexOf('adapter:completed'))
  })

  it('emits one adapter:tool_call per index for parallel multi-tool calls', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"alpha","arguments":"{\\"x\\":1}"}},{"index":1,"id":"b","type":"function","function":{"name":"beta","arguments":"{\\"y\\":2}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'do both',
        options: {
          tools: [
            { name: 'alpha', parameters: {} },
            { name: 'beta', parameters: {} },
          ],
        },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls.map((t) => t.toolName)).toEqual(['alpha', 'beta'])
    expect(toolCalls[0]!.input).toEqual({ x: 1 })
    expect(toolCalls[1]!.input).toEqual({ y: 2 })
  })

  it('flushes pending tool calls on stream end when finish_reason is not provided', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"cats\\"}"}}]}}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'search',
        options: { tools: [{ name: 'search', parameters: {} }] },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.toolName).toBe('search')
    expect(toolCalls[0]!.input).toEqual({ q: 'cats' })
  })

  it('falls back to the raw argument string when accumulated JSON is malformed', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"buggy","arguments":"not-json"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'go',
        options: { tools: [{ name: 'buggy', parameters: {} }] },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls).toHaveLength(1)
    expect(Object.hasOwn(toolCalls[0]!, 'toolCallId')).toBe(false)
    expect(toolCalls[0]!.input).toBe('not-json')
  })

  it('preserves provider toolCallId when present and does not fabricate IDs when absent', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"legacy_no_id","arguments":"{}"}},{"index":1,"id":"call_with_id","type":"function","function":{"name":"identified","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'mix ids',
        options: {
          tools: [
            { name: 'legacy_no_id', parameters: {} },
            { name: 'identified', parameters: {} },
          ],
        },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0]!.toolName).toBe('legacy_no_id')
    expect(Object.hasOwn(toolCalls[0]!, 'toolCallId')).toBe(false)
    expect(toolCalls[1]!.toolName).toBe('identified')
    expect(toolCalls[1]!.toolCallId).toBe('call_with_id')
  })

  it('emits both stream_delta and tool_call when content + tool_calls interleave', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"thinking..."}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","type":"function","function":{"name":"calc","arguments":"{\\"a\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'mix',
        options: { tools: [{ name: 'calc', parameters: {} }] },
      }),
    )

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:tool_call',
      'adapter:completed',
    ])
  })

  it('propagates correlationId onto emitted adapter:tool_call events', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"ping","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse(createSSEStream(sseLines))))

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events = await collectEvents(
      adapter.execute({
        prompt: 'ping',
        correlationId: 'corr-42',
        options: { tools: [{ name: 'ping', parameters: {} }] },
      }),
    )

    const toolCalls = toolCallEvents(events)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.correlationId).toBe('corr-42')
  })

  it('isolates pending tool-call state across consecutive execute() calls', async () => {
    const firstStream = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"r1","type":"function","function":{"name":"first","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    const secondStream = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"r2","type":"function","function":{"name":"second","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchResponse(createSSEStream(firstStream)))
      .mockResolvedValueOnce(mockFetchResponse(createSSEStream(secondStream)))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAIAdapter({ apiKey: 'k' })
    const events1 = await collectEvents(
      adapter.execute({ prompt: 'a', options: { tools: [{ name: 'first', parameters: {} }] } }),
    )
    const events2 = await collectEvents(
      adapter.execute({ prompt: 'b', options: { tools: [{ name: 'second', parameters: {} }] } }),
    )

    expect(toolCallEvents(events1).map((t) => t.toolName)).toEqual(['first'])
    expect(toolCallEvents(events2).map((t) => t.toolName)).toEqual(['second'])
  })
})
