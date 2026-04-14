import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import {
  JsonOutputSchema,
  RegexOutputSchema,
  StructuredOutputAdapter,
} from '../output/structured-output.js'
import type { OutputSchema } from '../output/structured-output.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  responses: string[],
): AgentCLIAdapter {
  let callIndex = 0

  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      const result = responses[callIndex] ?? responses[responses.length - 1] ?? ''
      callIndex++
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}-${callIndex}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}-${callIndex}`,
        result,
        usage: { inputTokens: 50, outputTokens: 25 },
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      // not used
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createFailingAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:failed',
        providerId,
        error: 'Adapter failed',
        code: 'INTERNAL',
        timestamp: Date.now(),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

// ---------------------------------------------------------------------------
// JsonOutputSchema tests
// ---------------------------------------------------------------------------

describe('JsonOutputSchema', () => {
  const identityValidator = (data: unknown) => data as Record<string, unknown>
  let schema: JsonOutputSchema<Record<string, unknown>>

  beforeEach(() => {
    schema = new JsonOutputSchema('test-json', identityValidator)
  })

  it('parses valid JSON', () => {
    const result = schema.parse('{"key": "value", "num": 42}')

    expect(result).toEqual({ key: 'value', num: 42 })
  })

  it('extracts JSON from markdown code block', () => {
    const markdown = 'Here is the result:\n```json\n{"extracted": true}\n```\nDone.'

    const result = schema.parse(markdown)

    expect(result).toEqual({ extracted: true })
  })

  it('extracts JSON from bare code block', () => {
    const markdown = '```\n{"bare": true}\n```'

    const result = schema.parse(markdown)

    expect(result).toEqual({ bare: true })
  })

  it('rejects invalid JSON without code block', () => {
    expect(() => schema.parse('This is not JSON at all')).toThrow('not valid JSON')
  })

  it('rejects invalid JSON inside code block', () => {
    const markdown = '```json\n{invalid json}\n```'

    expect(() => schema.parse(markdown)).toThrow('not valid JSON')
  })

  it('uses custom validator to validate parsed data', () => {
    interface MyType {
      name: string
      age: number
    }

    const strictValidator = (data: unknown): MyType => {
      const obj = data as Record<string, unknown>
      if (typeof obj['name'] !== 'string' || typeof obj['age'] !== 'number') {
        throw new Error('Invalid MyType: requires name (string) and age (number)')
      }
      return { name: obj['name'] as string, age: obj['age'] as number }
    }

    const typedSchema = new JsonOutputSchema<MyType>('my-type', strictValidator)

    // Valid
    const valid = typedSchema.parse('{"name": "Alice", "age": 30}')
    expect(valid.name).toBe('Alice')

    // Invalid
    expect(() => typedSchema.parse('{"name": 123}')).toThrow('Invalid MyType')
  })

  it('describes the expected format', () => {
    const desc = schema.describe()
    expect(desc).toContain('JSON')
    expect(desc).toContain('no markdown')
  })
})

// ---------------------------------------------------------------------------
// RegexOutputSchema tests
// ---------------------------------------------------------------------------

describe('RegexOutputSchema', () => {
  it('matches pattern and returns match array', () => {
    const schema = new RegexOutputSchema('version', /v(\d+)\.(\d+)\.(\d+)/)

    const result = schema.parse('Release v1.2.3 is ready')

    expect(result[0]).toBe('v1.2.3')
    expect(result[1]).toBe('1')
    expect(result[2]).toBe('2')
    expect(result[3]).toBe('3')
  })

  it('rejects non-matching text', () => {
    const schema = new RegexOutputSchema('version', /v(\d+)\.(\d+)\.(\d+)/)

    expect(() => schema.parse('No version here')).toThrow('does not match pattern')
  })

  it('describes the expected format', () => {
    const schema = new RegexOutputSchema('test', /\d+/, 'A number')
    expect(schema.describe()).toBe('A number')
  })

  it('uses default description from pattern', () => {
    const schema = new RegexOutputSchema('test', /\d+/)
    expect(schema.describe()).toContain('\\d+')
  })
})

// ---------------------------------------------------------------------------
// StructuredOutputAdapter tests
// ---------------------------------------------------------------------------

describe('StructuredOutputAdapter', () => {
  let bus: DzupEventBus
  let registry: AdapterRegistry

  beforeEach(() => {
    bus = createEventBus()
    registry = new AdapterRegistry()
  })

  it('executes and returns parsed result on success', async () => {
    const adapter = createMockAdapter('claude', ['{"status": "ok"}'])
    registry.register(adapter)

    const soa = new StructuredOutputAdapter(registry, { eventBus: bus })
    const schema = new JsonOutputSchema('test', (d) => d as Record<string, unknown>)

    const result = await soa.execute(
      { prompt: 'Give me JSON' },
      schema,
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ status: 'ok' })
    expect(result.result.parseAttempts).toBe(1)
    expect(result.fallbackUsed).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('retries on parse failure then succeeds', async () => {
    // First response is bad, second is good
    const adapter = createMockAdapter('claude', [
      'Not valid JSON',
      '{"fixed": true}',
    ])
    registry.register(adapter)

    const soa = new StructuredOutputAdapter(registry, { eventBus: bus, maxRetries: 2 })
    const schema = new JsonOutputSchema('test', (d) => d as Record<string, unknown>)

    const result = await soa.execute(
      { prompt: 'Give me JSON' },
      schema,
    )

    expect(result.result.success).toBe(true)
    expect(result.result.value).toEqual({ fixed: true })
    expect(result.result.parseAttempts).toBe(2)
  })

  it('injects format instructions by default', async () => {
    let capturedPrompt = ''
    const mockAdapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
        capturedPrompt = input.prompt
        yield {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 'sess',
          timestamp: Date.now(),
        }
        yield {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 'sess',
          result: '{"ok": true}',
          usage: { inputTokens: 10, outputTokens: 5 },
          durationMs: 1,
          timestamp: Date.now(),
        }
      },
      async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }

    registry.register(mockAdapter)
    const schema = new JsonOutputSchema('fmt-test', (d) => d as Record<string, unknown>)
    const soa = new StructuredOutputAdapter(registry, { injectFormatInstructions: true })

    await soa.execute({ prompt: 'Original prompt' }, schema)

    expect(capturedPrompt).toContain('Original prompt')
    expect(capturedPrompt).toContain('IMPORTANT: Respond with')
  })

  it('does not inject format instructions when disabled', async () => {
    let capturedPrompt = ''
    const mockAdapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
        capturedPrompt = input.prompt
        yield {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 'sess',
          timestamp: Date.now(),
        }
        yield {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 'sess',
          result: '{"ok": true}',
          usage: { inputTokens: 10, outputTokens: 5 },
          durationMs: 1,
          timestamp: Date.now(),
        }
      },
      async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }

    registry.register(mockAdapter)
    const schema = new JsonOutputSchema('fmt-test', (d) => d as Record<string, unknown>)
    const soa = new StructuredOutputAdapter(registry, { injectFormatInstructions: false })

    await soa.execute({ prompt: 'Original prompt' }, schema)

    expect(capturedPrompt).toBe('Original prompt')
    expect(capturedPrompt).not.toContain('IMPORTANT')
  })

  it('returns failure after exhausting all retries and providers', async () => {
    // Always returns invalid output
    const adapter = createMockAdapter('claude', ['not json ever'])
    registry.register(adapter)

    const soa = new StructuredOutputAdapter(registry, { maxRetries: 1 })
    const schema = new JsonOutputSchema('strict', (d) => d as Record<string, unknown>)

    const result = await soa.execute({ prompt: 'Give me JSON' }, schema)

    expect(result.result.success).toBe(false)
    expect(result.result.error).toContain('Failed to parse')
    expect(result.result.parseAttempts).toBeGreaterThan(0)
  })

  describe('executeStreamed', () => {
    it('yields events including final parsed result', async () => {
      const adapter = createMockAdapter('claude', ['{"streamed": true}'])
      registry.register(adapter)

      const soa = new StructuredOutputAdapter(registry, { eventBus: bus })
      const schema = new JsonOutputSchema('stream-test', (d) => d as Record<string, unknown>)

      const events: AgentEvent[] = []
      for await (const event of soa.executeStreamed(
        { prompt: 'Stream it' },
        schema,
      )) {
        events.push(event)
      }

      const eventTypes = events.map((e) => e.type)
      expect(eventTypes).toContain('adapter:started')
      expect(eventTypes).toContain('adapter:completed')

      // The last completed event should have the parsed JSON
      const completedEvents = events.filter((e) => e.type === 'adapter:completed')
      expect(completedEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('yields failed event when all retries exhausted', async () => {
      const adapter = createMockAdapter('claude', ['not json'])
      registry.register(adapter)

      const soa = new StructuredOutputAdapter(registry, { maxRetries: 0 })
      const schema = new JsonOutputSchema('fail-stream', (d) => d as Record<string, unknown>)

      const events: AgentEvent[] = []
      for await (const event of soa.executeStreamed(
        { prompt: 'Stream it' },
        schema,
      )) {
        events.push(event)
      }

      const lastEvent = events[events.length - 1]!
      expect(lastEvent.type).toBe('adapter:failed')
    })
  })
})
