import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ForgeError } from '@dzupagent/core'
import { z } from 'zod'
import { collectEvents } from './test-helpers.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import {
  JsonOutputSchema,
  StructuredOutputAdapter,
} from '../output/structured-output.js'
import type { AgentEvent } from '../types.js'

// Mock the SDK module
const mockGenerateContentStream = vi.fn()
const mockGetGenerativeModel = vi.fn().mockReturnValue({
  generateContentStream: mockGenerateContentStream,
})
const MockGoogleGenerativeAI = vi.fn().mockReturnValue({
  getGenerativeModel: mockGetGenerativeModel,
})

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}))

// Import after mock setup
const { GeminiSDKAdapter } = await import('../gemini/gemini-sdk-adapter.js')

const TEST_API_KEY = 'test-api-key'

function createGeminiRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new GeminiSDKAdapter({
    model: 'gemini-2.5-pro',
    googleApiKey: TEST_API_KEY,
  }))
  return registry
}

function expectLatestGeminiSchema(expected: Record<string, unknown>): void {
  expect(mockGetGenerativeModel).toHaveBeenLastCalledWith(expect.objectContaining({
    model: 'gemini-2.5-pro',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: expected,
    },
  }))
}

describe('GeminiSDKAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGenerativeModel.mockReturnValue({
      generateContentStream: mockGenerateContentStream,
    })
  })

  it('execute yields started -> stream_delta -> completed events', async () => {
    const usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    }

    async function* streamChunks() {
      yield { text: () => 'Hello', functionCalls: () => undefined }
      yield { text: () => ' world', functionCalls: () => undefined }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({ usageMetadata }),
    })

    const adapter = new GeminiSDKAdapter({ model: 'gemini-2.5-pro', googleApiKey: TEST_API_KEY })
    const events = await collectEvents(adapter.execute({ prompt: 'test prompt' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:stream_delta',
      'adapter:completed',
    ])

    const started = events[0] as Extract<AgentEvent, { type: 'adapter:started' }>
    expect(started.providerId).toBe('gemini-sdk')
    expect(started.model).toBe('gemini-2.5-pro')
    expect(started.prompt).toBe('test prompt')
    expect(started.isResume).toBe(false)

    const delta1 = events[1] as Extract<AgentEvent, { type: 'adapter:stream_delta' }>
    expect(delta1.content).toBe('Hello')

    const delta2 = events[2] as Extract<AgentEvent, { type: 'adapter:stream_delta' }>
    expect(delta2.content).toBe(' world')

    const completed = events[3] as Extract<AgentEvent, { type: 'adapter:completed' }>
    expect(completed.result).toBe('Hello world')
    expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('yields tool_call events for function calls in chunks', async () => {
    async function* streamChunks() {
      yield {
        text: () => '',
        functionCalls: () => [{ name: 'search', args: { query: 'dzip' } }],
      }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const events = await collectEvents(adapter.execute({ prompt: 'search for dzip' }))

    const toolCall = events.find((e) => e.type === 'adapter:tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'adapter:tool_call') {
      expect(toolCall.toolName).toBe('search')
      expect(toolCall.input).toEqual({ query: 'dzip' })
    }
  })

  it('getCapabilities returns correct profile', () => {
    const adapter = new GeminiSDKAdapter({ maxContextTokens: 1_000_000, googleApiKey: TEST_API_KEY })
    const caps = adapter.getCapabilities()

    expect(caps).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      maxContextTokens: 1_000_000,
    })
  })

  it('getCapabilities uses default maxContextTokens when not configured', () => {
    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const caps = adapter.getCapabilities()
    expect(caps.maxContextTokens).toBe(2_000_000)
  })

  it('interrupt aborts current execution', async () => {
    let aborted = false

    async function* streamChunks() {
      yield { text: () => 'partial', functionCalls: () => undefined }
      // Simulate waiting - the abort should stop iteration
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5000)
      })
      yield { text: () => 'should not reach', functionCalls: () => undefined }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of streamChunks()) {
            yield chunk
          }
        },
      },
      response: Promise.resolve({}),
    })

    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const events: AgentEvent[] = []

    // Start collecting but interrupt after first delta
    const gen = adapter.execute({ prompt: 'test' })
    for await (const event of gen) {
      events.push(event)
      if (event.type === 'adapter:stream_delta') {
        adapter.interrupt()
        aborted = true
        break
      }
    }

    expect(aborted).toBe(true)
    expect(events.some((e) => e.type === 'adapter:started')).toBe(true)
    expect(events.some((e) => e.type === 'adapter:stream_delta')).toBe(true)
  })

  it('healthCheck returns healthy when SDK is available', async () => {
    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const status = await adapter.healthCheck()

    expect(status.healthy).toBe(true)
    expect(status.providerId).toBe('gemini-sdk')
    expect(status.sdkInstalled).toBe(true)
    expect(status.cliAvailable).toBe(false)
  })

  it('healthCheck returns unhealthy when SDK is missing', async () => {
    // Create adapter with fresh state and make loadSDK fail
    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    // Override internal sdk to force reload by clearing cached value
     
    ;(adapter as Record<string, unknown>)['sdk'] = undefined
    MockGoogleGenerativeAI.mockImplementationOnce(() => {
      throw new Error('Module not found')
    })

    const status = await adapter.healthCheck()

    expect(status.healthy).toBe(false)
    expect(status.sdkInstalled).toBe(false)
    expect(status.lastError).toBe('@google/generative-ai not installed')
  })

  it('configure merges config', () => {
    const adapter = new GeminiSDKAdapter({ model: 'gemini-2.5-pro', googleApiKey: TEST_API_KEY })
    adapter.configure({ model: 'gemini-2.5-flash', timeoutMs: 30000 })

    const caps = adapter.getCapabilities()
    // maxContextTokens should still use default since we didn't override it
    expect(caps.maxContextTokens).toBe(2_000_000)
  })

  it('resumeSession throws ForgeError', async () => {
    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })

    await expect(
      collectEvents(adapter.resumeSession('some-session-id', { prompt: 'test' })),
    ).rejects.toThrow(ForgeError)

    await expect(
      collectEvents(adapter.resumeSession('some-session-id', { prompt: 'test' })),
    ).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('emits adapter:failed when generateContentStream throws', async () => {
    mockGenerateContentStream.mockRejectedValue(new Error('API rate limit exceeded'))

    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])

    const failed = events[1] as Extract<AgentEvent, { type: 'adapter:failed' }>
    expect(failed.error).toBe('API rate limit exceeded')
    expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
  })

  it('emits completed with no usage when response has no usageMetadata', async () => {
    async function* streamChunks() {
      yield { text: () => 'ok', functionCalls: () => undefined }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const adapter = new GeminiSDKAdapter({ googleApiKey: TEST_API_KEY })
    const events = await collectEvents(adapter.execute({ prompt: 'test' }))

    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.usage).toBeUndefined()
    }
  })

  it('passes systemPrompt to getGenerativeModel', async () => {
    async function* streamChunks() {
      yield { text: () => 'hi', functionCalls: () => undefined }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const adapter = new GeminiSDKAdapter({ model: 'gemini-2.5-flash', googleApiKey: TEST_API_KEY })
    await collectEvents(
      adapter.execute({ prompt: 'hello', systemPrompt: 'You are a helpful assistant' }),
    )

    expect(mockGetGenerativeModel).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      systemInstruction: 'You are a helpful assistant',
    })
  })

  it('passes native Gemini responseSchema config when outputSchema is provided', async () => {
    async function* streamChunks() {
      yield { text: () => '{"answer":42}', functionCalls: () => undefined }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const outputSchema = {
      type: 'object',
      properties: {
        answer: { type: 'number' },
      },
      required: ['answer'],
      additionalProperties: false,
    }

    const adapter = new GeminiSDKAdapter({ model: 'gemini-2.5-pro', googleApiKey: TEST_API_KEY })
    await collectEvents(adapter.execute({ prompt: 'Return JSON.', outputSchema }))

    expect(mockGetGenerativeModel).toHaveBeenCalledWith({
      model: 'gemini-2.5-pro',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: outputSchema,
      },
    })
  })

  it('works with StructuredOutputAdapter on the Gemini SDK seam', async () => {
    async function* streamChunks() {
      yield {
        text: () => '```json\n{"answer": 42}\n```',
        functionCalls: () => undefined,
      }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const registry = new AdapterRegistry()
    registry.register(new GeminiSDKAdapter({
      model: 'gemini-2.5-pro',
      googleApiKey: TEST_API_KEY,
    }))

    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return the numeric answer as JSON.' },
      JsonOutputSchema.fromZod(
        z.object({ answer: z.number() }),
        {
          agentId: 'gemini-sdk-adapter',
          intent: 'generation:qa-answer',
        },
      ),
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ answer: 42 })
    expect(result.result.providerId).toBe('gemini-sdk')
    expect(result.result.schemaName).toBe('gemini-sdk-adapter.generation.qa.answer')
    expect(result.result.schemaHash).toMatch(/^[a-f0-9]{16}$/)
    expect(result.result.parseAttempts).toBe(1)
    expect(result.fallbackUsed).toBe(false)
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-2.5-pro',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          additionalProperties: false,
          properties: {
            answer: { type: 'number' },
          },
          required: ['answer'],
          type: 'object',
        },
      },
    }))
  })

  it('retries structured parsing on the Gemini SDK seam and succeeds on correction', async () => {
    async function* invalidChunks() {
      yield {
        text: () => 'not valid json',
        functionCalls: () => undefined,
      }
    }

    async function* correctedChunks() {
      yield {
        text: () => '{"answer": 7}',
        functionCalls: () => undefined,
      }
    }

    mockGenerateContentStream
      .mockResolvedValueOnce({
        stream: invalidChunks(),
        response: Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        stream: correctedChunks(),
        response: Promise.resolve({}),
      })

    const registry = new AdapterRegistry()
    registry.register(new GeminiSDKAdapter({
      model: 'gemini-2.5-pro',
      googleApiKey: TEST_API_KEY,
    }))

    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return the numeric answer as JSON.' },
      JsonOutputSchema.fromZod(
        z.object({ answer: z.number() }),
        {
          agentId: 'gemini-sdk-adapter',
          intent: 'generation:qa-answer',
        },
      ),
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ answer: 7 })
    expect(result.result.providerId).toBe('gemini-sdk')
    expect(result.result.parseAttempts).toBe(2)
    expect(result.fallbackUsed).toBe(false)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2)
    expect(mockGetGenerativeModel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      generationConfig: expect.objectContaining({
        responseMimeType: 'application/json',
      }),
    }))
    expect(mockGetGenerativeModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      generationConfig: expect.objectContaining({
        responseMimeType: 'application/json',
      }),
    }))
  })

  it.each([
    {
      label: 'envelope-backed top-level array',
      schema: z.object({
        result: z.array(z.object({
          id: z.string(),
          priority: z.enum(['HIGH', 'LOW']),
        })),
      }),
      response: '{"result":[{"id":"REQ-1","priority":"HIGH"}]}',
      expectedValue: {
        result: [{ id: 'REQ-1', priority: 'HIGH' }],
      },
      expectedSchema: {
        additionalProperties: false,
        properties: {
          result: {
            items: {
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                priority: {
                  enum: ['HIGH', 'LOW'],
                  type: 'string',
                },
              },
              required: ['id', 'priority'],
              type: 'object',
            },
            type: 'array',
          },
        },
        required: ['result'],
        type: 'object',
      },
    },
    {
      label: 'nested nullable objects',
      schema: z.object({
        metadata: z.object({
          notes: z.string().nullable(),
          items: z.array(z.object({
            id: z.string(),
            tags: z.array(z.string()),
          })),
        }),
      }),
      response: '{"metadata":{"notes":null,"items":[{"id":"item-1","tags":["a","b"]}]}}',
      expectedValue: {
        metadata: {
          notes: null,
          items: [{ id: 'item-1', tags: ['a', 'b'] }],
        },
      },
      expectedSchema: {
        additionalProperties: false,
        properties: {
          metadata: {
            additionalProperties: false,
            properties: {
              notes: {
                anyOf: [
                  { type: 'string' },
                  { type: 'null' },
                ],
              },
              items: {
                items: {
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    tags: {
                      items: { type: 'string' },
                      type: 'array',
                    },
                  },
                  required: ['id', 'tags'],
                  type: 'object',
                },
                type: 'array',
              },
            },
            required: ['notes', 'items'],
            type: 'object',
          },
        },
        required: ['metadata'],
        type: 'object',
      },
    },
    {
      label: 'enum-bearing object',
      schema: z.object({
        status: z.enum(['PASS', 'FAIL']),
        summary: z.string(),
      }),
      response: '{"status":"PASS","summary":"All checks passed"}',
      expectedValue: {
        status: 'PASS',
        summary: 'All checks passed',
      },
      expectedSchema: {
        additionalProperties: false,
        properties: {
          status: {
            enum: ['PASS', 'FAIL'],
            type: 'string',
          },
          summary: { type: 'string' },
        },
        required: ['status', 'summary'],
        type: 'object',
      },
    },
  ])('propagates native Gemini responseSchema for $label', async ({
    schema,
    response,
    expectedValue,
    expectedSchema,
  }) => {
    async function* streamChunks() {
      yield {
        text: () => response,
        functionCalls: () => undefined,
      }
    }

    mockGenerateContentStream.mockResolvedValue({
      stream: streamChunks(),
      response: Promise.resolve({}),
    })

    const adapter = new StructuredOutputAdapter(createGeminiRegistry(), { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return structured JSON.' },
      JsonOutputSchema.fromZod(schema, {
        agentId: 'gemini-sdk-adapter',
        intent: 'generation:edge-case',
      }),
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual(expectedValue)
    expect(result.result.providerId).toBe('gemini-sdk')
    expect(result.result.parseAttempts).toBe(1)
    expectLatestGeminiSchema(expectedSchema)
  })

  it('preserves native Gemini responseSchema across retry for envelope-backed arrays', async () => {
    async function* invalidChunks() {
      yield {
        text: () => '{"result":[{"id":"REQ-1","priority":"MAYBE"}]}',
        functionCalls: () => undefined,
      }
    }

    async function* correctedChunks() {
      yield {
        text: () => '{"result":[{"id":"REQ-1","priority":"HIGH"}]}',
        functionCalls: () => undefined,
      }
    }

    mockGenerateContentStream
      .mockResolvedValueOnce({
        stream: invalidChunks(),
        response: Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        stream: correctedChunks(),
        response: Promise.resolve({}),
      })

    const schema = z.object({
      result: z.array(z.object({
        id: z.string(),
        priority: z.enum(['HIGH', 'LOW']),
      })),
    })

    const adapter = new StructuredOutputAdapter(createGeminiRegistry(), { maxRetries: 2 })
    const result = await adapter.execute(
      { prompt: 'Return structured JSON.' },
      JsonOutputSchema.fromZod(schema, {
        agentId: 'gemini-sdk-adapter',
        intent: 'generation:edge-case',
      }),
    )

    const expectedSchema = {
      additionalProperties: false,
      properties: {
        result: {
          items: {
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              priority: {
                enum: ['HIGH', 'LOW'],
                type: 'string',
              },
            },
            required: ['id', 'priority'],
            type: 'object',
          },
          type: 'array',
        },
      },
      required: ['result'],
      type: 'object',
    }

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({
      result: [{ id: 'REQ-1', priority: 'HIGH' }],
    })
    expect(result.result.parseAttempts).toBe(2)
    expect(mockGetGenerativeModel).toHaveBeenCalledTimes(2)
    expect(mockGetGenerativeModel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: expectedSchema,
      },
    }))
    expect(mockGetGenerativeModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: expectedSchema,
      },
    }))
  })
})
