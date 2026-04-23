import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  describeStructuredOutputSchema,
} from '@dzupagent/core'
import {
  generateStructured,
  detectStrategy,
  resolveStructuredOutputCapabilities,
} from '../structured/structured-output-engine.js'
import type {
  StructuredOutputCapabilities,
  StructuredLLM,
  StructuredLLMWithMeta,
} from '../structured/structured-output-engine.js'

/** Create a mock LLM that returns a fixed response. */
function mockLLM(response: string, modelName?: string): StructuredLLMWithMeta {
  return {
    model: modelName,
    invoke: async () => ({ content: response }),
  }
}

/** Create a mock LLM that returns different responses on successive calls. */
function mockLLMSequence(responses: string[], modelName?: string): StructuredLLMWithMeta {
  let callIndex = 0
  return {
    model: modelName,
    invoke: vi.fn(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++
      return { content: response }
    }),
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

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
})

describe('detectStrategy', () => {
  it('detects anthropic-tool-use for Claude models', () => {
    expect(detectStrategy({ model: 'claude-3-sonnet', invoke: async () => ({ content: '' }) }))
      .toBe('anthropic-tool-use')
  })

  it('detects anthropic-tool-use for anthropic models', () => {
    expect(detectStrategy({ model: 'anthropic/claude-3', invoke: async () => ({ content: '' }) }))
      .toBe('anthropic-tool-use')
  })

  it('detects openai-json-schema for GPT models', () => {
    expect(detectStrategy({ model: 'gpt-4o', invoke: async () => ({ content: '' }) }))
      .toBe('openai-json-schema')
  })

  it('detects openai-json-schema for openai models', () => {
    expect(detectStrategy({ model: 'openai/gpt-4', invoke: async () => ({ content: '' }) }))
      .toBe('openai-json-schema')
  })

  it('defaults to generic-parse for unknown models', () => {
    expect(detectStrategy({ model: 'llama-3', invoke: async () => ({ content: '' }) }))
      .toBe('generic-parse')
  })

  it('defaults to generic-parse when no model name', () => {
    expect(detectStrategy({ invoke: async () => ({ content: '' }) }))
      .toBe('generic-parse')
  })

  it.each([
    ['claude-3-sonnet', 'anthropic-tool-use'],
    ['anthropic/claude-3-opus', 'anthropic-tool-use'],
    ['gpt-4o-mini', 'openai-json-schema'],
    ['openai/gpt-4o-mini', 'openai-json-schema'],
    ['gemini-2.5-pro', 'generic-parse'],
    ['google/gemini-2.5-pro', 'generic-parse'],
    ['openrouter/meta-llama/llama-3.1-70b-instruct', 'generic-parse'],
  ] as const)('matches provider-matrix heuristic for %s', (model, expected) => {
    expect(detectStrategy({ model, invoke: async () => ({ content: '' }) }))
      .toBe(expected)
  })
})

describe('resolveStructuredOutputCapabilities', () => {
  it('prefers explicit config capabilities over model-name heuristics', () => {
    const llm: StructuredLLMWithMeta = {
      model: 'gpt-4o-mini',
      invoke: async () => ({ content: '' }),
    }

    const capabilities = resolveStructuredOutputCapabilities(llm, {
      capabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    })

    expect(capabilities).toEqual({
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    })
  })

  it('uses model metadata capabilities before falling back to heuristics', () => {
    const llm: StructuredLLMWithMeta = {
      model: 'gpt-4o-mini',
      structuredOutputCapabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
      },
      invoke: async () => ({ content: '' }),
    }

    expect(resolveStructuredOutputCapabilities(llm)).toEqual({
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
    })
  })

  it('falls back to heuristic detection when explicit capability metadata is absent', () => {
    const llm: StructuredLLMWithMeta = {
      model: 'claude-3-sonnet',
      invoke: async () => ({ content: '' }),
    }

    expect(resolveStructuredOutputCapabilities(llm)).toEqual({
      preferredStrategy: 'anthropic-tool-use',
      schemaProvider: 'generic',
    })
  })
})

describe('generateStructured', () => {
  it('parses valid JSON output correctly', async () => {
    const llm = mockLLM('{"name": "Alice", "age": 30}')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.strategy).toBe('generic-parse')
    expect(result.retries).toBe(0)
    expect(result.raw).toBe('{"name": "Alice", "age": 30}')
    expect(result.schemaName).toBe('agent.structured.output')
    expect(result.schemaHash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('parses JSON from code blocks', async () => {
    const llm = mockLLM('```json\n{"name": "Bob", "age": 25}\n```')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(result.data).toEqual({ name: 'Bob', age: 25 })
  })

  it('retries on validation failure', async () => {
    const llm = mockLLMSequence([
      '{"name": "Alice"}',               // Missing age
      '{"name": "Alice", "age": 30}',    // Valid
    ])

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
      maxRetries: 2,
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.retries).toBe(1)
  })

  it('falls back through strategy chain', async () => {
    // First strategy (anthropic-tool-use) returns invalid JSON
    // generic-parse also gets invalid
    // fallback-prompt succeeds
    let callCount = 0
    const llm: StructuredLLMWithMeta = {
      model: 'claude-test',
      invoke: async () => {
        callCount++
        // First 3 calls fail (anthropic strategy: 1 initial + 2 retries)
        // Next 3 calls fail (generic strategy: 1 initial + 2 retries)
        // 7th call succeeds (fallback-prompt)
        if (callCount >= 7) {
          return { content: '{"name": "Charlie", "age": 40}' }
        }
        return { content: 'not json at all' }
      },
    }

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      maxRetries: 2,
    })

    expect(result.data).toEqual({ name: 'Charlie', age: 40 })
    expect(result.strategy).toBe('fallback-prompt')
  })

  it('throws when max retries exceeded on all strategies', async () => {
    const llm = mockLLM('not json', 'unknown-model')

    await expect(
      generateStructured(llm, [], {
        schema: PersonSchema,
        maxRetries: 1,
      }),
    ).rejects.toThrow('Failed to parse output matching schema')
  })

  it('uses specified strategy when provided', async () => {
    const llm = mockLLM('{"name": "Dana", "age": 28}')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'fallback-prompt',
    })

    expect(result.strategy).toBe('fallback-prompt')
    expect(result.data).toEqual({ name: 'Dana', age: 28 })
  })

  it('passes messages to the LLM', async () => {
    const receivedMessages: unknown[][] = []
    const llm: StructuredLLM = {
      invoke: async (msgs) => {
        receivedMessages.push(msgs)
        return { content: '{"name": "Eve", "age": 22}' }
      },
    }

    await generateStructured(llm, [{ role: 'user', content: 'hi' }], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(receivedMessages.length).toBe(1)
    expect(receivedMessages[0]).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('derives a stable schema name from agentId and intent when not explicitly provided', async () => {
    const llm = mockLLM('{"name": "Eve", "age": 22}')

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
      agentId: 'planning-agent',
      intent: 'planning:decompose-goal',
    })

    expect(result.schemaName).toBe('planning-agent.planning.decompose.goal')
    expect(result.schemaHash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('includes schema metadata in failure messages after all strategies are exhausted', async () => {
    const llm = mockLLM('not json', 'gpt-4o-mini')

    await expect(
      generateStructured(llm, [], {
        schema: PersonSchema,
        maxRetries: 0,
        schemaName: 'DecompositionPlan',
      }),
    ).rejects.toThrow(/DecompositionPlan/)
  })

  it('uses explicit capability metadata instead of model-name heuristics when strategy is omitted', async () => {
    const llm: StructuredLLMWithMeta = {
      model: 'gpt-4o-mini',
      structuredOutputCapabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
      },
      invoke: async () => ({ content: '{"name":"Casey","age":27}' }),
    }

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      agentId: 'capability-agent',
      intent: 'planning:decompose-goal',
    })

    expect(result.strategy).toBe('generic-parse')
  })

  it('uses capability-defined fallback order when strategy is omitted', async () => {
    const llm = mockLLMSequence([
      'not json',
      '{"name":"Fallback","age":33}',
    ], 'gpt-4o-mini') as StructuredLLMWithMeta & { invoke: ReturnType<typeof vi.fn> }

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      maxRetries: 0,
      capabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    })

    expect(result.strategy).toBe('fallback-prompt')
    expect(llm.invoke).toHaveBeenCalledTimes(2)
  })

  it('auto-wraps top-level array schemas and returns the unwrapped result', async () => {
    const llm = mockLLM('{"result":[{"id":"REQ-1"},{"id":"REQ-2"}]}')

    const result = await generateStructured(llm, [{ role: 'user', content: 'extract requirements' }], {
      schema: z.array(z.object({ id: z.string() })),
      strategy: 'generic-parse',
      agentId: 'scanner-agent',
      intent: 'generation:requirement-extraction',
    })

    expect(result.data).toEqual([{ id: 'REQ-1' }, { id: 'REQ-2' }])
    expect(result.schemaName).toBe('scanner-agent.generation.requirement.extraction.envelope')
  })

  it('adds the envelope instruction for non-object schemas before generic parsing', async () => {
    const receivedMessages: unknown[][] = []
    const llm: StructuredLLM = {
      invoke: async (messages) => {
        receivedMessages.push(messages)
        return { content: '{"result":["REQ-1"]}' }
      },
    }

    await generateStructured(llm, [{ role: 'user', content: 'extract requirements' }], {
      schema: z.array(z.string()),
      strategy: 'generic-parse',
    })

    expect(receivedMessages[0]).toEqual([
      { role: 'user', content: 'extract requirements' },
      {
        role: 'system',
        content: 'Return the final JSON payload inside the top-level "result" property.',
      },
    ])
  })

  it.each([
    {
      label: 'OpenAI',
      model: 'gpt-4o-mini',
      config: {
        strategy: 'openai-json-schema' as const,
      },
      expectedProvider: 'openai',
      expectedSchemaProvider: 'openai' as const,
    },
    {
      label: 'Anthropic',
      model: 'claude-3-sonnet',
      config: {
        strategy: 'anthropic-tool-use' as const,
      },
      expectedProvider: 'generic',
      expectedSchemaProvider: 'generic' as const,
    },
    {
      label: 'Gemini OpenAI-compatible override',
      model: 'gemini-2.5-pro',
      config: {
        strategy: 'generic-parse' as const,
        schemaProvider: 'openai' as const,
      },
      expectedProvider: 'openai',
      expectedSchemaProvider: 'openai' as const,
    },
    {
      label: 'OpenRouter GPT-compatible',
      model: 'openai/gpt-4o-mini',
      config: {
        strategy: 'openai-json-schema' as const,
      },
      expectedProvider: 'openai',
      expectedSchemaProvider: 'openai' as const,
    },
  ])('keeps failure diagnostics aligned for $label', async ({
    model,
    config,
    expectedProvider,
    expectedSchemaProvider,
  }) => {
    const schemaName = 'provider-matrix.answer'
    const descriptor = describeStructuredOutputSchema(PersonSchema, {
      schemaName,
      provider: expectedSchemaProvider,
    })
    const llm = mockLLM('not json', model)

    const error = await captureError(() => generateStructured(llm, [], {
      schema: PersonSchema,
      maxRetries: 0,
      schemaName,
      ...config,
    }))

    expect(error.message).toBe(`Failed to parse output matching schema "${schemaName}" (${descriptor.schemaHash}) after 1 attempts`)
    expect(error['provider']).toBe(expectedProvider)
    expect(error['schemaName']).toBe(schemaName)
    expect(error['schemaHash']).toBe(descriptor.schemaHash)
    expect(error['failureCategory']).toBe('parse_exhausted')
    expect(error['structuredOutput']).toMatchObject({
      failureCategory: 'parse_exhausted',
    })
  })

  it('attaches envelope-aware request and response schema diagnostics for non-object failures', async () => {
    const schema = z.array(z.string().min(2))
    const requestDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.string()),
    }), {
      schemaName: 'scanner-agent.generation.requirement.extraction.envelope',
      provider: 'openai',
    })
    const responseDescriptor = describeStructuredOutputSchema(z.object({
      result: z.array(z.string().min(2)),
    }), {
      schemaName: 'scanner-agent.generation.requirement.extraction.envelope.response',
      provider: 'generic',
    })
    const llm = mockLLM('not json', 'gpt-4o-mini')

    const error = await captureError(() => generateStructured(llm, [{ role: 'user', content: 'extract requirements' }], {
      schema,
      maxRetries: 0,
      agentId: 'scanner-agent',
      intent: 'generation:requirement-extraction',
      schemaProvider: 'openai',
    }))

    expect(error['schemaName']).toBe(requestDescriptor.schemaName)
    expect(error['schemaHash']).toBe(requestDescriptor.schemaHash)
    expect(error['structuredOutput']).toMatchObject({
      failureCategory: 'parse_exhausted',
      requiresEnvelope: true,
      requestSchema: {
        hash: requestDescriptor.schemaHash,
      },
      responseSchema: {
        hash: responseDescriptor.schemaHash,
      },
    })
  })

  it('marks provider execution failures with an explicit structured-output failure category', async () => {
    const llm: StructuredLLM = {
      invoke: async () => {
        throw new Error('provider timeout')
      },
    }

    const error = await captureError(() => generateStructured(llm, [], {
      schema: PersonSchema,
      maxRetries: 0,
      schemaName: 'provider.failure.answer',
      schemaProvider: 'openai',
    }))

    expect(error.message).toBe('provider timeout')
    expect(error['failureCategory']).toBe('provider_execution_failed')
    expect(error['structuredOutput']).toMatchObject({
      failureCategory: 'provider_execution_failed',
    })
  })
})
