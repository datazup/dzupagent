import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  buildStructuredOutputExhaustedError,
  describeStructuredOutputSchema,
} from '@dzupagent/core'

import {
  DzupAgent,
  generateStructuredOutput,
} from '../../../agent/src/index.js'
import type { StructuredLLMWithMeta } from '../../../agent/src/index.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import {
  JsonOutputSchema,
  StructuredOutputAdapter,
} from '../output/structured-output.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

function createMockModel(
  responses: AIMessage[],
): BaseChatModel & { invoke: ReturnType<typeof vi.fn> } {
  let invokeIdx = 0

  return {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      const response = responses[invokeIdx] ?? responses[responses.length - 1] ?? new AIMessage('done')
      invokeIdx++
      return response
    }),
  } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function createMockLLMSequence(
  responses: string[],
  modelName = 'gpt-4o-mini',
): StructuredLLMWithMeta & { invoke: ReturnType<typeof vi.fn> } {
  let callIndex = 0

  return {
    model: modelName,
    invoke: vi.fn(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1] ?? ''
      callIndex++
      return { content: response }
    }),
  }
}

function createFailingLLM(
  message: string,
  modelName = 'gpt-4o-mini',
): StructuredLLMWithMeta & { invoke: ReturnType<typeof vi.fn> } {
  return {
    model: modelName,
    invoke: vi.fn(async () => {
      throw new Error(message)
    }),
  }
}

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
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 5,
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

function createFailingAdapter(
  providerId: AdapterProviderId,
  message: string,
): AgentCLIAdapter {
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
        error: message,
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

async function captureError<T>(fn: () => Promise<T>): Promise<Error & Record<string, unknown>> {
  try {
    await fn()
  } catch (err) {
    return err as Error & Record<string, unknown>
  }

  throw new Error('Expected promise to reject')
}

describe('structured output parity', () => {
  const schema = z.object({
    answer: z.number(),
  })
  const schemaName = 'parity-agent.generation.qa.answer'
  const agentId = 'parity-agent'
  const intent = 'generation:qa-answer'

  it('keeps schema identity and retry counts aligned across the main success paths', async () => {
    const descriptor = describeStructuredOutputSchema(schema, {
      schemaName,
      provider: 'openai',
    })

    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(),
    }
    const dzupModel = createMockModel([
      new AIMessage('not valid json'),
      new AIMessage('{"answer": 42}'),
    ])
    const dzupAgent = new DzupAgent({
      id: agentId,
      instructions: 'Structured output parity test agent.',
      model: dzupModel,
      eventBus: eventBus as never,
    })

    const dzupResult = await dzupAgent.generateStructured(
      [new HumanMessage('what is the answer?')],
      schema,
      { intent, schemaName, schemaProvider: 'openai' },
    )

    const engineModel = createMockLLMSequence([
      'not valid json',
      '{"answer": 42}',
    ])
    const engineResult = await generateStructuredOutput(
      engineModel,
      [{ role: 'user', content: 'what is the answer?' }],
      {
        schema,
        strategy: 'generic-parse',
        maxRetries: 2,
        schemaName,
        agentId,
        intent,
        schemaProvider: 'openai',
      },
    )

    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', ['not valid json', '{"answer": 42}']))
    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const adapterResult = await adapter.execute(
      { prompt: 'what is the answer?' },
      JsonOutputSchema.fromZod(schema, {
        schemaName,
        agentId,
        intent,
        provider: 'openai',
      }),
    )

    expect(dzupResult.data).toEqual({ answer: 42 })
    expect(engineResult.data).toEqual({ answer: 42 })
    expect(adapterResult.result.value).toEqual({ answer: 42 })

    const preparedEvent = eventBus.emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'agent:structured_schema_prepared')

    expect(preparedEvent).toMatchObject({
      schemaName,
      schemaHash: descriptor.schemaHash,
      provider: 'openai',
    })
    expect(engineResult.schemaName).toBe(schemaName)
    expect(engineResult.schemaHash).toBe(descriptor.schemaHash)
    expect(adapterResult.result.schemaName).toBe(schemaName)
    expect(adapterResult.result.schemaHash).toBe(descriptor.schemaHash)

    const normalizedDzupRetries = dzupResult.usage.llmCalls - 1
    const normalizedAdapterRetries = adapterResult.result.parseAttempts - 1
    expect(normalizedDzupRetries).toBe(1)
    expect(engineResult.retries).toBe(1)
    expect(normalizedAdapterRetries).toBe(1)
    expect(adapterResult.fallbackUsed).toBe(false)
  })

  it('keeps envelope handling and schema diagnostics aligned for top-level array schemas', async () => {
    const arraySchema = z.array(z.object({ id: z.string() }))
    const envelopeSchemaName = 'parity-agent.generation.requirement.extraction.envelope'
    const requestDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.object({ id: z.string() })),
    }), {
      schemaName: envelopeSchemaName,
      provider: 'openai',
    })
    const responseDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.object({ id: z.string() })),
    }), {
      schemaName: `${envelopeSchemaName}.response`,
      provider: 'generic',
    })

    const dzupAgent = new DzupAgent({
      id: agentId,
      instructions: 'Structured output parity test agent.',
      model: createMockModel([new AIMessage('{"result":[{"id":"REQ-1"},{"id":"REQ-2"}]}')]),
    })
    const dzupResult = await dzupAgent.generateStructured(
      [new HumanMessage('extract requirements')],
      arraySchema,
      { intent: 'generation:requirement-extraction', schemaProvider: 'openai' },
    )

    const engineResult = await generateStructuredOutput(
      createMockLLMSequence(['{"result":[{"id":"REQ-1"},{"id":"REQ-2"}]}']),
      [{ role: 'user', content: 'extract requirements' }],
      {
        schema: arraySchema,
        strategy: 'generic-parse',
        maxRetries: 0,
        agentId,
        intent: 'generation:requirement-extraction',
        schemaProvider: 'openai',
      },
    )

    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', ['{"result":[{"id":"REQ-1"},{"id":"REQ-2"}]}']))
    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 0 })
    const adapterResult = await adapter.execute(
      { prompt: 'extract requirements' },
      JsonOutputSchema.fromZod(arraySchema, {
        agentId,
        intent: 'generation:requirement-extraction',
        provider: 'openai',
      }),
    )

    expect(dzupResult.data).toEqual([{ id: 'REQ-1' }, { id: 'REQ-2' }])
    expect(engineResult.data).toEqual([{ id: 'REQ-1' }, { id: 'REQ-2' }])
    expect(adapterResult.result.value).toEqual([{ id: 'REQ-1' }, { id: 'REQ-2' }])
    expect(engineResult.schemaName).toBe(envelopeSchemaName)
    expect(adapterResult.result.schemaName).toBe(envelopeSchemaName)
    expect(adapterResult.result.structuredOutput).toMatchObject({
      requiresEnvelope: true,
      requestSchema: { hash: requestDescriptor.schemaHash },
      responseSchema: { hash: responseDescriptor.schemaHash },
    })
  })

  it('keeps exhaustion messages and schema diagnostics aligned across the main failure paths', async () => {
    const descriptor = describeStructuredOutputSchema(schema, {
      schemaName,
      provider: 'openai',
    })
    const expectedMessage = buildStructuredOutputExhaustedError({
      schemaName,
      schemaHash: descriptor.schemaHash,
    }, 3)

    const dzupModel = createMockModel([
      new AIMessage('not valid json'),
      new AIMessage('still not valid'),
      new AIMessage('definitely not valid'),
    ])
    const dzupAgent = new DzupAgent({
      id: agentId,
      instructions: 'Structured output parity test agent.',
      model: dzupModel,
    })
    const dzupError = await captureError(() => dzupAgent.generateStructured(
      [new HumanMessage('what is the answer?')],
      schema,
      { intent, schemaName, schemaProvider: 'openai' },
    ))

    const engineModel = createMockLLMSequence([
      'not valid json',
      'still not valid',
      'definitely not valid',
    ])
    const engineError = await captureError(() => generateStructuredOutput(
      engineModel,
      [{ role: 'user', content: 'what is the answer?' }],
      {
        schema,
        strategy: 'generic-parse',
        maxRetries: 2,
        schemaName,
        agentId,
        intent,
        schemaProvider: 'openai',
      },
    ))

    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', [
      'not valid json',
      'still not valid',
      'definitely not valid',
    ]))
    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 2 })
    const adapterResult = await adapter.execute(
      { prompt: 'what is the answer?' },
      JsonOutputSchema.fromZod(schema, {
        schemaName,
        agentId,
        intent,
        provider: 'openai',
      }),
    )

    expect(dzupError.message).toBe(expectedMessage)
    expect(engineError.message).toBe(expectedMessage)
    expect(adapterResult.result.error).toBe(expectedMessage)

    expect(dzupError['schemaName']).toBe(schemaName)
    expect(dzupError['schemaHash']).toBe(descriptor.schemaHash)
    expect(dzupError['provider']).toBe('openai')
    expect(engineError['schemaName']).toBe(schemaName)
    expect(engineError['schemaHash']).toBe(descriptor.schemaHash)
    expect(engineError['provider']).toBe('openai')
    expect(adapterResult.result.schemaName).toBe(schemaName)
    expect(adapterResult.result.schemaHash).toBe(descriptor.schemaHash)
    expect(adapterResult.result.parseAttempts).toBe(3)
    expect(dzupError['failureCategory']).toBe('parse_exhausted')
    expect(engineError['failureCategory']).toBe('parse_exhausted')
    expect(adapterResult.result.failureCategory).toBe('parse_exhausted')

    expect(dzupModel.invoke).toHaveBeenCalledTimes(3)
    expect(engineModel.invoke).toHaveBeenCalledTimes(3)
  })

  it('exposes request and response schema refs on adapter failures the same way the throwing runtimes do', async () => {
    const arraySchema = z.array(z.string().min(2))
    const envelopeSchemaName = 'parity-agent.generation.requirement.extraction.envelope'
    const requestDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.string()),
    }), {
      schemaName: envelopeSchemaName,
      provider: 'openai',
    })
    const responseDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.string().min(2)),
    }), {
      schemaName: `${envelopeSchemaName}.response`,
      provider: 'generic',
    })

    const dzupAgent = new DzupAgent({
      id: agentId,
      instructions: 'Structured output parity test agent.',
      model: createMockModel([new AIMessage('not valid json')]),
    })
    const dzupError = await captureError(() => dzupAgent.generateStructured(
      [new HumanMessage('extract requirements')],
      arraySchema,
      {
        intent: 'generation:requirement-extraction',
        schemaProvider: 'openai',
      },
    ))

    const engineError = await captureError(() => generateStructuredOutput(
      createMockLLMSequence(['not valid json']),
      [{ role: 'user', content: 'extract requirements' }],
      {
        schema: arraySchema,
        strategy: 'generic-parse',
        maxRetries: 0,
        agentId,
        intent: 'generation:requirement-extraction',
        schemaProvider: 'openai',
      },
    ))

    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', ['not valid json']))
    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 0 })
    const adapterResult = await adapter.execute(
      { prompt: 'extract requirements' },
      JsonOutputSchema.fromZod(arraySchema, {
        agentId,
        intent: 'generation:requirement-extraction',
        provider: 'openai',
      }),
    )

    expect(dzupError['structuredOutput']).toMatchObject({
      requiresEnvelope: true,
      requestSchema: { hash: requestDescriptor.schemaHash },
      responseSchema: { hash: responseDescriptor.schemaHash },
    })
    expect(engineError['structuredOutput']).toMatchObject({
      failureCategory: 'parse_exhausted',
      requiresEnvelope: true,
      requestSchema: { hash: requestDescriptor.schemaHash },
      responseSchema: { hash: responseDescriptor.schemaHash },
    })
    expect(adapterResult.result.structuredOutput).toMatchObject({
      failureCategory: 'parse_exhausted',
      requiresEnvelope: true,
      requestSchema: { hash: requestDescriptor.schemaHash },
      responseSchema: { hash: responseDescriptor.schemaHash },
    })
  })

  it('keeps provider execution failure categories aligned across the main runtime boundaries', async () => {
    const errorMessage = 'provider timeout'
    const dzupModel = {
      invoke: vi.fn(async () => {
        throw new Error(errorMessage)
      }),
    } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
    const dzupAgent = new DzupAgent({
      id: agentId,
      instructions: 'Structured output parity test agent.',
      model: dzupModel,
    })
    const dzupError = await captureError(() => dzupAgent.generateStructured(
      [new HumanMessage('what is the answer?')],
      schema,
      { intent, schemaName, schemaProvider: 'openai' },
    ))

    const engineError = await captureError(() => generateStructuredOutput(
      createFailingLLM(errorMessage),
      [{ role: 'user', content: 'what is the answer?' }],
      {
        schema,
        strategy: 'generic-parse',
        maxRetries: 0,
        schemaName,
        agentId,
        intent,
        schemaProvider: 'openai',
      },
    ))

    const registry = new AdapterRegistry()
    registry.register(createFailingAdapter('claude', errorMessage))
    const adapter = new StructuredOutputAdapter(registry, { maxRetries: 0 })
    const adapterResult = await adapter.execute(
      { prompt: 'what is the answer?' },
      JsonOutputSchema.fromZod(schema, {
        schemaName,
        agentId,
        intent,
        provider: 'openai',
      }),
    )

    expect(dzupError.message).toBe(errorMessage)
    expect(engineError.message).toBe(errorMessage)
    expect(adapterResult.result.error).toContain(errorMessage)

    expect(dzupError['failureCategory']).toBe('provider_execution_failed')
    expect(engineError['failureCategory']).toBe('provider_execution_failed')
    expect(adapterResult.result.failureCategory).toBe('provider_execution_failed')
    expect(dzupError['structuredOutput']).toMatchObject({
      failureCategory: 'provider_execution_failed',
    })
    expect(engineError['structuredOutput']).toMatchObject({
      failureCategory: 'provider_execution_failed',
    })
    expect(adapterResult.result.structuredOutput).toMatchObject({
      failureCategory: 'provider_execution_failed',
    })
  })
})
